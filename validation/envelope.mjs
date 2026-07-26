import { chromium } from 'playwright';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
const __dir = dirname(fileURLToPath(import.meta.url));
const PAGE = 'file://' + join(__dir, '..', 'index.html');
const EXE = process.env.CHROMIUM_PATH || undefined;   // unset => Playwright's own build

const ref=JSON.parse(readFileSync(join(__dir,'coolprop_ref2.json'),'utf8'));
const b = await chromium.launch({ executablePath: EXE });
const pg=await b.newPage(); await pg.goto(PAGE); await pg.waitForTimeout(600);
console.log(await pg.evaluate((ref)=>{
  const bands=[['RH>=8% (ASHRAE A1-A4 floor)',r=>r.rh>=8],['RH 1-8% (below any envelope)',r=>r.rh<8]];
  const lines=[];
  for(const [nm,f] of bands){
    let mx=0,w='',n=0,s=0;
    for(const r of ref.rows){
      if(r.p<65||!f(r)) continue;
      const e=wetBulb(r.tc,r.rh,r.p)-r.Twb; n++; s+=Math.abs(e);
      if(Math.abs(e)>Math.abs(mx)){mx=e;w=`${r.tc}C ${r.rh}% ${r.p}kPa`;}
    }
    lines.push(`${nm}: n=${n} max ${mx.toPrecision(4)} mean ${(s/n).toPrecision(3)} @ ${w}`);
  }
  // the outlier, in detail
  const tc=15,rh=1,P=65;
  const W=humidityRatio(vaporPressure(tc,rh),P,tc);
  lines.push(`\n15C/1%/65kPa: our twb=${wetBulb(tc,rh,P).toFixed(4)}  W=${(W*1000).toFixed(5)} g/kg`);
  lines.push(`  ice-branch top W*(0-) = ${(wetBulbW(tc,-1e-12,P)*1000).toFixed(5)} g/kg  -> ${W>wetBulbW(tc,-1e-12,P)?'water':'ice'} branch chosen`);
  for(const t of [-12,-10,-8,-6,-4]) lines.push(`  W*(${t}) = ${(wetBulbW(tc,t,P)*1000).toFixed(5)}`);
  return lines.join('\n');
},ref));
await b.close();
