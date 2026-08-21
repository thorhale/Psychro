"""CDU model: PG25 secondary (server) loop <-> water primary (facility) loop.
Properties from CoolProp; chevron-plate Nu = C Re^0.7 Pr^(1/3)."""
from CoolProp.CoolProp import PropsSI
import math
P = 300000.0
SEC, PRI = 'INCOMP::MPG-25%', 'Water'

def props(f, Tc):
    T = Tc + 273.15
    return dict(rho=PropsSI('D','T',T,'P',P,f), cp=PropsSI('C','T',T,'P',P,f),
                mu=PropsSI('V','T',T,'P',P,f),  k=PropsSI('L','T',T,'P',P,f))

def phi(p, n=0.7):
    """film-coefficient property group: h ~ k^(2/3) cp^(1/3) rho^n mu^(1/3-n) * V^n"""
    return p['k']**(2/3) * p['cp']**(1/3) * p['rho']**n * p['mu']**(1/3 - n)

N = 0.7
# ---- design point (anchors the geometry constant K) ----
T_FWS   = 18.0      # facility supply, degC  (ASHRAE W27 class facility)
Q_DES   = 500e3     # W  500 kW CDU
DT_SEC  = 8.0       # K  design rack rise
DT_PRI  = 10.0      # K  design facility rise
APPROACH= 3.0       # K  design approach (vendor-cited figure)

ps_d, pp_d = props(SEC, 30.0), props(PRI, 23.0)
C_s_d = Q_DES / DT_SEC
C_p_d = Q_DES / DT_PRI
V_s_d = C_s_d / (ps_d['rho']*ps_d['cp']) * 60000   # L/min
V_p_d = C_p_d / (pp_d['rho']*pp_d['cp']) * 60000

G_d   = Q_DES / (APPROACH + DT_SEC)                # Q = G*(T_sec_ret - T_fws)
Cmin_d= min(C_s_d, C_p_d)
eps_d = G_d / Cmin_d
cr_d  = Cmin_d / max(C_s_d, C_p_d)
x     = (1-eps_d)/(1-eps_d*cr_d)
NTU_d = -math.log(x)/(1-cr_d)
UA_d  = NTU_d * Cmin_d

# split UA between the two sides with a common geometric constant K, wall = 5% of total R
R_tot = 1/UA_d
R_w   = 0.05*R_tot
denom = (1/(phi(ps_d)*V_s_d**N) + 1/(phi(pp_d)*V_p_d**N))
K     = denom/(R_tot - R_w)

print(f"design: {Q_DES/1e3:.0f} kW | secondary {V_s_d:.0f} L/min PG25 | facility {V_p_d:.0f} L/min water")
print(f"        rack dT {DT_SEC} K | facility dT {DT_PRI} K | approach {APPROACH} K")
print(f"        -> eps {eps_d:.4f}  Cr {cr_d:.3f}  NTU {NTU_d:.3f}  UA {UA_d/1e3:.2f} kW/K")
print(f"        -> h_glycol/h_water at equal L/min = {phi(ps_d)/phi(pp_d):.3f}")
print()

def solve(V_s, V_p, Q, T_fws=T_FWS, iters=12):
    """V in L/min, Q in W. Iterates because properties depend on loop temps."""
    Ts_mean, Tp_mean = 30.0, 23.0
    for _ in range(iters):
        ps, pp = props(SEC, Ts_mean), props(PRI, Tp_mean)
        C_s = V_s/60000 * ps['rho']*ps['cp']
        C_p = V_p/60000 * pp['rho']*pp['cp']
        UA  = 1/(1/(K*phi(ps)*V_s**N) + R_w + 1/(K*phi(pp)*V_p**N))
        Cmin, Cmax = min(C_s,C_p), max(C_s,C_p)
        cr  = Cmin/Cmax
        ntu = UA/Cmin
        if cr > 0.9995: eps = ntu/(1+ntu)
        else:
            e = math.exp(-ntu*(1-cr)); eps = (1-e)/(1-cr*e)
        G   = eps*Cmin
        T_sec_ret = T_fws + Q/G
        T_sec_sup = T_sec_ret - Q/C_s
        T_pri_ret = T_fws + Q/C_p
        Ts_mean, Tp_mean = (T_sec_ret+T_sec_sup)/2, (T_pri_ret+T_fws)/2
    return dict(eps=eps, ntu=ntu, cr=cr, UA=UA, G=G, C_s=C_s, C_p=C_p,
                sec_sup=T_sec_sup, sec_ret=T_sec_ret, pri_ret=T_pri_ret,
                dT_sec=Q/C_s, dT_pri=Q/C_p, approach=T_sec_sup-T_fws,
                Q_sec=C_s*(T_sec_ret-T_sec_sup), Q_pri=C_p*(T_pri_ret-T_fws))
