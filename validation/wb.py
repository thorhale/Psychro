import numpy as np, math, json
from CoolProp.HumidAirProp import HAPropsSI
from CoolProp.CoolProp import PropsSI
F=json.load(open('fits2.json')); F3=json.load(open('fits3.json'))
ENH,HDA,HV,HW = F['enh'],F3['hda'],F3['hv'],F3['hw']

Tc,Pc=647.096,22.064e6
A=[-7.85951783,1.84408259,-11.7866497,22.6807411,-15.9618719,1.80122502]
def ps(tc):
    if tc>=0.01:
        T=tc+273.15; th=1-T/Tc
        return Pc*math.exp(Tc/T*(A[0]*th+A[1]*th**1.5+A[2]*th**3+A[3]*th**3.5+A[4]*th**4+A[5]*th**7.5))/1000.0
    T=tc+273.15; Tn,Pn=273.16,611.657; th=T/Tn
    a=[-0.212144006e2,0.273203819e2,-0.610598130e1]; b=[0.333333333e-2,0.120666667e1,0.170333333e1]
    return Pn*math.exp(sum(ai*th**bi for ai,bi in zip(a,b))/th)/1000.0

def fenh(t,p):
    pk=p/100.0; ip=1/pk
    b=[1,t,t**2,t**3,t**4, ip,ip*t,ip*t**2,ip*t**3,ip*t**4, pk,pk*t,pk*t**2, ip**2,ip**2*t,ip**2*t**2]
    return math.exp(sum(c*x for c,x in zip(ENH,b)))
def W_of(pw,p,t):
    Pw=fenh(t,p)*pw
    return 0.621945*Pw/(p-Pw) if Pw>0 else 0.0
def hda(t,p):
    pk=p/100.0; b=[1,t,t**2,t**3,pk,pk*t,pk**2]
    return sum(c*x for c,x in zip(HDA,b))
def hv(t,W,p):
    pk=p/100.0; b=[1,t,t**2,t**3,W,W*t,W*t**2,W**2,pk,pk*t,W*pk]
    return sum(c*x for c,x in zip(HV,b))
def H(t,W,p): return hda(t,p)+W*hv(t,W,p)
def hw(t): return HW[0]*t+HW[1]*t**2+HW[2]*t**3

def twb_adiabatic(t,W,p,hfun):
    lo,hi=-70.0,t
    for _ in range(80):
        m=(lo+hi)/2
        Ws=W_of(ps(m),p,m)
        # h(t,W) + (Ws-W)*hw(m)  -  h(m,Ws)  == 0 at the wet bulb
        g=hfun(t,W,p)+(Ws-W)*hw(m)-hfun(m,Ws,p)
        if g>0: lo=m
        else: hi=m
    return (lo+hi)/2

def H_cp(t,W,p):
    return HAPropsSI('H','T',t+273.15,'P',p*1000.0,'W',W)/1000.0

# ASHRAE Eq.35 for comparison
def twb_ashrae(t,W,p):
    lo,hi=-70.0,t
    for _ in range(80):
        m=(lo+hi)/2
        Ws=W_of(ps(m),p,m)
        if m>=0: Wst=((2501-2.326*m)*Ws-1.006*(t-m))/(2501+1.86*t-4.186*m)
        else:    Wst=((2830-0.24*m)*Ws-1.006*(t-m))/(2830+1.86*t-2.1*m)
        if Wst>W: hi=m
        else: lo=m
    return (lo+hi)/2

eA=[];eB=[];eC=[]
for tc in [0,5,10,15,20,25,30,35,40,45]:
    for rh in [1,5,10,20,30,40,50,60,70,80,90,100]:
        for p in [65,75,85,95,101.325,110]:
            try: ref=HAPropsSI('Twb','T',tc+273.15,'P',p*1000.0,'R',rh/100.0)-273.15
            except Exception: continue
            W=HAPropsSI('W','T',tc+273.15,'P',p*1000.0,'R',rh/100.0)
            eA.append((abs(twb_ashrae(tc,W,p)-ref),f"{tc}C {rh}% {p}kPa"))
            eB.append((abs(twb_adiabatic(tc,W,p,H_cp)-ref),f"{tc}C {rh}% {p}kPa"))
            eC.append((abs(twb_adiabatic(tc,W,p,H)-ref),f"{tc}C {rh}% {p}kPa"))
for nm,e in [("ASHRAE Eq.35",eA),("adiabatic + CoolProp h",eB),("adiabatic + fitted h",eC)]:
    m=max(e); print(f"{nm:26s} max {m[0]:.5f} C @ {m[1]}   mean {np.mean([x[0] for x in e]):.6f}")

# ── psychrometric (sling) vs thermodynamic wet bulb ──
# WMO CIMO: e = e_w(tw) - A*p*(t-tw), A=6.53e-4*(1+0.000944*tw) aspirated
print("\nPSYCHROMETRIC (WMO sling/aspirated) vs THERMODYNAMIC wet bulb")
def rh_from_wmo(t,tw,p):
    Aw=6.53e-4*(1+0.000944*tw)
    e=ps(tw)-Aw*p*(t-tw)
    return max(0.0,e/ps(t)*100)
for tc,rh,p in [(24,45,101.325),(24,45,97.48),(35,20,101.325),(15,60,101.325),(40,10,83.0)]:
    tw_th=HAPropsSI('Twb','T',tc+273.15,'P',p*1000.0,'R',rh/100.0)-273.15
    rh_th=rh
    rh_ps=rh_from_wmo(tc,tw_th,p)
    print(f"  t={tc}C rh={rh}% p={p}: if instrument reads {tw_th:.3f}C -> WMO says {rh_ps:.3f}% (delta {rh_ps-rh_th:+.3f} pts)")
