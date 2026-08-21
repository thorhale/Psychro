#!/usr/bin/env python3
"""Generate the coolant-property reference grid used as the accuracy oracle for
`src/core/coolant.js`.

Same methodology as `generate_reference.py` does for humid air, and for the same
reason: CoolProp is the accurate model and is far too heavy to ship in an
offline-first phone app, so we use it here, offline, to pin a hand-coded core.

CoolProp's INCOMP library implements the published property data for aqueous
ethylene-glycol (MEG) and propylene-glycol (MPG) solutions — the same secondary
coolants ASHRAE Fundamentals Ch. 31 tabulates. Water is the 0 % member of either
series, so one grid covers all three fluids a CDU actually sees.

The output (`coolant-reference.json`) is COMMITTED so CI stays hermetic and needs
neither Python nor a network. Regenerate by hand when the grid changes:

    pip install CoolProp
    python3 test/reference/generate_coolant_reference.py

Domain
------
Temperature -10..60 C, which spans everything from a chilled-water CDU primary
to an ASHRAE W45 warm-water loop, with margin at both ends. Concentration
0..60 % by mass, the range the published data covers.

A point is only emitted where the mixture is actually LIQUID: at least 3 K above
its own freeze point. Below that the incompressible fit still returns numbers,
and they describe a slush nobody pumps.

Units are SI-with-engineering-scale to match the JS core:
  temperature  C
  density      kg/m3
  specific heat  kJ/(kg.K)      (CoolProp returns J/(kg.K))
  conductivity   W/(m.K)
  viscosity      mPa.s          (CoolProp returns Pa.s)
  freeze point   C
"""

import json
import os
from CoolProp.CoolProp import PropsSI
import CoolProp

P_REF = 300000.0  # Pa — 3 bar, a typical CDU loop pressure. Liquid properties
                  # are essentially pressure-independent; this just picks a point
                  # comfortably above saturation across the whole range.

FLUIDS = ['MEG', 'MPG']
CONCS = list(range(0, 65, 5))                       # 0..60 % by mass
TEMPS = [round(-10 + 2.5 * i, 2) for i in range(29)]  # -10..60 C

FREEZE_MARGIN_K = 3.0

rows = []
freeze = {}

for base in FLUIDS:
    for c in CONCS:
        fl = f'INCOMP::{base}-{c}%'
        tf = PropsSI('T_freeze', 'T', 293.15, 'P', P_REF, fl) - 273.15
        freeze.setdefault(base, {})[str(c)] = round(tf, 4)
        for t in TEMPS:
            if t < tf + FREEZE_MARGIN_K:
                continue                       # slush, not a coolant
            T = t + 273.15
            rows.append([
                base, c, t,
                round(PropsSI('D', 'T', T, 'P', P_REF, fl), 6),          # kg/m3
                round(PropsSI('C', 'T', T, 'P', P_REF, fl) / 1000.0, 8),  # kJ/kg.K
                round(PropsSI('L', 'T', T, 'P', P_REF, fl), 8),          # W/m.K
                round(PropsSI('V', 'T', T, 'P', P_REF, fl) * 1000.0, 8),  # mPa.s
            ])

out = {
    'source': 'CoolProp INCOMP aqueous glycol library (ASHRAE Fundamentals Ch. 31 secondary coolants)',
    'coolprop_version': CoolProp.__version__,
    'p_ref_pa': P_REF,
    'freeze_margin_k': FREEZE_MARGIN_K,
    'domain': {'t_c': [TEMPS[0], TEMPS[-1]], 'conc_pct': [CONCS[0], CONCS[-1]]},
    'columns': ['fluid', 'conc_pct', 't_c', 'rho_kgm3', 'cp_kjkgk', 'k_wmk', 'mu_mpas'],
    'freeze_c': freeze,
    'rows': rows,
}

here = os.path.dirname(os.path.abspath(__file__))
path = os.path.join(here, 'coolant-reference.json')
with open(path, 'w') as f:
    json.dump(out, f, separators=(',', ':'))
print(f'wrote {path}: {len(rows)} rows, CoolProp {CoolProp.__version__}')
