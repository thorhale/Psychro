import { chromium } from 'playwright';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
const __dir = dirname(fileURLToPath(import.meta.url));
const PAGE = 'file://' + join(__dir, '..', 'index.html');
const EXE = process.env.CHROMIUM_PATH || undefined;   // unset => Playwright's own build

const ref = JSON.parse(readFileSync(join(__dir,'coolprop_ref2.json'), 'utf8'));
const browser = await chromium.launch({ executablePath: EXE });
const page = await browser.newPage();
await page.goto(PAGE);
await page.waitForTimeout(700);

const res = await page.evaluate((ref) => {
  const mk = () => ({ n:0, sum:0, max:0, worst:'' });
  const add = (s,e,c) => { s.n++; s.sum+=Math.abs(e); if(Math.abs(e)>Math.abs(s.max)){s.max=e;s.worst=c;} };
  const fin = s => s.n ? {mean:+(s.sum/s.n).toPrecision(3), max:+s.max.toPrecision(4), worst:s.worst} : null;

  const out = { sat: {} };
  // Saturation pressure vs IAPWS (relative %)
  for (const r of ref.sat) {
    const band = r.tc >= 0.01 ? 'water' : 'ice';
    (out.sat[band] ||= mk());
    add(out.sat[band], (satPressure(r.tc)-r.ref)/r.ref*100, `${r.tc}C`);
  }
  for (const k in out.sat) out.sat[k] = fin(out.sat[k]);

  // Everything else, banded by pressure realism
  const bands = { 'real 65-125kPa': p => p>=65, 'extreme 22kPa': p => p<65 };
  out.props = {};
  const savedP = state.pressure;
  for (const [bn, test] of Object.entries(bands)) {
    const S = { Wrel:mk(), Tdp:mk(), Twb:mk(), H:mk(), Vda:mk(), roundtrip:mk(), enhF:mk() };
    for (const r of ref.rows) {
      if (!test(r.p)) continue;
      state.pressure = r.p;
      const c = `${r.tc}C ${r.rh}% ${r.p}kPa`;
      const pw = vaporPressure(r.tc, r.rh);
      const W = humidityRatio(pw, r.p, r.tc);
      if (r.W > 1e-5) add(S.Wrel, (W-r.W)/r.W*100, c);
      const dp = dewPoint(pw, r.p, r.tc); if (dp!=null) add(S.Tdp, dp-r.Tdp, c);
      add(S.Twb, wetBulb(r.tc,r.rh,r.p)-r.Twb, c);
      add(S.H, enthalpy(r.tc,W,r.p)-r.H, c);
      add(S.Vda, (specificVolume(r.tc,W,r.p)-r.Vda)/r.Vda*100, c);
      add(S.roundtrip, rhFromW_F(cToF(r.tc), W)-r.rh, c);
    }
    for (const e of ref.enh) if (test(e.p)) add(S.enhF, (enhancementFactor(e.tc,e.p)-e.f)/e.f*100, `${e.tc}C ${e.p}kPa`);
    out.props[bn] = Object.fromEntries(Object.entries(S).map(([k,v])=>[k,fin(v)]));
  }
  state.pressure = savedP;
  return out;
}, ref);

console.log('SATURATION PRESSURE vs IAPWS (% relative)');
for (const [k,v] of Object.entries(res.sat)) console.log(`  ${k.padEnd(6)} mean ${String(v.mean).padStart(10)}  max ${String(v.max).padStart(10)}  @ ${v.worst}`);
const U = { Wrel:'% rel', Tdp:'°C', Twb:'°C', H:'kJ/kg', Vda:'% rel', roundtrip:'% RH', enhF:'% rel' };
for (const [band, S] of Object.entries(res.props)) {
  console.log(`\n${band.toUpperCase()}`);
  for (const [k,v] of Object.entries(S)) if (v) console.log(`  ${k.padEnd(10)} ${U[k].padEnd(7)} mean ${String(v.mean).padStart(10)}  max ${String(v.max).padStart(10)}  @ ${v.worst}`);
}
await browser.close();
