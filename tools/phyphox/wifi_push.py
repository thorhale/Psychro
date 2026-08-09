#!/usr/bin/env python3
"""Push WiFi signal strength into a running phyphox experiment.

phyphox has no WiFi input, but its remote interface can write to a buffer:

    /control?cmd=set&buffer=rssi&value=-67

so anything that can scan can feed it. This scans, picks the access point you
name, and writes RSSI, AP count and channel into the WiFi Walk Survey
experiment. You then just press Log waypoint as you walk.

    python3 wifi_push.py --host 192.168.0.14:8080 --bssid 1c:49:7b:66:ee:17
    python3 wifi_push.py --host 192.168.0.14:8080 --ssid CorpWiFi --source termux

CO-LOCATION MATTERS. RSSI is a property of the radio that measured it, not of
the room. If you are walking with the phone, the scan has to come from the phone
too - Termux with `termux-wifi-scaninfo`, or a Shizuku/adb shell running
`cmd wifi list-scan-results`. Running this on a laptop while you walk away with
the phone records the laptop's view of the network, which is not what you want.
A laptop source is only right when it sits next to the phone and neither moves.

Android throttles scans to about four per two minutes unless you turn it off:
Developer options > Wi-Fi scan throttling, or

    settings put global wifi_scan_throttle_enabled 0

Without that, no polling interval below ~30 s means anything.
"""
import argparse
import json
import re
import shutil
import subprocess
import sys
import time
import urllib.parse
import urllib.request

# Each source returns a list of {ssid, bssid, rssi, channel, freq}.
SOURCES = ("auto", "termux", "rish", "adb", "nmcli", "iw", "netsh", "airport")


def run(cmd):
    try:
        p = subprocess.run(cmd, shell=True, capture_output=True, text=True, timeout=30)
    except subprocess.TimeoutExpired:
        return ""
    return p.stdout


def freq_to_channel(mhz):
    if mhz is None:
        return None
    if 2412 <= mhz <= 2484:
        return 14 if mhz == 2484 else (mhz - 2407) // 5
    if 5000 < mhz < 5900:
        return (mhz - 5000) // 5
    if 5955 <= mhz <= 7115:
        return (mhz - 5950) // 5
    return None


def parse_termux(text):
    """termux-wifi-scaninfo emits a JSON array."""
    try:
        data = json.loads(text)
    except (ValueError, TypeError):
        return []
    out = []
    for e in data if isinstance(data, list) else []:
        freq = e.get("frequency_mhz") or e.get("frequency")
        out.append({
            "ssid": e.get("ssid", ""),
            "bssid": (e.get("bssid") or "").lower(),
            "rssi": e.get("rssi") if e.get("rssi") is not None else e.get("level"),
            "freq": freq,
            "channel": e.get("channel") or freq_to_channel(freq),
        })
    return [a for a in out if a["rssi"] is not None]


def parse_cmd_wifi(text):
    """`cmd wifi list-scan-results` - a fixed-width-ish table, one AP per line.

    BSSID              Frequency  RSSI  Age(sec)  SSID     Flags
    1c:49:7b:66:ee:17  5745       -69   1.2       CorpWiFi [WPA2-PSK-CCMP][ESS]
    """
    out = []
    for line in text.splitlines():
        m = re.match(
            r"\s*([0-9a-fA-F]{2}(?::[0-9a-fA-F]{2}){5})\s+(\d{3,5})\s+(-?\d{1,3})\s+\S+\s*(.*)",
            line,
        )
        if not m:
            continue
        bssid, freq, rssi, rest = m.groups()
        ssid = rest.split("[")[0].strip() if rest else ""
        freq = int(freq)
        out.append({"ssid": ssid, "bssid": bssid.lower(), "rssi": int(rssi),
                    "freq": freq, "channel": freq_to_channel(freq)})
    return out


def parse_nmcli(text):
    """nmcli -t -f BSSID,SSID,SIGNAL,FREQ,CHAN dev wifi - colon separated,
    with the MAC's own colons backslash-escaped."""
    out = []
    for line in text.splitlines():
        if not line.strip():
            continue
        parts = re.split(r"(?<!\\):", line)
        parts = [p.replace("\\:", ":") for p in parts]
        if len(parts) < 3:
            continue
        bssid, ssid, signal = parts[0], parts[1], parts[2]
        freq = None
        if len(parts) > 3:
            f = re.search(r"\d+", parts[3])
            freq = int(f.group()) if f else None
        try:
            pct = int(signal)
        except ValueError:
            continue
        # nmcli reports quality 0-100; the usual linear mapping back to dBm.
        rssi = pct / 2.0 - 100.0
        out.append({"ssid": ssid, "bssid": bssid.lower(), "rssi": rssi,
                    "freq": freq, "channel": freq_to_channel(freq)})
    return out


def parse_iw(text):
    """iw dev <if> scan - stanza per BSS."""
    out, cur = [], None
    for line in text.splitlines():
        m = re.match(r"BSS ([0-9a-fA-F:]{17})", line.strip())
        if m:
            if cur:
                out.append(cur)
            cur = {"ssid": "", "bssid": m.group(1).lower(), "rssi": None,
                   "freq": None, "channel": None}
            continue
        if cur is None:
            continue
        m = re.search(r"signal:\s*(-?\d+\.?\d*)\s*dBm", line)
        if m:
            cur["rssi"] = float(m.group(1))
        m = re.search(r"freq:\s*(\d+)", line)
        if m:
            cur["freq"] = int(m.group(1))
            cur["channel"] = freq_to_channel(cur["freq"])
        m = re.search(r"SSID:\s*(.*)", line)
        if m:
            cur["ssid"] = m.group(1).strip()
    if cur:
        out.append(cur)
    return [a for a in out if a["rssi"] is not None]


def parse_netsh(text):
    """netsh wlan show networks mode=bssid - Windows, signal as a percentage."""
    out, ssid = [], ""
    for line in text.splitlines():
        m = re.match(r"\s*SSID \d+\s*:\s*(.*)", line)
        if m:
            ssid = m.group(1).strip()
            continue
        m = re.match(r"\s*BSSID \d+\s*:\s*([0-9a-fA-F:]{17})", line)
        if m:
            out.append({"ssid": ssid, "bssid": m.group(1).lower(), "rssi": None,
                        "freq": None, "channel": None})
            continue
        m = re.match(r"\s*Signal\s*:\s*(\d+)%", line)
        if m and out:
            out[-1]["rssi"] = int(m.group(1)) / 2.0 - 100.0
        m = re.match(r"\s*Channel\s*:\s*(\d+)", line)
        if m and out:
            out[-1]["channel"] = int(m.group(1))
    return [a for a in out if a["rssi"] is not None]


PARSERS = {
    "termux": (parse_termux, "termux-wifi-scaninfo"),
    "rish": (parse_cmd_wifi, "rish -c 'cmd wifi list-scan-results'"),
    "adb": (parse_cmd_wifi, "adb shell cmd wifi list-scan-results"),
    "nmcli": (parse_nmcli, "nmcli -t -f BSSID,SSID,SIGNAL,FREQ dev wifi"),
    "iw": (parse_iw, "iw dev $(iw dev | awk '/Interface/{print $2; exit}') scan"),
    "netsh": (parse_netsh, "netsh wlan show networks mode=bssid"),
    "airport": (parse_iw, "/System/Library/PrivateFrameworks/Apple80211.framework/"
                          "Versions/Current/Resources/airport -s"),
}


def detect_source():
    for name, probe in (("termux", "termux-wifi-scaninfo"), ("rish", "rish"),
                        ("nmcli", "nmcli"), ("iw", "iw"), ("adb", "adb"), ("netsh", "netsh")):
        if shutil.which(probe):
            return name
    sys.exit("no scan source found; pass --source explicitly (see --help)")


def scan(source):
    parser, cmd = PARSERS[source]
    return parser(run(cmd))


def phyphox_set(host, buffer_name, value, timeout=4.0):
    url = f"http://{host}/control?" + urllib.parse.urlencode(
        {"cmd": "set", "buffer": buffer_name, "value": f"{value}"}
    )
    with urllib.request.urlopen(url, timeout=timeout) as r:
        body = r.read().decode("utf-8", "replace")
    try:
        return json.loads(body).get("result", False)
    except ValueError:
        return False


def main():
    p = argparse.ArgumentParser(description=__doc__,
                                formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--host", help="phyphox remote address, e.g. 192.168.0.14:8080")
    p.add_argument("--bssid", help="the access point to track (most precise)")
    p.add_argument("--ssid", help="track the strongest AP with this SSID")
    p.add_argument("--source", choices=SOURCES, default="auto")
    p.add_argument("--interval", type=float, default=2.0, help="seconds between scans")
    p.add_argument("--once", action="store_true")
    p.add_argument("--dry-run", action="store_true", help="scan and print, push nothing")
    p.add_argument("--simulate", metavar="FILE",
                   help="parse this file as if it were the scan command's output")
    args = p.parse_args()

    if not args.dry_run and not args.simulate and not args.host:
        sys.exit("--host is required unless --dry-run or --simulate is given")
    if not args.simulate and not args.bssid and not args.ssid:
        print("no --bssid or --ssid given: reporting the strongest AP visible", file=sys.stderr)

    source = detect_source() if args.source == "auto" and not args.simulate else args.source
    if args.simulate:
        if source == "auto":
            sys.exit("--simulate needs --source so the right parser is used")
        with open(args.simulate, encoding="utf-8") as fh:
            text = fh.read()
        aps = PARSERS[source][0](text)
        for a in aps:
            print(f"  {a['bssid']}  {str(a['rssi']):>7} dBm  ch {a['channel']}  {a['ssid']}")
        print(f"{len(aps)} access points parsed by the {source} parser")
        return

    print(f"scanning with the {source} source, pushing to {args.host or '(dry run)'}")
    while True:
        aps = scan(source)
        if not aps:
            print("scan returned nothing (throttled, or the source needs permissions)",
                  file=sys.stderr)
        else:
            if args.bssid:
                match = [a for a in aps if a["bssid"] == args.bssid.lower()]
            elif args.ssid:
                match = [a for a in aps if a["ssid"] == args.ssid]
            else:
                match = aps
            target = max(match, key=lambda a: a["rssi"]) if match else None
            if target is None:
                print("the requested access point was not in this scan", file=sys.stderr)
            else:
                line = (f"{target['rssi']:.0f} dBm  ch {target['channel']}  "
                        f"{target['ssid'] or target['bssid']}  ({len(aps)} APs visible)")
                if args.dry_run:
                    print(line)
                else:
                    ok = all([
                        phyphox_set(args.host, "rssi", round(target["rssi"])),
                        phyphox_set(args.host, "apCount", len(aps)),
                        phyphox_set(args.host, "channel", target["channel"] or 0),
                    ])
                    print(f"{line}  ->  {'pushed' if ok else 'REFUSED by phyphox'}")
                    if not ok:
                        print("  phyphox returned false: check the experiment is running, "
                              "that remote access is on, and that the buffer names exist",
                              file=sys.stderr)
        if args.once:
            return
        time.sleep(args.interval)


if __name__ == "__main__":
    main()
