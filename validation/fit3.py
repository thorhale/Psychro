import numpy as np, math, json
from CoolProp.HumidAirProp import HAPropsSI
from CoolProp.CoolProp import PropsSI

# ── Stage 1: dry-air enthalpy h_da(t,p) ──
d=[]
for tc in np.arange(-30,55.1,0.5):
    for p in [50,60,65,70,75,80,85,90,95,101.325,110,120,130]:
        try: d.append((tc,p,HAPropsSI('H','T',tc+273.15,'P',p*1000.0,'R',0.0)/1000.0))
        except Exception: pass
d=np.array(d); t1,p1,h1=d[:,0],d[:,1],d[:,2]
def dbasis(t,p):
    pk=p/100.0
    return np.column_stack([np.ones_like(t),t,t**2,t**3,pk,pk*t,pk**2])
Db=dbasis(t1,p1); dc,*_=np.linalg.lstsq(Db,h1,rcond=None)
dr=Db@dc-h1
print(f"h_da fit: max {np.abs(dr).max():.7f} kJ/kg  (vs 1.006t: {np.abs(1.006*t1-h1).max():.5f})")
print("HDA:", ", ".join(f"{c:.10e}" for c in dc))

# ── Stage 2: effective vapor enthalpy hv = (h - h_da)/W ──
r=[]
for tc in np.arange(-30,55.1,1.0):
    for p in [50,55,60,65,70,75,80,85,90,95,101.325,105,110,115,120,130]:
        P=p*1000.0
        try: hda=HAPropsSI('H','T',tc+273.15,'P',P,'R',0.0)/1000.0
        except Exception: continue
        for rh in [.02,.05,.1,.2,.3,.4,.5,.6,.7,.8,.9,1.0]:
            try:
                W=HAPropsSI('W','T',tc+273.15,'P',P,'R',rh)
                if W>0.20 or W<1e-6: continue
                h=HAPropsSI('H','T',tc+273.15,'P',P,'R',rh)/1000.0
                r.append((tc,p,W,(h-hda)/W))
            except Exception: pass
r=np.array(r); t2,p2,W2,hv=r[:,0],r[:,1],r[:,2],r[:,3]
print(f"\nhv pts {len(r)}, hv range {hv.min():.2f}..{hv.max():.2f} (vs 2501+1.86t)")
def vbasis(t,W,p):
    pk=p/100.0
    return np.column_stack([np.ones_like(t),t,t**2,t**3,W,W*t,W*t**2,W**2,pk,pk*t,W*pk])
Vb=vbasis(t2,W2,p2); vc,*_=np.linalg.lstsq(Vb,hv,rcond=None)
vr=Vb@vc-hv
print(f"hv fit: max {np.abs(vr).max():.6f} kJ/kg  rms {np.sqrt((vr**2).mean()):.7f}")
print("HV:", ", ".join(f"{c:.10e}" for c in vc))
# total enthalpy error implied
print(f"=> implied h error: max {np.abs(vr*W2).max():.7f} kJ/kg")

# ── Liquid water enthalpy h_w(t) (for the adiabatic-saturation balance) ──
lw=[]
for tc in np.arange(0.01,60,0.5):
    try: lw.append((tc,PropsSI('H','T',tc+273.15,'Q',0,'Water')/1000.0))
    except Exception: pass
lw=np.array(lw); tl,hl=lw[:,0],lw[:,1]
hl=hl-PropsSI('H','T',273.15,'Q',0,'Water')/1000.0     # reference to 0C liquid
Lb=np.column_stack([tl,tl**2,tl**3]); lc,*_=np.linalg.lstsq(Lb,hl,rcond=None)
print(f"\nh_water fit: max {np.abs(Lb@lc-hl).max():.7f} kJ/kg (vs 4.186t: {np.abs(4.186*tl-hl).max():.4f})")
print("HW:", ", ".join(f"{c:.10e}" for c in lc))

json.dump({"hda":list(dc),"hv":list(vc),"hw":list(lc)},open('fits3.json','w'))
