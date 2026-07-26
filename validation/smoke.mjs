import { chromium } from 'playwright';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
const __dir = dirname(fileURLToPath(import.meta.url));
const PAGE = 'file://' + join(__dir, '..', 'index.html');
const EXE = process.env.CHROMIUM_PATH || undefined;   // unset => Playwright's own build

const b = await chromium.launch({ executablePath: EXE });
const p=await b.newPage(); const errs=[];
p.on('pageerror',e=>errs.push(e.message)); p.on('console',m=>{if(m.type()==='error')errs.push(m.text());});
await p.goto(PAGE); await p.waitForTimeout(700);
console.log('SELFTEST:',(await p.textContent('#selftest-badge')).trim());
// perf
console.log('PERF:', await p.evaluate(()=>{
  let t=performance.now(); for(let i=0;i<30;i++) drawChart(); const d=(performance.now()-t)/30;
  t=performance.now(); for(let i=0;i<20000;i++) dewPoint(1.5+(i%100)*0.01,101.325,25); const dp=(performance.now()-t)/20000;
  t=performance.now(); for(let i=0;i<20000;i++) satPressure(-30+(i%80)); const sp=(performance.now()-t)/20000;
  t=performance.now(); for(let i=0;i<5000;i++) wetBulb(10+(i%30),20+(i%60),101.325); const wb=(performance.now()-t)/5000;
  return `drawChart ${d.toFixed(2)}ms · dewPoint ${(dp*1000).toFixed(2)}µs · satPressure ${(sp*1000).toFixed(2)}µs · wetBulb ${(wb*1000).toFixed(1)}µs`;
}));
// psychrometer vs thermodynamic toggle
await p.click('#sv-summary');
await p.fill('#sv-db','75'); await p.fill('#sv-wb','62'); await p.waitForTimeout(80);
console.log('PSY (default):', (await p.textContent('#sv-res')).trim().slice(0,60));
await p.selectOption('#sv-method','thermo'); await p.waitForTimeout(80);
console.log('THERMO       :', (await p.textContent('#sv-res')).trim().slice(0,60));
await p.selectOption('#sv-method','psy');
// exercise UI broadly for runtime errors
for (const id of ['slider-a-temp','slider-a-dp','slider-a-rh','slider-b-temp','slider-b-dp','slider-b-rh']) {
  for (const v of [20,45,70,95]) await p.evaluate(([i,x])=>{const e=document.getElementById(i);e.value=x;e.dispatchEvent(new Event('input',{bubbles:true}));},[id,v]);
}
await p.evaluate(()=>{ state.pressure=pressureFromAltitude(11000); applyElevation&&0; update(); });
const tbl = await p.evaluate(()=>document.querySelectorAll('#tableBody tr').length);
console.log('table rows after stress:', tbl);
const nan = await p.evaluate(()=>document.body.innerText.match(/NaN|undefined/g));
console.log('NaN/undefined in DOM:', nan ? nan.slice(0,5) : 'none');
console.log('ERRORS:', errs.length?errs:'none');
await b.close();
