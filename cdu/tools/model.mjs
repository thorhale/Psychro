// Numeric core of the CDU model, mirrored from the inline script in index.html.
// tools/validate.mjs asserts every constant and coefficient here matches the
// shipped page, so the two cannot drift apart silently.
//
// Since the site-configuration work, the model is PARAMETERIZED: the numbers
// that used to be constants -- facility supply, design deltas, device count,
// glycol type and concentration, CDU capacity -- are a site object, and the
// plate-pack geometry is re-anchored from it exactly the way
// tools/cdu_reference.py anchored the original constants. The defaults
// reproduce the original 500 kW / PG25 / W27 tool to within a few
// thousandths of a kelvin.
//
// Glycol properties are degree-5x5 polynomial fits to CoolProp's INCOMP
// MPG/MEG mixtures over -10..60 C x 0..60 % by mass, exact to ~1e-8 relative
// against tools/coolant-reference.json (regenerate the fits with
// tools/fit_glycol.py). Water stays a plain polynomial in temperature.

function poly(c, t){ let v = 0; for (let i = 0; i < c.length; i++) v = v * t + c[i]; return v; }

/** Degree-5x5 nested Horner in normalized coords tn=t/50, cn=conc/60. */
function poly2(C, tn, cn){
  let v = 0;
  for (let i = 0; i < 36; i += 6){
    let r = 0;
    for (let j = 0; j < 6; j++) r = r * cn + C[i + j];
    v = v * tn + r;
  }
  return v;
}

export const GLY = {
  MPG: {
    rho: [0.00462949594684191, -0.01227531471055105, 0.011474728632755074, -0.004364646114652704, 0.0005114074045941884, 1.6400406153788043e-05, -0.012533912163426739, 0.03291629489861386, -0.03037599508719926, 0.011300156844898022, -0.0012268983186159246, -6.286271187551399e-05, 0.010860063114014575, -0.028101586646318632, 0.02537240570671509, 1.5101721604672105, -2.561257938374172, 2.5970802682457226, -0.002960245518934232, 0.007361983870077017, -3.880699962174306, -0.6478358080014789, 13.996824839896037, -16.442547249917258, -0.00010006058632979968, -14.391677722736024, 65.08050409920217, -65.75573855085314, -16.63180569570973, 1.8472103860331668, 18.211480212967412, -51.83871473583764, 3.2945814398174957, 37.840334019745676, 48.23417541302133, 1000.2416034323146],
    cp: [-6.6873588864730135e-06, 2.0250355121775554e-05, -2.3022648205106704e-05, 1.1671812785719417e-05, -2.2661654580871426e-06, 3.640275781865826e-08, 1.2206267092849654e-05, -4.0209510392046824e-05, 4.8935623324950254e-05, -2.590822712723453e-05, 5.0114763271077955e-06, -2.2212155110360393e-08, -5.723312372844763e-06, 2.255445882190715e-05, -3.055001756473103e-05, -0.021898069588455134, 0.033840510556387864, -0.012869908621119173, 7.329413204776622e-08, -1.8550189357117645e-06, -0.15929659622890197, 0.3925864435038659, -0.30617823530633165, 0.07360543871148803, 6.478374682867559e-07, -0.46235001344915716, 1.4898034211968898, -1.7090535358372665, 1.0026606853955125, -0.09475995511981815, -0.38561187576879896, 1.9370756730213106, -3.1660854561356286, 1.7983068367911113, -1.147465772091115, 4.2135409734225835],
    k: [-2.1724156798583772e-06, 4.4056902913193954e-06, -2.639358274158465e-06, 8.697236416495714e-07, -5.759990028533023e-07, 1.6933125974314609e-07, -2.9323443145240943e-06, 1.035591083977509e-05, -1.2193197616371004e-05, 3.836595127927399e-06, 1.3860074477783707e-06, -6.136793541656462e-07, 9.340810681279864e-06, -2.593509982077248e-05, 2.444537535138049e-05, 0.00444711354358526, -0.0034402966790812667, -0.00015168860581180274, -4.062115089833094e-06, 1.026191580537309e-05, 0.03532436729896062, -0.10451553239970389, 0.09042534318121546, -0.022087608738565374, -4.785245437920601e-08, -0.023359735366594903, -0.025606557199496678, 0.164204678471381, -0.20186610733792087, 0.10403730581490453, 0.016360850995445084, -0.034293050417479154, 0.04064190874055714, 0.006875151996475978, -0.2755353555658099, 0.5610542457689909],
    mu: [1.0869649463403917e-05, -3.560614033706717e-05, 4.396779296909223e-05, -2.4840572058277202e-05, 6.003834481982139e-06, -3.857921487131799e-07, -3.8246255865679534e-05, 0.00012065718033004821, -0.0001430779766461041, 7.749701850781116e-05, -1.7971678916274404e-05, 1.120365346733935e-06, 4.343044258912834e-05, -0.00013396221408758563, 0.00015480954374448694, -0.020173966170092827, -0.11891827514595063, -0.10875274551932741, -1.698158927306083e-05, 5.232998147518298e-05, -0.8581203957641486, 1.21334832908063, 0.35587222774199195, 0.589595376135223, 1.6806487867962137e-06, 0.2899746188121347, 1.6674015273900946, -2.869010023863178, -0.7534723946793265, -1.679365725317436, 2.7713663997008475, -7.486165202703573, 6.112009768565764, -1.183937404871917, 2.5684080684066224, 0.5915608578525987],
    freeze: [11.399639457015944, -73.34471476759185, 70.9621085972914, -48.363309502265096, -10.63122514191647, -0.02509592760182121]
  },
  MEG: {
    rho: [-0.00025543361778343336, 0.0013076785401233836, -0.0019390466749505315, 0.0011338229922858796, -0.00025343179542559267, 1.5031372540159912e-05, 0.0016082537416448146, -0.005817303270527992, 0.007287119604983568, -0.003843410028003781, 0.0007896507683746442, -4.114539892070542e-05, -0.0022664167443003464, 0.007222456018635254, -0.008324265483008266, 2.2460431432554424, -2.1791907317704062, 1.1180371955798116, 0.0008887737220961169, -0.0026834745033250157, -6.223184084386216, 1.7378766215669137, 10.114856612648643, -12.668016826546369, 6.74953675655188e-05, -46.72742092399088, 117.2656608020532, -85.34880150127724, -9.449569970356123, 0.09585891132333949, 38.03237554849878, -80.58300223153964, 31.32262950699691, 17.079488277087076, 82.73652336992785, 999.2662732654225],
    cp: [-1.3679126795671116e-06, -6.482195830528841e-06, 2.030200653763732e-05, -1.754263934537586e-05, 5.489382872350995e-06, -4.515545266116219e-07, -5.417686456472963e-06, 4.297407161045882e-05, -8.087330529141426e-05, 5.9308082204851516e-05, -1.7224837128280452e-05, 1.3769808959946589e-06, 1.7064415454850784e-05, -7.266199920908455e-05, 0.00010796345981154229, -0.032191050955354295, 0.034431341489513115, -0.01093955456694963, -1.2889095454688234e-05, 4.422655931425839e-05, -0.08877906218710013, 0.24399974211427197, -0.2453499609570511, 0.06532386004138203, 3.3054691433558046e-06, -0.2768354504838059, 0.669036859712786, -0.6267267490073206, 0.6588027224751429, -0.08538136319031074, -1.2581571167983494, 3.6089715263250324, -3.56001657022685, 1.1060351062521847, -1.1404801994852813, 4.210578946761974],
    k: [5.074437365033885e-06, -1.680263406101285e-05, 1.7899369355932296e-05, -7.179747369657513e-06, 8.78321054601066e-07, 1.848086319575251e-08, -3.0824642904083508e-06, 1.818346047012764e-05, -2.3774247069182614e-05, 9.896798721246585e-06, -7.34599722347447e-07, -1.9360504949379084e-07, -8.482612877218273e-06, 1.3002170408541058e-05, -6.051891573472372e-06, 0.0010667732677810463, -0.001952411048554835, 0.0003733938174474574, 7.359064863981061e-06, -1.7335718556707122e-05, 0.02163734389618056, -0.06788881341115917, 0.07016971229822722, -0.023051750139970805, -1.1134500147892146e-06, 0.016560145824695872, -0.08754154375557137, 0.16356374158390752, -0.1731499812585689, 0.10397565113389066, 0.02082403336346691, -0.08116791936730126, 0.14362949555748958, -0.07935222222268765, -0.21795532679861662, 0.5612071186772836],
    mu: [3.384294130453461e-05, -9.295855990328003e-05, 9.322872322703326e-05, -4.1203847665858314e-05, 7.4143083186512694e-06, -3.0975718857423525e-07, -8.422338422005537e-05, 0.00023235493789050006, -0.00023467141519908338, 0.00010483606682514023, -1.917807829036152e-05, 8.32661604426344e-07, 6.790575669682924e-05, -0.00018873750157339303, 0.00019272477125548108, -0.2914624783668664, 0.17706010908221417, -0.10987095681874964, -1.7244007410141856e-05, 4.905241305643968e-05, 0.2193502955927016, 0.3109133841003373, -0.10253223964503098, 0.5687207608392387, -5.829286169138561e-07, 0.1186499445146606, -0.48834330718409685, 0.288474089528956, -0.6734955359050514, -1.6281257440902783, -1.4502237711850525, 4.05286898845943, -4.076345910825925, 1.8309158579321727, 1.4537154499885054, 0.5750259138305435],
    freeze: [0.8866751131221295, 10.756515672562976, -40.21662328260015, -4.259421842862747, -18.368354031262914, 0.0003056561085975434]
  }
};

// Facility (water) loop: rho*cp in J/(m^3 K) and the film-coefficient group,
// as polynomials in temperature. Fits to CoolProp Water at 300 kPa, 2.7e-4 %.
export const RC_PRI = [7.005571912629277e-07, -0.00020353176220472646, 0.026246869157615704, -1.9271441162086773, 78.2735421654597, -3059.193152727693, 4218007.657748665];
export const PH_PRI = [1.4005718700326837e-07, -3.819092066196206e-05, 0.004013370044200002, -0.6872062551669611, 218.31930882818543, 13979.291181203396];

export const N_EXP = 0.7;      // chevron-plate Re exponent
export const DP_GLY = 1.19;    // glycol pressure-drop penalty vs water at equal flow

/**
 * Everything a site gets to choose. The defaults ARE the original tool:
 * 500 kW, PG25, an ASHRAE W27 facility loop, 360 devices at 0.012 K/W,
 * anchored to a 3 K design approach.
 */
export const SITE_DEFAULTS = {
  fluid: 'MPG',    // server-loop glycol: MPG or MEG
  conc: 25,        // % by mass, 0-60
  tFws: 18,        // facility water supply, degC
  qDes: 500,       // CDU design capacity, kW
  approach: 3,     // design approach, K (the vendor-cited figure)
  dtSecDes: 8,     // design rack rise, K
  dtPriDes: 10,    // design facility rise, K
  nDev: 360,       // devices served
  rCp: 0.012,      // per-device cold-plate resistance, K/W
  tTrip: 90,       // die throttle setpoint, degC
  rackDtMax: 8,    // site target: rack delta-T at most this, K
  facDtMin: 12,    // site target: facility delta-T at least this, K
};

/** Server-loop properties at t degC for the site's mixture. SI where it counts. */
export function secProps(site, t){
  const F = GLY[site.fluid] || GLY.MPG;
  const tn = t / 50, cn = site.conc / 60;
  const rho = poly2(F.rho, tn, cn);            // kg/m3
  const cp  = poly2(F.cp,  tn, cn) * 1000;     // J/(kg K)
  const k   = poly2(F.k,   tn, cn);            // W/(m K)
  const mu  = Math.exp(poly2(F.mu, tn, cn)) / 1000; // Pa.s (fit is log mPa.s)
  return { rho, cp, k, mu,
    rc: rho * cp,
    phi: Math.pow(k, 2/3) * Math.pow(cp, 1/3) * Math.pow(rho, N_EXP) * Math.pow(mu, 1/3 - N_EXP) };
}

/** Freeze point of the site's mixture, degC. */
export function freezeC(site){
  const F = GLY[site.fluid] || GLY.MPG;
  return poly(F.freeze, site.conc / 60);
}

/** Facility-loop property group at t degC (water). */
function priProps(t){
  const rc = poly(RC_PRI, t);
  return { rc, phi: poly(PH_PRI, t) };
}

/**
 * Anchor the plate-pack geometry to the site's design point -- the same
 * derivation tools/cdu_reference.py used to produce the original K_GEO and
 * R_WALL: design capacity split across the two loop rises, effectiveness from
 * the design approach, NTU inverted from counterflow epsilon, wall taken as
 * 5 % of the total resistance, and the geometric constant K shared by both
 * films. Design means sit at tFws+12 and tFws+5, which is 30 / 23 degC at the
 * original W27 supply -- the exact means the original anchor used.
 */
export function anchor(site){
  const Q = site.qDes * 1000;
  const Cs = Q / site.dtSecDes, Cp = Q / site.dtPriDes;
  const ps = secProps(site, site.tFws + 12), pp = priProps(site.tFws + 5);
  // K is derived from the UNROUNDED design flows — exactly the derivation
  // tools/cdu_reference.py ran, so the default site reproduces the original
  // K_GEO to every digit. The RETURNED flows are rounded to the sliders'
  // 10 L/min step: the design preset must be a reachable slider position, and
  // the pump curve normalizes to it, so an unrounded design would read x1.01
  // at its own preset. At the default site this lands on the original 940/720.
  const vsRaw = Cs / ps.rc * 60000, vpRaw = Cp / pp.rc * 60000;
  const VsD = Math.max(10, Math.round(vsRaw / 10) * 10);
  const VpD = Math.max(10, Math.round(vpRaw / 10) * 10);
  const G = Q / (site.approach + site.dtSecDes);
  const Cmin = Math.min(Cs, Cp), cr = Cmin / Math.max(Cs, Cp);
  const eps = G / Cmin;
  const x = (1 - eps) / (1 - eps * cr);
  const ntu = -Math.log(x) / (1 - cr);
  const Rtot = Cmin * ntu === 0 ? Infinity : 1 / (ntu * Cmin);
  const Rw = 0.05 * Rtot;
  const K = (1 / (ps.phi * Math.pow(vsRaw, N_EXP)) + 1 / (pp.phi * Math.pow(vpRaw, N_EXP))) / (Rtot - Rw);
  return { K, Rw, VsD, VpD };
}

/**
 * Steady-state solve at a site. Vs, Vp in L/min; qW in W.
 * The geometry may be passed in to avoid re-anchoring per call.
 */
export function solve(site, Vs, Vp, qW, geo){
  const g = geo || anchor(site);
  let Tsm = site.tFws + 12, Tpm = site.tFws + 5;
  let Cs, Cp, UA, Cmin, cr, ntu, e, G, q, hotIn, hotOut, facOut, chip;
  for (let i = 0; i < 10; i++){
    const ps = secProps(site, Tsm), pp = priProps(Tpm);
    Cs = Vs / 60000 * ps.rc;
    Cp = Vp / 60000 * pp.rc;
    UA = 1 / (1 / (g.K * ps.phi * Math.pow(Vs, N_EXP)) + g.Rw
            + 1 / (g.K * pp.phi * Math.pow(Vp, N_EXP)));
    Cmin = Math.min(Cs, Cp);
    cr   = Cmin / Math.max(Cs, Cp);
    ntu  = UA / Cmin;
    if (cr > 0.9995) e = ntu / (1 + ntu);
    else { const x = Math.exp(-ntu * (1 - cr)); e = (1 - x) / (1 - cr * x); }
    G = e * Cmin;
    // the hottest die sits at the rack OUTLET and sees its own cold-plate rise on top
    q = Math.min(qW, (site.tTrip - site.tFws) / (1 / G + site.rCp / site.nDev));
    hotIn  = site.tFws + q / G;
    hotOut = hotIn - q / Cs;
    facOut = site.tFws + q / Cp;
    chip   = hotIn + (q / site.nDev) * site.rCp;
    Tsm = (hotIn + hotOut) / 2;
    Tpm = (facOut + site.tFws) / 2;
  }
  return { e, ntu, cr, G, q, demand: qW, throttled: q < qW - 1,
           hotIn, hotOut, facOut, chip,
           rackDT: hotIn - hotOut, facDT: facOut - site.tFws, approach: hotOut - site.tFws,
           Qsec: Cs * (hotIn - hotOut), Qpri: Cp * (facOut - site.tFws),
           pump: (DP_GLY * Math.pow(Vs / g.VsD, 3) + Math.pow(Vp / g.VpD, 3)) / (DP_GLY + 1) };
}
