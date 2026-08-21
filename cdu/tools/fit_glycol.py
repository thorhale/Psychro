#!/usr/bin/env python3
"""Fit the glycol property tables shipped in cdu/index.html and tools/model.mjs.

CoolProp's incompressible-mixture model IS a polynomial in (temperature,
concentration), so the degree-5 x 5 least-squares fit here does not approximate
it -- it RECOVERS it, to ~1e-8 relative. That is why the shipped tables are
exact against the committed grid rather than merely close.

Coefficients are emitted for a nested-Horner evaluation in normalized
coordinates tn = t/50, cn = c/60, row-major with BOTH indices descending:

    v = 0
    for i in 5..0:  row = horner(C[i*6 .. i*6+5], cn);  v = v*tn + row

Viscosity is fitted in log space (it spans a decade) and exp'd on evaluation.
Freeze points are a concentration-only degree-5 polynomial per fluid.

    python3 tools/fit_glycol.py          # prints residuals + the JSON table
"""
import json, os
import numpy as np

DEG = 5
here = os.path.dirname(os.path.abspath(__file__))
ref = json.load(open(os.path.join(here, 'coolant-reference.json')))
cols = {c: i for i, c in enumerate(ref['columns'])}
rows = ref['rows']

def basis(tn, cn):
    return np.array([(tn ** i) * (cn ** j) for i in range(DEG + 1) for j in range(DEG + 1)]).T

def to_horner(coef):
    """ascending (i,j) -> row-major, both indices DESCENDING, for nested Horner."""
    out = []
    for i in range(DEG, -1, -1):
        for j in range(DEG, -1, -1):
            out.append(float(coef[i * (DEG + 1) + j]))
    return out

def eval_horner(flat, tn, cn):
    v = 0.0
    for i in range(DEG + 1):
        row = 0.0
        for j in range(DEG + 1):
            row = row * cn + flat[i * (DEG + 1) + j]
        v = v * tn + row
    return v

out = {}
for fluid in ['MPG', 'MEG']:
    R = [r for r in rows if r[cols['fluid']] == fluid]
    t = np.array([r[cols['t_c']] for r in R]); c = np.array([r[cols['conc_pct']] for r in R])
    tn, cn = t / 50.0, c / 60.0
    A = basis(tn, cn)
    out[fluid] = {}
    for prop, key, log in [('rho', 'rho_kgm3', False), ('cp', 'cp_kjkgk', False),
                           ('k', 'k_wmk', False), ('mu', 'mu_mpas', True)]:
        y = np.array([r[cols[key]] for r in R])
        coef, *_ = np.linalg.lstsq(A, np.log(y) if log else y, rcond=None)
        flat = to_horner(coef)
        pred = np.array([eval_horner(flat, a, b) for a, b in zip(tn, cn)])
        if log: pred = np.exp(pred)
        res = float((np.abs(pred - y) / np.abs(y)).max())
        print(f'// {fluid} {prop}: max rel residual {res:.2e}')
        assert res < 1e-6, f'{fluid} {prop} fit degraded: {res}'
        out[fluid][prop] = flat
    fz = ref['freeze_c'][fluid]
    cc = np.array([float(k) for k in fz]) / 60.0; ff = np.array([fz[k] for k in fz])
    Af = np.array([cc ** i for i in range(DEG + 1)]).T
    fc, *_ = np.linalg.lstsq(Af, ff, rcond=None)
    flat = [float(x) for x in fc[::-1]]
    pred = np.array([np.polyval(flat, x) for x in cc])
    print(f'// {fluid} freeze: max residual {np.abs(pred - ff).max():.2e} K')
    out[fluid]['freeze'] = flat

print(json.dumps(out))
