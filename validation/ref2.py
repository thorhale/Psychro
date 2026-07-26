import json, itertools, math
from CoolProp.HumidAirProp import HAPropsSI
from CoolProp.CoolProp import PropsSI

# IAPWS-06 / Wagner 2011 sublimation pressure over ice Ih — the true reference
# for the sub-freezing branch (CoolProp's PropsSI Q=0 gives SUPERCOOLED LIQUID,
# which differs from ice by ~30% at -40C and is the wrong comparison).
def p_sub_ice(tc):
    T = tc + 273.15
    Tn, Pn = 273.16, 611.657  # triple point
    th = T / Tn
    a = [-0.212144006e2, 0.273203819e2, -0.610598130e1]
    b = [0.333333333e-2, 0.120666667e1, 0.170333333e1]
    s = sum(ai * th**bi for ai, bi in zip(a, b))
    return Pn * math.exp(s / th) / 1000.0  # kPa

sat = []
for tc in [-60,-50,-40,-30,-20,-15,-10,-5,-1,0,5,10,15,20,25,30,35,40,45,50,60,80]:
    e = {"tc": tc}
    if tc >= 0.01:
        e["ref"] = PropsSI('P','T',tc+273.15,'Q',0,'Water')/1000.0
        e["kind"] = "water(IAPWS-95)"
    else:
        e["ref"] = p_sub_ice(tc)
        e["kind"] = "ice(IAPWS-06)"
    sat.append(e)

rows = []
temps_c = [0, 5, 10, 15, 20, 22, 25, 27, 30, 32, 35, 40, 45]
rhs     = [1, 5, 10, 20, 30, 40, 45, 50, 60, 70, 80, 90, 100]
press   = [101.325, 97.48, 89.875, 83.0, 79.495, 74.7, 65.0, 22.6, 124.0]
for tc, rh, p in itertools.product(temps_c, rhs, press):
    T, P, R = tc + 273.15, p * 1000.0, rh / 100.0
    try:
        rows.append({"tc":tc,"rh":rh,"p":p,
            "W":HAPropsSI('W','T',T,'P',P,'R',R),
            "Tdp":HAPropsSI('Tdp','T',T,'P',P,'R',R)-273.15,
            "Twb":HAPropsSI('Twb','T',T,'P',P,'R',R)-273.15,
            "H":HAPropsSI('H','T',T,'P',P,'R',R)/1000.0,
            "Vda":HAPropsSI('Vda','T',T,'P',P,'R',R)})
    except Exception: pass

# Dense enhancement-factor table for refitting: f = x_ws*P/pws(T)
enh = []
for i in range(0, 51):          # 0..50 C
    for p in [20,25,30,40,50,60,65,70,75,80,85,90,95,101.325,110,120,125]:
        T, P = i+273.15, p*1000.0
        try:
            psat = PropsSI('P','T',T,'Q',0,'Water')
            if psat >= 0.9*P: continue
            Ws = HAPropsSI('W','T',T,'P',P,'R',1.0)
            xws = Ws/(0.621945+Ws)
            enh.append({"tc":i,"p":p,"f":xws*P/psat})
        except Exception: pass

json.dump({"rows":rows,"sat":sat,"enh":enh}, open('coolprop_ref2.json','w'))
print("rows",len(rows),"sat",len(sat),"enh",len(enh))
