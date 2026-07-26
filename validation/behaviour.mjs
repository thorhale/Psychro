import { chromium } from 'playwright';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
const __dir = dirname(fileURLToPath(import.meta.url));
const PAGE = 'file://' + join(__dir, '..', 'index.html');
const EXE = process.env.CHROMIUM_PATH || undefined;   // unset => Playwright's own build

const browser = await chromium.launch({ executablePath: EXE });
const page = await browser.newPage();
const errors = [];
page.on('pageerror', e => errors.push(e.message));
page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
await page.goto(PAGE);
await page.waitForTimeout(700);

console.log('BADGE:', (await page.textContent('#selftest-badge')).trim());
const fails = await page.evaluate(() => runSelfTest().cases.filter(c=>!c.pass).map(c=>`${c.name}: got ${c.got} ref ${c.ref} tol ${c.tol}`));
console.log('FAILING:', fails.length ? fails : 'none');

// Row order within each control group
const order = await page.evaluate(() =>
  [...document.querySelectorAll('.ctl-a .ctl-row, .ctl-b .ctl-row')].map(r => r.querySelector('.ctl-k').textContent));
console.log('ROW ORDER:', order.join(' | '));

// --- Behaviour: temp holds dew point, drives RH ---
const beh = await page.evaluate(() => {
  const snap = () => ({
    t: +state.aTemp.toFixed(2), rh: +state.aRH.toFixed(2),
    dp: +dpF_from(state.aTemp, state.aRH).toFixed(3),
    W: +(humidityRatioG(vaporPressure(fToC(state.aTemp), state.aRH), state.pressure, fToC(state.aTemp))).toFixed(4),
  });
  const fire = (id, val) => { const el = document.getElementById(id); el.value = val; el.dispatchEvent(new Event('input', {bubbles:true})); };
  const out = {};
  state.aTemp = 70; state.aRH = 45; syncAllControls(); update();
  out.start = snap();
  fire('slider-a-temp', 85);           // temp up: DP + W must hold, RH must fall
  out.afterTempUp = snap();
  fire('slider-a-temp', 70);           // back down: must return to start
  out.afterTempBack = snap();
  fire('slider-a-dp', 40);             // DP down at fixed temp: temp holds, RH falls
  out.afterDpDown = snap();
  fire('slider-a-rh', 60);             // RH direct: temp holds, DP rises
  out.afterRhSet = snap();
  return out;
});
console.log('BEHAVIOUR:');
for (const [k,v] of Object.entries(beh)) console.log('  ', k.padEnd(15), JSON.stringify(v));

// Ratchet test: 40 temp drags back and forth must not drift RH
const ratchet = await page.evaluate(() => {
  const fire = (id, val) => { const el = document.getElementById(id); el.value = val; el.dispatchEvent(new Event('input', {bubbles:true})); };
  state.aTemp = 70; state.aRH = 45; syncAllControls(); update();
  const rh0 = state.aRH, dp0 = dpF_from(state.aTemp, state.aRH);
  for (let i = 0; i < 20; i++) { fire('slider-a-temp', 95); fire('slider-a-temp', 70); }
  return { rhDrift: +(state.aRH - rh0).toExponential(2), dpDrift: +(dpF_from(state.aTemp,state.aRH) - dp0).toExponential(2) };
});
console.log('RATCHET (40 drags):', JSON.stringify(ratchet));

// Saturation guard: cool below the dew point
const sat = await page.evaluate(() => {
  const fire = (id, val) => { const el = document.getElementById(id); el.value = val; el.dispatchEvent(new Event('input', {bubbles:true})); };
  state.aTemp = 80; state.aRH = 80; syncAllControls(); update();
  const dpBefore = dpF_from(state.aTemp, state.aRH);
  fire('slider-a-temp', 60);   // well below the dew point
  return { dpBefore: +dpBefore.toFixed(2), t: state.aTemp, rh: +state.aRH.toFixed(2), dpAfter: +dpF_from(state.aTemp,state.aRH).toFixed(2) };
});
console.log('BELOW DEW POINT:', JSON.stringify(sat));

// Dry-air dew point no longer pinned at the 32F floor
const dry = await page.evaluate(() => {
  state.aTemp = 68; state.aRH = 1; syncAllControls(); update();
  return { trueDp: +dpF_from(68,1).toFixed(2), sliderVal: document.getElementById('slider-a-dp').value, box: document.getElementById('a-dp').value };
});
console.log('DRY AIR DP:', JSON.stringify(dry));

console.log('PAGE ERRORS:', errors.length ? errors : 'none');
await browser.close();
