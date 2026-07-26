import numpy as np, math, json
from CoolProp.HumidAirProp import HAPropsSI
exec(open('wb.py').read().split('eA=[]')[0])
bands={'RH>=20% (any real hall)':lambda r:r>=20,'RH 10-20%':lambda r:10<=r<20,'RH<10% (absurd)':lambda r:r<10}
for bn,test in bands.items():
    eA=[];eC=[]
    for tc in [0,5,10,15,20,25,30,35,40,45]:
        for rh in [1,5,10,15,20,30,40,50,60,70,80,90,100]:
            if not test(rh): continue
            for p in [65,75,85,95,101.325,110]:
                try: ref=HAPropsSI('Twb','T',tc+273.15,'P',p*1000.0,'R',rh/100.0)-273.15
                except Exception: continue
                W=HAPropsSI('W','T',tc+273.15,'P',p*1000.0,'R',rh/100.0)
                eA.append(abs(twb_ashrae(tc,W,p)-ref)); eC.append(abs(twb_adiabatic(tc,W,p,H)-ref))
    print(f"{bn:26s} Eq.35 max {max(eA):.4f} mean {np.mean(eA):.5f} | adiabatic max {max(eC):.4f} mean {np.mean(eC):.5f}")
