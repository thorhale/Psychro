#!/usr/bin/env python3
"""Join a WiFiAnalyzer export to a phyphox WiFi Walk Survey export.

phyphox cannot read the WiFi radio, so a survey comes out of two apps. This
puts them back together on time: every access point WiFiAnalyzer saw is matched
to the waypoint you were standing on when it saw it.

    python3 wifi_merge.py waypoints.csv scan1.txt scan2.txt -o survey.csv

The timezone trap this is built around: phyphox writes Unix seconds (UTC),
WiFiAnalyzer writes a local wall-clock string with no offset on it. Getting that
wrong shifts every row by a whole number of hours and the result still looks
perfectly reasonable. So by default the offset is not assumed - it is measured,
by trying every whole-hour shift and keeping the one that lines the scans up
with the waypoints most tightly. The chosen offset is always reported.
"""
import argparse
import csv
import sys
from datetime import datetime, timezone

# WiFiAnalyzer exports pipe-delimited columns; we match on name, not position,
# because the column set has changed between releases.
AP_TIME = ("time stamp", "timestamp", "time")
AP_SSID = ("ssid",)
AP_BSSID = ("bssid",)
AP_LEVEL = ("strength", "level", "signal")
AP_CHANNEL = ("primary channel", "channel")
AP_FREQ = ("primary frequency", "frequency")
AP_DIST = ("distance",)
AP_SEC = ("security",)

TIME_FORMATS = (
    "%Y-%m-%d %H:%M:%S",
    "%Y-%m-%dT%H:%M:%S",
    "%Y/%m/%d %H:%M:%S",
    "%d/%m/%Y %H:%M:%S",
    "%Y-%m-%d %H:%M",
)


def find_col(headers, names):
    """Header index by case-insensitive containment, or -1."""
    low = [h.strip().lower() for h in headers]
    for i, h in enumerate(low):
        if h in names:
            return i
    for i, h in enumerate(low):
        if any(n in h for n in names):
            return i
    return -1


def parse_wall_clock(s):
    """A local wall-clock string to naive seconds. Returns None if unreadable."""
    s = s.strip().strip('"')
    if not s:
        return None
    for fmt in TIME_FORMATS:
        try:
            return datetime.strptime(s, fmt).replace(tzinfo=timezone.utc).timestamp()
        except ValueError:
            continue
    # Some builds export epoch milliseconds instead of a string.
    try:
        v = float(s)
    except ValueError:
        return None
    if v > 1e11:  # milliseconds
        return v / 1000.0
    if v > 1e8:  # seconds
        return v
    return None


def num(s):
    """A number out of a field that may carry units, or None."""
    if s is None:
        return None
    t = str(s).strip().strip('"')
    if not t:
        return None
    out = []
    for ch in t:
        if ch.isdigit() or ch in "+-.":
            out.append(ch)
        elif out:
            break
    try:
        return float("".join(out))
    except ValueError:
        return None


def read_waypoints(path):
    """phyphox export -> list of waypoint dicts, sorted by time."""
    with open(path, newline="", encoding="utf-8-sig") as fh:
        sample = fh.read()
    lines = [l for l in sample.splitlines() if l.strip()]
    if len(lines) < 2:
        sys.exit(f"{path}: needs a header row and at least one waypoint")
    delim = max(",;\t", key=lambda d: len(lines[0].split(d)))
    rows = list(csv.reader(lines, delimiter=delim))
    headers = rows[0]
    t_col = find_col(headers, ("timestamp (unix s)", "timestamp", "time"))
    n_col = find_col(headers, ("waypoint",))
    if t_col < 0:
        sys.exit(f"{path}: no timestamp column found in {headers}")
    out = []
    for r in rows[1:]:
        if len(r) <= t_col:
            continue
        t = num(r[t_col])
        if t is None or t < 1e8:
            continue
        wp = {"epoch": t, "waypoint": num(r[n_col]) if 0 <= n_col < len(r) else None}
        for i, h in enumerate(headers):
            if i in (t_col, n_col) or i >= len(r):
                continue
            wp[h.strip()] = r[i].strip()
        out.append(wp)
    if not out:
        sys.exit(f"{path}: no rows with a usable Unix timestamp")
    return sorted(out, key=lambda w: w["epoch"])


def read_scan(path):
    """One WiFiAnalyzer export -> list of AP dicts with naive timestamps."""
    with open(path, encoding="utf-8-sig") as fh:
        lines = [l for l in fh.read().splitlines() if l.strip()]
    if len(lines) < 2:
        return []
    delim = "|" if "|" in lines[0] else max(",;\t", key=lambda d: len(lines[0].split(d)))
    rows = [l.split(delim) for l in lines]
    headers = rows[0]
    cols = {
        "t": find_col(headers, AP_TIME),
        "ssid": find_col(headers, AP_SSID),
        "bssid": find_col(headers, AP_BSSID),
        "rssi": find_col(headers, AP_LEVEL),
        "channel": find_col(headers, AP_CHANNEL),
        "freq": find_col(headers, AP_FREQ),
        "distance": find_col(headers, AP_DIST),
        "security": find_col(headers, AP_SEC),
    }
    if cols["t"] < 0 or cols["bssid"] < 0 or cols["rssi"] < 0:
        sys.exit(
            f"{path}: need a time, a BSSID and a signal column; found {headers}. "
            "Export from WiFiAnalyzer with 'Export' on the Access Points screen."
        )
    out = []
    for r in rows[1:]:
        if len(r) <= cols["t"]:
            continue
        t = parse_wall_clock(r[cols["t"]])
        if t is None:
            continue
        get = lambda k: r[cols[k]].strip() if 0 <= cols[k] < len(r) else ""
        out.append(
            {
                "wall": t,
                "ssid": get("ssid"),
                "bssid": get("bssid"),
                "rssi": num(get("rssi")),
                "channel": num(get("channel")),
                "freq": num(get("freq")),
                "distance": num(get("distance")),
                "security": get("security"),
                "source": path.split("/")[-1],
            }
        )
    return out


def nearest(waypoints, t):
    """Waypoint closest in time to t, and the gap in seconds."""
    best, gap = None, None
    for w in waypoints:
        d = abs(w["epoch"] - t)
        if gap is None or d < gap:
            best, gap = w, d
    return best, gap


def pick_offset(waypoints, aps, forced=None):
    """The whole-hour shift that lines the scans up with the waypoints best."""
    if forced is not None:
        return forced * 3600.0, None
    # One representative time per scan file: matching every AP row would just
    # weight the answer by how many networks happened to be visible.
    stamps = sorted({a["wall"] for a in aps})
    best, best_cost = 0.0, None
    for hours in range(-14, 15):
        shift = hours * 3600.0
        costs = [nearest(waypoints, s + shift)[1] for s in stamps]
        cost = sorted(costs)[len(costs) // 2]  # median: one stray scan cannot swing it
        if best_cost is None or cost < best_cost:
            best, best_cost = shift, cost
    return best, best_cost


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("waypoints", help="phyphox 'Waypoints' CSV")
    p.add_argument("scans", nargs="+", help="one or more WiFiAnalyzer exports")
    p.add_argument("-o", "--out", default="survey.csv")
    p.add_argument("--tolerance", type=float, default=120.0,
                   help="drop APs further than this many seconds from any waypoint (default 120)")
    p.add_argument("--tz-hours", type=int, default=None,
                   help="force the shift in whole hours instead of measuring it")
    args = p.parse_args()

    waypoints = read_waypoints(args.waypoints)
    aps = []
    for s in args.scans:
        aps.extend(read_scan(s))
    if not aps:
        sys.exit("no access point rows read from the scan files")

    shift, cost = pick_offset(waypoints, aps, args.tz_hours)
    how = "forced" if args.tz_hours is not None else f"measured, median gap {cost:.1f} s"
    print(f"time shift applied to the scans: {shift/3600:+.0f} h ({how})")
    if cost is not None and cost > args.tolerance:
        print(
            f"WARNING: even at the best shift the scans sit {cost:.0f} s from the nearest\n"
            f"         waypoint, which is beyond the {args.tolerance:.0f} s tolerance. The two\n"
            f"         recordings may not be from the same walk, or a clock is wrong.",
            file=sys.stderr,
        )

    joined, dropped = [], 0
    for a in aps:
        wp, gap = nearest(waypoints, a["wall"] + shift)
        if gap is None or gap > args.tolerance:
            dropped += 1
            continue
        row = {
            "waypoint": wp["waypoint"],
            "waypoint_epoch": f"{wp['epoch']:.3f}",
            "gap_s": f"{gap:.1f}",
            "ssid": a["ssid"],
            "bssid": a["bssid"],
            "rssi_dbm": a["rssi"],
            "channel": a["channel"],
            "freq_mhz": a["freq"],
            "distance_m": a["distance"],
            "security": a["security"],
            "scan_file": a["source"],
        }
        for k, v in wp.items():
            if k not in ("epoch", "waypoint"):
                row[k] = v
        joined.append(row)

    if not joined:
        sys.exit("nothing matched: every access point was outside the tolerance")

    fields = list(joined[0].keys())
    with open(args.out, "w", newline="", encoding="utf-8") as fh:
        w = csv.DictWriter(fh, fieldnames=fields)
        w.writeheader()
        w.writerows(joined)

    matched_wp = len({r["waypoint_epoch"] for r in joined})
    print(f"{len(joined)} access point readings across {matched_wp} of {len(waypoints)} waypoints -> {args.out}")
    if dropped:
        print(f"{dropped} readings dropped: no waypoint within {args.tolerance:.0f} s")


if __name__ == "__main__":
    main()
