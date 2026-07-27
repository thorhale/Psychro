#!/usr/bin/env python3
"""Generate the CoolProp reference grid used as the accuracy oracle in CI.

CoolProp implements ASHRAE RP-1485 (Herrmann/Kretzschmar/Gatley 2009) — a real-gas
virial formulation with Henry's-law air solubility in the condensed phase. It is
the most accurate open-source humid-air model available, and far heavier than
anything we want to ship in an offline-first phone app. So we don't ship it: we
use it here, offline, to pin the accuracy of the hand-coded ASHRAE Fundamentals
Ch.1 core in `src/core/psychro.js`.

The output (`coolprop-reference.json`) is COMMITTED so CI stays hermetic and needs
neither Python nor a network. Regenerate by hand when the grid or property set
changes:

    pip install CoolProp
    python3 test/reference/generate_reference.py

Grid design
-----------
Two bands, distinguished by the `core` flag on each row:

  core=true   The operating domain the app is expected to be accurate in, and the
              band `src/core/domain.js` declares as validated. Tests assert tight
              per-property tolerances here.
  core=false  Deliberately outside it. Tests assert only that `checkDomain()`
              FLAGS these points — this band exists to prove the guard fires
              rather than the app silently extrapolating.

Units are SI-with-kPa to match the JS core: temperatures °C, pressures kPa,
humidity ratio kg/kg, enthalpy kJ/kg dry air, entropy kJ/(kg·K) dry air, specific
volume m³/kg dry air, density kg/m³, viscosity Pa·s, conductivity W/(m·K).
"""

import json
import os
import sys

try:
    from CoolProp.HumidAirProp import HAPropsSI
    import CoolProp
except ImportError:  # pragma: no cover - developer ergonomics only
    sys.exit("CoolProp is not installed. Run: pip install CoolProp")

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "coolprop-reference.json")

# Dry-bulb °C. Spans the chart's full range (32–130 °F = 0–54.4 °C) plus margin
# below freezing, where the app switches to the over-ice saturation equation.
TEMPS_C = [round(-20 + 2.5 * i, 3) for i in range(31)]          # -20 … 55
# Relative humidity %. 1 % rather than 0 so vapour pressure stays positive.
RH_PCT = [1] + [5 * i for i in range(1, 21)]                    # 1, 5 … 100
# Total pressure kPa. 101.325 = sea level; 79.5 ≈ 6,500 ft (Westminster campus is
# 5,380 ft); 22 and 108 probe the edges of what pressureFromAltitude() can emit.
PRESSURES_KPA = [22.0, 45.0, 65.0, 79.5, 85.0, 95.0, 101.325, 108.0]

# ── The declared core operating domain ──────────────────────────────────────
# Mirrors CORE_DOMAIN in src/core/domain.js. Keep the two in sync; the test suite
# asserts they agree so this comment cannot silently rot.
CORE_T_MIN, CORE_T_MAX = -20.0, 55.0
CORE_P_MIN, CORE_P_MAX = 60.0, 108.0
CORE_W_MAX = 0.15          # kg/kg — beyond this we are far outside any data hall


def in_core(tc, p_kpa, w):
    return (
        CORE_T_MIN <= tc <= CORE_T_MAX
        and CORE_P_MIN <= p_kpa <= CORE_P_MAX
        and w is not None
        and w <= CORE_W_MAX
    )


COLUMNS = [
    "t_c",        # dry-bulb °C
    "rh_pct",     # relative humidity %
    "p_kpa",      # total pressure kPa
    "core",       # 1 = inside the declared operating domain, 0 = outside
    "w",          # humidity ratio kg/kg dry air
    "pw_kpa",     # partial pressure of water vapour kPa (enhancement-corrected)
    "h_kjkg",     # enthalpy kJ/kg dry air
    "s_kjkgk",    # entropy kJ/(kg·K) dry air
    "v_m3kg",     # specific volume m³/kg dry air
    "rho_kgm3",   # density of the moist air mixture kg/m³
    "tdp_c",      # dew-point °C
    "twb_c",      # wet-bulb °C  (null where CoolProp refuses — triple-point band)
    "mu_pas",     # dynamic viscosity Pa·s
    "k_wmk",      # thermal conductivity W/(m·K)
    "z",          # compressibility factor
]


def sig(x, digits=10):
    """Trim float noise so the committed JSON diffs cleanly."""
    if x is None:
        return None
    return float(f"%.{digits}g" % x)


def main():
    rows = []
    skipped = 0
    twb_gaps = 0

    for p_kpa in PRESSURES_KPA:
        p_pa = p_kpa * 1000.0
        for tc in TEMPS_C:
            t_k = tc + 273.15
            for rh in RH_PCT:
                r = rh / 100.0
                try:
                    w = HAPropsSI("W", "T", t_k, "P", p_pa, "R", r)
                    pw = HAPropsSI("P_w", "T", t_k, "P", p_pa, "R", r)
                    h = HAPropsSI("Hda", "T", t_k, "P", p_pa, "R", r)
                    s = HAPropsSI("Sda", "T", t_k, "P", p_pa, "R", r)
                    v = HAPropsSI("Vda", "T", t_k, "P", p_pa, "R", r)
                    tdp = HAPropsSI("D", "T", t_k, "P", p_pa, "R", r)
                    mu = HAPropsSI("M", "T", t_k, "P", p_pa, "R", r)
                    k = HAPropsSI("K", "T", t_k, "P", p_pa, "R", r)
                    z = HAPropsSI("Z", "T", t_k, "P", p_pa, "R", r)
                except Exception:
                    # Outside CoolProp's own solvable region (very low pressure at
                    # high temperature drives the water mole fraction toward 1).
                    skipped += 1
                    continue

                # Wet bulb is solved separately: CoolProp deliberately RAISES near
                # the triple point (273.16 K) rather than return a value from the
                # physically unreachable band. Recording null there is the point —
                # the JS core must flag the same band instead of inventing a number.
                try:
                    twb = HAPropsSI("B", "T", t_k, "P", p_pa, "R", r) - 273.15
                except Exception:
                    twb = None
                    twb_gaps += 1

                # Mixture density: (1 + W) kg of moist air per kg of dry air,
                # occupying v m³. Same definition the JS core uses.
                rho = (1.0 + w) / v

                rows.append([
                    sig(tc), sig(rh), sig(p_kpa),
                    1 if in_core(tc, p_kpa, w) else 0,
                    sig(w), sig(pw / 1000.0), sig(h / 1000.0), sig(s / 1000.0),
                    sig(v), sig(rho), sig(tdp - 273.15), sig(twb),
                    sig(mu), sig(k), sig(z),
                ])

    core_rows = sum(1 for r in rows if r[3] == 1)
    payload = {
        "source": "CoolProp HAPropsSI (ASHRAE RP-1485 / Herrmann et al. 2009)",
        "coolprop_version": CoolProp.__version__,
        "generator": "test/reference/generate_reference.py",
        "note": (
            "Committed on purpose so CI needs no Python and no network. "
            "Regenerate with: pip install CoolProp && "
            "python3 test/reference/generate_reference.py"
        ),
        "core_domain": {
            "t_c": [CORE_T_MIN, CORE_T_MAX],
            "p_kpa": [CORE_P_MIN, CORE_P_MAX],
            "w_max_kgkg": CORE_W_MAX,
        },
        "units": {
            "t_c": "degC", "rh_pct": "%", "p_kpa": "kPa", "w": "kg/kg dry air",
            "pw_kpa": "kPa", "h_kjkg": "kJ/kg dry air", "s_kjkgk": "kJ/(kg K) dry air",
            "v_m3kg": "m3/kg dry air", "rho_kgm3": "kg/m3", "tdp_c": "degC",
            "twb_c": "degC", "mu_pas": "Pa s", "k_wmk": "W/(m K)", "z": "-",
        },
        "columns": COLUMNS,
        "rows": rows,
    }

    with open(OUT, "w") as f:
        json.dump(payload, f, separators=(",", ":"))
        f.write("\n")

    size_kb = os.path.getsize(OUT) / 1024
    print(f"CoolProp {CoolProp.__version__}")
    print(f"wrote {OUT}  ({size_kb:.0f} KB)")
    print(f"  {len(rows)} rows  ({core_rows} in the core domain, "
          f"{len(rows) - core_rows} outside)")
    print(f"  {skipped} grid points unsolvable by CoolProp itself (skipped)")
    print(f"  {twb_gaps} rows with no wet bulb (triple-point band)")


if __name__ == "__main__":
    main()
