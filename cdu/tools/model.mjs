// Numeric core of the CDU model, mirrored from the inline script in index.html.
// tools/validate.mjs asserts the constants here match the shipped page, so the
// two cannot drift apart silently.
//
// Fluid properties are polynomial fits to CoolProp (INCOMP::MPG-25% and Water)
// over 5-65 C, max error <0.1%. See tools/cdu_reference.py for the generator.

function poly(c, t){ let v = 0; for (let i = 0; i < c.length; i++) v = v * t + c[i]; return v; }

export const RC_SEC = [0.029558503377469632, -16.83120593278887, 1523.4439956977433, 3972074.4271044964];
export const PH_SEC = [-1.953969440807018e-09, 5.606143994741473e-07, -5.2320049139895085e-06, -0.007552316537578508, 0.32552809259857235, 148.83027153694547, 7949.728017118769];
export const RC_PRI = [7.005571912629277e-07, -0.00020353176220472646, 0.026246869157615704, -1.9271441162086773, 78.2735421654597, -3059.193152727693, 4218007.657748665];
export const PH_PRI = [1.4005718700326837e-07, -3.819092066196206e-05, 0.004013370044200002, -0.6872062551669611, 218.31930882818543, 13979.291181203396];

export const N_EXP  = 0.7;          // chevron-plate Re exponent
export const K_GEO  = 0.34703;      // plate-pack constant, anchored to a 3 K design approach at 500 kW
export const R_WALL = 1.82048e-7;   // K/W  plate wall + fouling
export const T_FWS  = 18.0;         // facility water supply, degC (ASHRAE W27)
export const T_TRIP = 90.0;         // die throttle setpoint, degC
export const N_DEV  = 360;          // devices in the hall
export const R_CP   = 0.012;        // K/W  per-device cold-plate resistance
export const DP_GLY = 1.19;         // glycol pressure-drop penalty vs water at equal flow
export const VS_D   = 940;          // design secondary flow, L/min
export const VP_D   = 720;          // design primary flow, L/min

/** Steady-state solve. Vs, Vp in L/min; qW in W. */
export function solve(Vs, Vp, qW){
  let Tsm = 30, Tpm = 23;
  let Cs, Cp, UA, Cmin, cr, ntu, e, G, q, hotIn, hotOut, facOut, chip;
  for (let i = 0; i < 10; i++){
    Cs = Vs / 60000 * poly(RC_SEC, Tsm);
    Cp = Vp / 60000 * poly(RC_PRI, Tpm);
    UA = 1 / (1 / (K_GEO * poly(PH_SEC, Tsm) * Math.pow(Vs, N_EXP)) + R_WALL
            + 1 / (K_GEO * poly(PH_PRI, Tpm) * Math.pow(Vp, N_EXP)));
    Cmin = Math.min(Cs, Cp);
    cr   = Cmin / Math.max(Cs, Cp);
    ntu  = UA / Cmin;
    if (cr > 0.9995) e = ntu / (1 + ntu);
    else { const x = Math.exp(-ntu * (1 - cr)); e = (1 - x) / (1 - cr * x); }
    G = e * Cmin;
    // the hottest die sits at the rack OUTLET and sees its own cold-plate rise on top
    q = Math.min(qW, (T_TRIP - T_FWS) / (1 / G + R_CP / N_DEV));
    hotIn  = T_FWS + q / G;
    hotOut = hotIn - q / Cs;
    facOut = T_FWS + q / Cp;
    chip   = hotIn + (q / N_DEV) * R_CP;
    Tsm = (hotIn + hotOut) / 2;
    Tpm = (facOut + T_FWS) / 2;
  }
  return { e, ntu, cr, G, q, demand: qW, throttled: q < qW - 1,
           hotIn, hotOut, facOut, chip,
           rackDT: hotIn - hotOut, facDT: facOut - T_FWS, approach: hotOut - T_FWS,
           Qsec: Cs * (hotIn - hotOut), Qpri: Cp * (facOut - T_FWS),
           pump: (DP_GLY * Math.pow(Vs / VS_D, 3) + Math.pow(Vp / VP_D, 3)) / (DP_GLY + 1) };
}
