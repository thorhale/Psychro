import numpy as np, math, json
from CoolProp.HumidAirProp import HAPropsSI
from CoolProp.CoolProp import PropsSI

Tc, Pc = 647.096, 22.064e6
A = [-7.85951783, 1.84408259, -11.7866497, 22.6807411, -15.9618719, 1.80122502]
def ps_iapws(tc):
    T = tc+273.15; th = 1-T/Tc
    return Pc*math.exp(Tc/T*(A[0]*th+A[1]*th**1.5+A[2]*th**3+A[3]*th**3.5+A[4]*th**4+A[5]*th**7.5))/1000.0
def p_sub_ice(tc):
    T=tc+273.15; Tn,Pn=273.16,611.657; th=T/Tn
    a=[-0.212144006e2,0.273203819e2,-0.610598130e1]; b=[0.333333333e-2,0.120666667e1,0.170333333e1]
    return Pn*math.exp(sum(ai*th**bi for ai,bi in zip(a,b))/th)/1000.0

# accuracy of the ancillaries over the band that matters
for lo,hi,fn,name in [(0.01,60,ps_iapws,'IAPWS-95 water 0-60C'),(-60,-0.01,p_sub_ice,'IAPWS-06 ice -60..0C')]:
    e=[]
    for tc in np.arange(lo,hi,0.5):
        if tc>=0.01: ref=PropsSI('P','T',tc+273.15,'Q',0,'Water')/1000.0
        else: continue
        e.append(abs(fn(tc)-ref)/ref*100)
    if e: print(f"{name}: max {max(e):.3e} %")

# ── Enhancement factor, weighted toward the real band ──
pts=[]
for tc in np.arange(-30,55.1,0.5):
    for p in [20,25,30,35,40,45,50,55,60,65,70,75,80,85,90,95,101.325,105,110,115,120,125,130]:
        T,P=tc+273.15,p*1000.0
        try:
            psat=(ps_iapws(tc) if tc>=0.01 else p_sub_ice(tc))*1000.0
            if psat>=0.5*P: continue
            Ws=HAPropsSI('W','T',T,'P',P,'R',1.0); xws=Ws/(0.621945+Ws)
            pts.append((tc,p,xws*P/psat))
        except Exception: pass
pts=np.array(pts); t,p,f=pts[:,0],pts[:,1],pts[:,2]
def ebasis(t,p):
    pk=p/100.0; ip=1/pk
    return np.column_stack([np.ones_like(t),t,t**2,t**3,t**4,
                            ip,ip*t,ip*t**2,ip*t**3,ip*t**4,
                            pk,pk*t,pk*t**2,ip**2,ip**2*t,ip**2*t**2])
Bm=ebasis(t,p)
w=np.where(p>=55,4.0,1.0)                       # weight the realistic band
coef,*_=np.linalg.lstsq(Bm*w[:,None],np.log(f)*w,rcond=None)
r=(np.exp(Bm@coef)-f)/f*100
real=p>=55
print(f"\nENH fit  all: max {np.abs(r).max():.5f}%  |  real(>=55kPa): max {np.abs(r[real]).max():.5f}% rms {np.sqrt((r[real]**2).mean()):.6f}%")
print("ENH:", ", ".join(f"{c:.10e}" for c in coef))

# ── Enthalpy + specific volume, two-stage, realistic domain ──
rows=[]
for tc in np.arange(-30,55.1,1.0):
    for p in [50,55,60,65,70,75,80,85,90,95,101.325,105,110,115,120,125,130]:
        for rh in [0,.05,.1,.2,.3,.4,.5,.6,.7,.8,.9,1.0]:
            T,P=tc+273.15,p*1000.0
            try:
                W=HAPropsSI('W','T',T,'P',P,'R',rh)
                if W>0.20: continue                  # beyond any habitable air
                rows.append((tc,p,W,HAPropsSI('H','T',T,'P',P,'R',rh)/1000.0,
                             HAPropsSI('Vda','T',T,'P',P,'R',rh)))
            except Exception: pass
R=np.array(rows); tt,pp,WW,hh,vv=R[:,0],R[:,1],R[:,2],R[:,3],R[:,4]
print(f"\nenthalpy pts {len(R)}, W max {WW.max():.4f}")
print(f"ASHRAE Eq30 err over this domain: max {np.abs(1.006*tt+WW*(2501+1.86*tt)-hh).max():.4f} kJ/kg")

def hbasis(t,W,p):
    pk=p/100.0
    return np.column_stack([np.ones_like(t),t,t**2,t**3,
                            W,W*t,W*t**2,W*t**3,
                            W**2,W**2*t,W*pk,W*t*pk,W**2*pk])
Hb=hbasis(tt,WW,pp); hc,*_=np.linalg.lstsq(Hb,hh,rcond=None)
hr=Hb@hc-hh
print(f"H fit: max {np.abs(hr).max():.6f} kJ/kg  rms {np.sqrt((hr**2).mean()):.7f}")
print("H:", ", ".join(f"{c:.10e}" for c in hc))

Rda=0.287042
Z=vv/(Rda*(tt+273.15)*(1+1.607858*WW)/pp)
def zbasis(t,W,p):
    pk=p/100.0
    return np.column_stack([np.ones_like(t),t,t**2,t**3,pk,pk*t,pk*t**2,W,W*t,W*pk,pk**2,pk**2*t])
Zb=zbasis(tt,WW,pp); zc,*_=np.linalg.lstsq(Zb,Z,rcond=None)
zr=(Zb@zc-Z)/Z*100
print(f"\nideal-gas v err: max {abs(Z-1).max()*100:.5f}%   Z fit: max {np.abs(zr).max():.6f}% rms {np.sqrt((zr**2).mean()):.7f}%")
print("Z:", ", ".join(f"{c:.10e}" for c in zc))

json.dump({"enh":list(coef),"h":list(hc),"z":list(zc)},open('fits2.json','w'))
