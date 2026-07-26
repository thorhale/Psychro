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
await page.waitForTimeout(800);

// 1. Self-test badge
const badge = await page.textContent('#selftest-badge');
console.log('BADGE:', badge.trim());

// 2. Open the Sensor Validation card and exercise it
await page.click('#sv-summary');
await page.fill('#sv-db', '75');
await page.fill('#sv-wb', '62');
await page.waitForTimeout(100);
console.log('RES(75/62F):', (await page.textContent('#sv-res')).trim());
console.log('SUMMARY:', (await page.textContent('#sv-summary')).trim());

// cross-check with an independent computation in-page (round trip via wetBulb)
const check = await page.evaluate(() => {
  const p = state.pressure;
  const rh = rhFromWetBulb(fToC(75), fToC(62), p);
  const wbBack = cToF(wetBulb(fToC(75), rh, p));
  return { rh: rh.toFixed(3), wbBack: wbBack.toFixed(4), pressure: p.toFixed(2) };
});
console.log('ROUNDTRIP:', JSON.stringify(check));

// 3. Sensor deviation verdicts
await page.fill('#sv-rh', String((parseFloat(check.rh) + 1.0).toFixed(1)));
console.log('VERDICT(+1%):', (await page.textContent('#sv-res')).includes('PASS') ? 'PASS shown' : 'MISSING PASS');
await page.fill('#sv-rh', String((parseFloat(check.rh) + 8.0).toFixed(1)));
console.log('VERDICT(+8%):', (await page.textContent('#sv-res')).includes('FAIL') ? 'FAIL shown' : 'MISSING FAIL');

// 4. Impossible reading
await page.fill('#sv-wb', '80');
console.log('IMPOSSIBLE:', (await page.textContent('#sv-res')).includes('impossible') ? 'warned' : 'NOT WARNED');
await page.fill('#sv-wb', '62');

// 5. Unit toggle re-displays boxes in °C
await page.click('#unit-toggle .unit-btn[data-unit="C"]');
await page.waitForTimeout(100);
console.log('C BOXES: db=', await page.inputValue('#sv-db'), 'wb=', await page.inputValue('#sv-wb'));
console.log('RES(°C):', (await page.textContent('#sv-res')).trim());
await page.click('#unit-toggle .unit-btn[data-unit="F"]');

// 6. Set as Current
await page.click('#sv-to-current');
const cur = await page.evaluate(() => ({ aTemp: state.aTemp, aRH: state.aRH.toFixed(1) }));
console.log('SET CURRENT:', JSON.stringify(cur));

console.log('PAGE ERRORS:', errors.length ? errors : 'none');
await browser.close();
