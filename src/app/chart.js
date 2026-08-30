/**
 * The psychrometric chart: drawing it, and moving around it.
 *
 * Drawing and navigation live together because they share the view window —
 * `view` is what the renderer reads and what zoom, pan and the fit buttons
 * write. Splitting them would mean exporting that mutable window across a
 * module boundary, which is the same coupling with more ceremony.
 *
 * `PC` is the full data extent (the "fit" view); `view` is the live zoom
 * window; `lastGeom` is the pixel geometry of the last frame, which is what
 * lets a pointer position be turned back into a temperature and a humidity
 * ratio. All three are deliberately private to this module.
 */

import { state } from './state.js';
import { dispTs, disp1, tLabel, fmtSlaReason } from '../ui/format.js';
import { fToC, cToF } from '../core/units.js';
import { saturationHumidityRatio, wetBulb } from '../core/psychro.js';
import { ASHRAE_ENVELOPES, envelopePolygon, slaPolygon } from '../core/envelopes.js';
import { fmtHrs } from '../core/planner.js';
import { deriveState } from '../core/derive.js';
import { inp, canvasEl } from '../ui/dom.js';

/**
 * What only the entry point can answer: the live plan, the moisture model,
 * the input clamps, and how to push a changed point back into the controls.
 */
/**
 * @type {{
 *   planMove: (opts?: object) => any,
 *   rhAtPoint: (tc: number, hrG: number) => {rh: number},
 *   humidityRatioG: (tc: number, rh: number, p: number) => number,
 *   checkSLA: (tempF: number, rh: number) => {ok: boolean, kind?: string|null, bound?: number, detail?: string},
 *   clampF: (v: number) => number,
 *   clampRH: (v: number) => number,
 *   clampTargetF: (v: number) => number,
 *   syncAllControls: () => void,
 *   update: () => void,
 *   actualTrail: () => any,
 *   playback: () => {f: number, playing: boolean, raf: number},
 * }}
 */
let shell = {
  planMove: () => null,
  rhAtPoint: () => ({ rh: 0 }),
  humidityRatioG: () => 0,
  checkSLA: () => ({ ok: true }),
  clampF: (v) => v, clampRH: (v) => v, clampTargetF: (v) => v,
  syncAllControls: () => {}, update: () => {},
  actualTrail: () => null,
  playback: () => ({ f: 0, playing: false, raf: 0 }),
};

/** Hand this module the few things only the entry point can do. */
export function wireChart(callbacks) {
  shell = { ...shell, ...callbacks };
}

// ════════════════════════════════════════════════════════════
//  CHART
//  PC = full data extent (the "fit" view). view = live zoom window.
// ════════════════════════════════════════════════════════════
// Chart extent: anchored at freezing (0°C / 32°F) on the left, through the full
// ASHRAE A4 allowable ceiling on the right (45°C / 113°F). This frames the data-
// center operating range so envelopes fill the plot instead of floating in dead space.
const PC = { tMin:0, tMax:45, hrMin:0, hrMax:30 };
const view = { tMin:0, tMax:45, hrMin:0, hrMax:30 };  // mutated by zoom/pan
let lastGeom = null;  // {W,H,pad} from last drawChart, for hit-testing

function resetView() {
  view.tMin = PC.tMin; view.tMax = PC.tMax;
  view.hrMin = PC.hrMin; view.hrMax = PC.hrMax;
}

function toXY(tc, hr, W, H, pad) {
  const x = pad.l + (tc-view.tMin)/(view.tMax-view.tMin)*(W-pad.l-pad.r);
  const y = (H-pad.b) - (hr-view.hrMin)/(view.hrMax-view.hrMin)*(H-pad.t-pad.b);
  return [x,y];
}
// inverse: pixel → data (for zoom-at-cursor and pan)
function fromXY(px, py, W, H, pad) {
  const tc = view.tMin + (px-pad.l)/(W-pad.l-pad.r)*(view.tMax-view.tMin);
  const hr = view.hrMin + ((H-pad.b)-py)/(H-pad.t-pad.b)*(view.hrMax-view.hrMin);
  return [tc, hr];
}
// "nice" tick step for a given span and target tick count
// Decimal places needed so adjacent tick VALUES are actually distinguishable —
// scales with how fine the step gets, instead of capping out at a fixed
// precision (which made deep-zoom ticks show duplicate rounded numbers).
function decimalsFor(step) {
  if (!(step > 0)) return 0;
  return Math.max(0, Math.min(3, Math.ceil(-Math.log10(step) - 1e-9)));
}
function tickStep(span, target) {
  const raw = span / target;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const norm = raw / mag;
  const nice = norm < 1.5 ? 1 : norm < 3 ? 2 : norm < 7 ? 5 : 10;
  return nice * mag;
}

// Find a legible spot to label a curve, GIVEN THE CURRENT VIEWPORT — not a
// fixed data coordinate. Curves get zoomed/panned in and out of view, so a
// label anchored to one fixed point disappears whenever that point scrolls
// off-screen. Instead: sample the curve, find the longest run of points that
// actually falls inside the plot rectangle right now, and label its midpoint.
// Returns null if the curve isn't visible at all (correctly no label then).
function labelSpotOnCurve(pxPts, plotL, plotR, plotT, plotB) {
  const margin = 4; // keep labels off the very edge of the plot
  let bestStart = -1, bestLen = 0, curStart = -1, curLen = 0;
  for (let i = 0; i < pxPts.length; i++) {
    const [x, y] = pxPts[i];
    const inside = x >= plotL + margin && x <= plotR - margin && y >= plotT + margin && y <= plotB - margin;
    if (inside) {
      if (curStart < 0) curStart = i;
      curLen++;
      if (curLen > bestLen) { bestLen = curLen; bestStart = curStart; }
    } else { curStart = -1; curLen = 0; }
  }
  if (bestLen === 0) return null;
  const mid = bestStart + Math.floor(bestLen / 2);
  const [x, y] = pxPts[mid];
  // local slope for a faint text tilt so the label rides along the curve
  const a = pxPts[Math.max(0, mid - 3)], b = pxPts[Math.min(pxPts.length - 1, mid + 3)];
  const angle = Math.atan2(b[1] - a[1], b[0] - a[0]);
  return { x, y, angle };
}
// Draw a label with a halo (outline) so it stays legible over grid lines,
// other curves, or shaded envelopes — regardless of what's underneath.
function haloText(ctx, text, x, y, color, angle) {
  ctx.save();
  ctx.translate(x, y);
  if (angle) ctx.rotate(angle);
  ctx.lineWidth = 3;
  ctx.strokeStyle = 'rgba(13,17,23,0.9)';
  ctx.lineJoin = 'round';
  ctx.strokeText(text, 0, 0);
  ctx.fillStyle = color;
  ctx.fillText(text, 0, 0);
  ctx.restore();
}

/**
 * The static layer cache.
 *
 * A CPU profile of a slider drag put `drawChart` at 44 % of all self-time,
 * ahead of every canvas primitive combined. Almost none of that work depends
 * on where Current and Target are: the grid, the constant-RH curves, the
 * wet-bulb and specific-volume families, the ASHRAE envelopes and the SLA
 * polygon are all functions of the VIEW, the site pressure, and which legend
 * items are on. Dragging a temperature slider recomputed every one of them,
 * saturation pressures and all, sixty times a second.
 *
 * So that half of the frame is rendered once into an offscreen canvas and
 * blitted afterwards. The key below must name every input the static half
 * reads — the failure mode of getting it wrong is a chart that quietly stops
 * updating, which is worse than a slow one. `test/e2e/visual.spec.js` changes
 * each keyed input in turn and asserts the pixels actually move, which tests
 * that exact failure directly.
 */
let staticLayer = null;
let staticKey = '';
/**
 * True while a pan or pinch is moving the view every frame.
 *
 * The cache is a straight loss in that case: the key misses on every frame, so
 * we would pay for an offscreen render AND a blit to produce something used
 * once. Measured, that took panning from 3.3 ms to ~5.9 ms a frame. During a
 * gesture the static half is drawn straight to the visible canvas instead, and
 * the cache is left cold so the first settled frame rebuilds it.
 */
let viewIsLive = false;
/** @param {boolean} live */
export function setViewLive(live) {
  viewIsLive = live;
  if (live) { staticLayer = null; staticKey = ''; }
}


/** Everything the cached half reads. Anything absent here is a staleness bug. */
function staticLayerKey(W, H, dpr, p) {
  const sla = /** @type {any} */ (state.slaProfiles[state.activeSla] || {});
  return [
    W, H, dpr, p,
    view.tMin, view.tMax, view.hrMin, view.hrMax,
    // Legend state, in a fixed order so the string is stable.
    ...['Rec', 'A1', 'A2', 'A3', 'A4', 'SLA', 'specvol', 'enthalpy'].map(
      (k) => (state.visible[k] ? 1 : 0),
    ),
    // The SLA polygon follows the active contract's bounds, not just its index.
    state.activeSla, sla.tMinF, sla.tMaxF, sla.rhMin, sla.rhMax, sla.dpMaxF,
  ].join('|');
}


/**
 * Everything whose appearance is fixed by the view, the site pressure and the
 * legend — grid, saturation and constant-RH curves, the wet-bulb and
 * specific-volume families, the ASHRAE envelopes, the active SLA polygon.
 *
 * Lifted verbatim out of drawChart so it can be rendered into an offscreen
 * canvas and reused. It takes its context as a parameter (shadowing the name
 * the body already used) and its geometry as a bag, so the body itself is
 * unchanged — which is what makes the pixel-equality test meaningful.
 */
function drawStaticLayer(ctx, geom) {
  const { W, H, p, plotL, plotR, plotT, plotB, xy, fs } = geom;
  ctx.fillStyle = '#0d1117'; ctx.fillRect(0, 0, W, H);
  ctx.save();
  ctx.beginPath(); ctx.rect(plotL, plotT, plotR - plotL, plotB - plotT); ctx.clip();

  // Tick steps from the live view span
  const tStep  = Math.max(1, tickStep(view.tMax - view.tMin, 9));
  const hrStep = Math.max(1, tickStep(view.hrMax - view.hrMin, 8));
  const tStart  = Math.ceil(view.tMin / tStep) * tStep;
  const hrStart = Math.ceil(view.hrMin / hrStep) * hrStep;

  // Grid
  ctx.strokeStyle='rgba(255,255,255,0.06)'; ctx.lineWidth=0.5;
  for(let t=tStart; t<=view.tMax; t+=tStep){const[x1,y1]=xy(t,view.hrMin),[x2,y2]=xy(t,view.hrMax);ctx.beginPath();ctx.moveTo(x1,y1);ctx.lineTo(x2,y2);ctx.stroke();}
  for(let hr=hrStart; hr<=view.hrMax; hr+=hrStep){const[x1,y1]=xy(view.tMin,hr),[x2,y2]=xy(view.tMax,hr);ctx.beginPath();ctx.moveTo(x1,y1);ctx.lineTo(x2,y2);ctx.stroke();}

  // Freezing reference line (0°C / 32°F) — a hard operational boundary.
  // Vertical line at t=0°C; only visible if the view includes it.
  if (view.tMin <= 0 && view.tMax >= 0) {
    const [fx, fyTop] = xy(0, view.hrMax);
    const [, fyBot] = xy(0, view.hrMin);
    ctx.strokeStyle = 'rgba(120,170,255,0.35)'; ctx.lineWidth = 1.2; ctx.setLineDash([5,4]);
    ctx.beginPath(); ctx.moveTo(fx, fyTop); ctx.lineTo(fx, fyBot); ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = 'rgba(120,170,255,0.6)'; ctx.font = `bold ${fs(0.0105)}px sans-serif`;
    ctx.textAlign = 'left'; ctx.save();
    ctx.translate(fx + 3, plotT + 4 + fs(0.05));
    ctx.fillText('FREEZING 32°F', 0, 0); ctx.restore();
  }

  // Drawing range follows the VISIBLE view (with margin) so curves fill out
  // toward "infinity" on the top and right rather than stopping at a fixed wall.
  const drawTmin = Math.max(PC.tMin, view.tMin - 2);
  const drawTmax = Math.min(MAX_T, view.tMax + 2);
  const drawHrMax = Math.min(MAX_HR, view.hrMax + 2);

  // ── Dynamic curve density: how many RH / wet-bulb lines actually fall in
  // the CURRENT viewport, so zooming in shows finer spacing instead of the
  // same fixed 10%/5° lines (which thin out to zero or one line visible).
  // Sample RH at the view's four corners — RH is monotonic in T (down) and
  // in humidity ratio (up), so the corners bound the range reliably.
  const rhAtCorner = (tc, hrG) =>
    Math.min(100, Math.max(0, shell.rhAtPoint(tc, hrG).rh));
  const corners = [
    [view.tMin, view.hrMin], [view.tMin, view.hrMax],
    [view.tMax, view.hrMin], [view.tMax, view.hrMax],
  ];
  const cornerRH = corners.map(([tc, hr]) => rhAtCorner(tc, hr));
  const rhSpan = Math.max(0.5, Math.max(...cornerRH) - Math.min(...cornerRH));
  const rhStep = Math.max(1, Math.min(20, tickStep(rhSpan, 9)));
  const rhLo = Math.max(0, Math.floor(Math.min(...cornerRH) / rhStep) * rhStep - rhStep);
  const rhHi = Math.min(100, Math.ceil(Math.max(...cornerRH) / rhStep) * rhStep + rhStep);
  const rhList = [];
  for (let rh = rhLo; rh <= rhHi; rh += rhStep) rhList.push(Math.round(rh));
  if (!rhList.includes(80)) rhList.push(80);    // always keep the ASHRAE-ish warning line
  if (!rhList.includes(100)) rhList.push(100);  // always keep the saturation line
  rhList.sort((a,b)=>a-b);

  // Wet-bulb corners use the same viewport, solved via the exact Eq. 35 binary search.
  const wbAtCorner = (tc, hr) => wetBulb(tc, rhAtCorner(tc, hr), p);
  const cornerWB = corners.map(([tc, hr]) => wbAtCorner(tc, hr));
  const wbSpan = Math.max(0.5, Math.max(...cornerWB) - Math.min(...cornerWB));
  const wbStep = Math.max(1, Math.min(5, tickStep(wbSpan, 7)));
  const wbLo = Math.max(-10, Math.floor(Math.min(...cornerWB) / wbStep) * wbStep - wbStep);
  const wbHi = Math.min(50, Math.ceil(Math.max(...cornerWB) / wbStep) * wbStep + wbStep);

  // RH iso-curves (pressure-aware) — density adapts to the current zoom.
  rhList.forEach(rh => {
    const rhColor = rh===100?'rgba(100,180,255,0.85)':rh===80?'rgba(248,81,73,0.5)':`rgba(80,130,200,${0.15+rh*0.002})`;
    const rhLabelColor = rh===100?'#8fc4ff':rh===80?'#ff8a80':'#7fa8e0';
    ctx.strokeStyle = rhColor;
    ctx.lineWidth = (rh===80||rh===100)?1.6:0.7;
    ctx.beginPath(); let started=false;
    const tStepCurve = (drawTmax-drawTmin)/400;
    const pxPts = [];   // pixel points along this curve, for viewport-aware labeling
    for(let t=drawTmin;t<=drawTmax;t+=tStepCurve){
      const hr2=shell.humidityRatioG(t,rh,p);
      const[x,y]=xy(t,hr2);
      pxPts.push([x,y]);
      if(!started){ctx.moveTo(x,y);started=true;}else ctx.lineTo(x,y);
      if(hr2>drawHrMax) break; // one point past the top; clip handles the trim
    }
    ctx.stroke();
    // Label wherever this curve is actually visible in the CURRENT viewport —
    // not a fixed data point — so it stays legible at any zoom/pan position.
    const spot = labelSpotOnCurve(pxPts, plotL, plotR, plotT, plotB);
    if (spot) {
      ctx.font = `bold ${fs(0.0115)}px sans-serif`;
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      haloText(ctx, rh+'%', spot.x, spot.y - 9, rhLabelColor, 0);
    }
  });

  // Wet-bulb iso-lines — EXACT ASHRAE Eq. 35, same physics as the table.
  // For a fixed wet-bulb twb, W at dry-bulb t is solved forward from Eq. 35:
  //   W = ((2501 − 2.326·twb)·Ws* − 1.006·(t − twb)) / (2501 + 1.86·t − 4.186·twb)   (t,twb ≥ 0°C)
  //   W = ((2830 − 0.24·twb)·Ws* − 1.006·(t − twb)) / (2830 + 1.86·t − 2.1·twb)       (twb < 0°C, over ice)
  // where Ws* = saturation humidity ratio at twb and site pressure.
  // Density (wbStep) adapts to the current zoom, same as the RH curves above.
  ctx.strokeStyle='rgba(120,180,120,0.16)'; ctx.lineWidth=0.6;
  ctx.font=`${fs(0.0095)}px sans-serif`;
  const wbDec = wbStep < 1 ? 1 : 0;
  for(let wb=wbLo; wb<=wbHi; wb+=wbStep){
    const WsStar = saturationHumidityRatio(wb, p); // kg/kg at the wet-bulb temp
    ctx.beginPath(); let s=false;
    const tStepWb=(drawTmax-wb)/200 || 0.4;
    const pxPtsWb = [];
    for(let t=wb; t<=drawTmax; t+=tStepWb){
      let W;
      if (wb >= 0)
        W = ((2501 - 2.326*wb)*WsStar - 1.006*(t - wb)) / (2501 + 1.86*t - 4.186*wb);
      else
        W = ((2830 - 0.24*wb)*WsStar - 1.006*(t - wb)) / (2830 + 1.86*t - 2.1*wb);
      const hrT = W*1000; // g/kg
      if(hrT < 0) break;
      const[x,y]=xy(t,hrT);
      pxPtsWb.push([x,y]);
      if(!s){ctx.moveTo(x,y);s=true;}else ctx.lineTo(x,y);
      if(hrT > drawHrMax) break;
    }
    ctx.stroke();
    // Label wherever this wet-bulb line is actually visible right now.
    if(s){
      const spot = labelSpotOnCurve(pxPtsWb, plotL, plotR, plotT, plotB);
      if (spot) {
        ctx.font = `${fs(0.0098)}px sans-serif`;
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        haloText(ctx, `${wb.toFixed(wbDec)}°wb`, spot.x, spot.y, 'rgba(150,210,150,0.85)', spot.angle);
      }
    }
  }

  // Constant specific-volume iso-lines (m³/kg dry air) — ASHRAE Eq. 26 solved
  // for W at fixed v:  W = (v·p/(Rda·T) − 1) / 1.607858.  Steeper than the RH
  // curves, so they read as a distinct family. Toggleable via the legend.
  if (state.visible.specvol) {
    const Rda = 0.287042;
    ctx.strokeStyle = 'rgba(210,180,120,0.22)'; ctx.lineWidth = 0.6;
    for (let v = 0.74; v <= 1.02 + 1e-9; v += 0.02) {
      ctx.beginPath(); let s = false; const pxPts = [];
      const tStepV = (drawTmax - drawTmin) / 200;
      for (let t = drawTmin; t <= drawTmax; t += tStepV) {
        const Tk = t + 273.15;
        const Wg = ((v * p / (Rda * Tk)) - 1) / 1.607858 * 1000; // g/kg
        if (Wg < -0.5) continue;
        const [x, y] = xy(t, Math.max(0, Wg));
        pxPts.push([x, y]);
        if (!s) { ctx.moveTo(x, y); s = true; } else ctx.lineTo(x, y);
      }
      ctx.stroke();
      if (s) {
        const spot = labelSpotOnCurve(pxPts, plotL, plotR, plotT, plotB);
        if (spot) { ctx.font = `${fs(0.0092)}px sans-serif`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
          haloText(ctx, `${v.toFixed(2)} m³/kg`, spot.x, spot.y, 'rgba(216,192,136,0.9)', spot.angle); }
      }
    }
  }

  // Constant-enthalpy iso-lines (kJ/kg dry air) — chart GUIDES only, drawn from
  // ASHRAE Eq. 30's closed-form inverse. Displayed/tabulated h uses the RP-1485
  // fit in the core; the two differ by <0.5 kJ/kg, invisible at chart scale,
  // and the closed form is invertible per-pixel where the fit is not.
  // Eq. 30 solved for W at
  // fixed h:  W = (h − 1.006·t) / (2501 + 1.86·t).  Nearly parallel to the
  // wet-bulb lines (that's the psychrometrics), so OFF by default; legend-toggle.
  if (state.visible.enthalpy) {
    ctx.strokeStyle = 'rgba(170,140,230,0.24)'; ctx.lineWidth = 0.6;
    for (let hh = 0; hh <= 140; hh += 10) {
      ctx.beginPath(); let s = false; const pxPts = [];
      const tStepH = (drawTmax - drawTmin) / 200;
      for (let t = drawTmin; t <= drawTmax; t += tStepH) {
        const Wg = (hh - 1.006 * t) / (2501 + 1.86 * t) * 1000; // g/kg
        if (Wg < -0.5) continue;
        const [x, y] = xy(t, Math.max(0, Wg));
        pxPts.push([x, y]);
        if (!s) { ctx.moveTo(x, y); s = true; } else ctx.lineTo(x, y);
        if (Wg > drawHrMax) break;
      }
      ctx.stroke();
      if (s) {
        const spot = labelSpotOnCurve(pxPts, plotL, plotR, plotT, plotB);
        if (spot) { ctx.font = `${fs(0.0092)}px sans-serif`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
          haloText(ctx, `${hh} kJ/kg`, spot.x, spot.y, 'rgba(184,166,232,0.9)', spot.angle); }
      }
    }
  }

  // Envelopes (generated from constraints, pressure-aware)
  function drawPolygon(pts,color,lw,label,dash,alpha){
    if(dash) ctx.setLineDash([4,3]); else ctx.setLineDash([]);
    ctx.strokeStyle=color; ctx.lineWidth=lw;
    ctx.globalAlpha=alpha!=null?alpha:0.06; ctx.fillStyle=color;
    ctx.beginPath(); const[sx,sy]=xy(pts[0][0],pts[0][1]); ctx.moveTo(sx,sy);
    pts.slice(1).forEach(pt=>{const[ex,ey]=xy(pt[0],pt[1]);ctx.lineTo(ex,ey);}); ctx.closePath(); ctx.fill();
    ctx.globalAlpha=1;
    ctx.beginPath(); const[sx2,sy2]=xy(pts[0][0],pts[0][1]); ctx.moveTo(sx2,sy2);
    pts.slice(1).forEach(pt=>{const[ex,ey]=xy(pt[0],pt[1]);ctx.lineTo(ex,ey);}); ctx.closePath(); ctx.stroke();
    ctx.setLineDash([]);
    if(label){
      // Label wherever the boundary is actually visible right now, not a fixed
      // vertex — so it stays legible at any zoom/pan position, same as curves.
      const pxPtsPoly = pts.map(pt => xy(pt[0], pt[1]));
      const spot = labelSpotOnCurve(pxPtsPoly, plotL, plotR, plotT, plotB);
      if (spot) {
        ctx.font = `bold ${fs(0.013)}px sans-serif`;
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        haloText(ctx, label, spot.x, spot.y, color, 0);
      }
    }
  }

  // ASHRAE envelopes — each drawn only if individually visible
  ['A4','A3','A2','A1'].forEach(k=>{
    if (!state.visible[k]) return;
    const e=ASHRAE_ENVELOPES[k];
    drawPolygon(envelopePolygon(e,p), e.color, e.lw, e.label, false);
  });
  if (state.visible.Rec) {
    const rec=ASHRAE_ENVELOPES.Rec;
    drawPolygon(envelopePolygon(rec,p),'rgba(255,255,255,0.5)',1.4,'Rec',true,0.04);
  }

  // ── Active SLA (bold white) — toggleable ─────────────────
  const sla = state.slaProfiles[state.activeSla];
  if (state.visible.SLA) {
  const slaPts = slaPolygon(sla, p);
  ctx.setLineDash([6,4]); ctx.strokeStyle='rgba(255,255,255,0.85)'; ctx.lineWidth=2.2;
  ctx.globalAlpha=0.05; ctx.fillStyle='#ffffff';
  ctx.beginPath(); let[s0x,s0y]=xy(slaPts[0][0],slaPts[0][1]); ctx.moveTo(s0x,s0y);
  slaPts.slice(1).forEach(pt=>{const[ex,ey]=xy(pt[0],pt[1]);ctx.lineTo(ex,ey);}); ctx.closePath(); ctx.fill();
  ctx.globalAlpha=1;
  ctx.beginPath(); [s0x,s0y]=xy(slaPts[0][0],slaPts[0][1]); ctx.moveTo(s0x,s0y);
  slaPts.slice(1).forEach(pt=>{const[ex,ey]=xy(pt[0],pt[1]);ctx.lineTo(ex,ey);}); ctx.closePath(); ctx.stroke();
  ctx.setLineDash([]);
  // SLA label — wherever the boundary is actually visible right now.
  const slaPxPts = slaPts.map(pt => xy(pt[0], pt[1]));
  const slaSpot = labelSpotOnCurve(slaPxPts, plotL, plotR, plotT, plotB);
  if (slaSpot) {
    ctx.font = `bold ${fs(0.012)}px sans-serif`;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    haloText(ctx, 'SLA', slaSpot.x, slaSpot.y, 'rgba(255,255,255,0.9)', 0);
  }
  } // end SLA visibility

  ctx.restore();
}

export function drawChart() {
  const p = state.pressure;
  const canvas = canvasEl('psychCanvas');
  const dispW = canvas.parentElement.clientWidth || 800;
  const dpr = Math.min(2, window.devicePixelRatio||1);
  const W = dispW, H = Math.round(W*0.62);
  // Assigning width/height reallocates the backing store, so only do it when
  // the size really changed — drawChart runs on every input event and every
  // animation frame. That assignment also used to reset the transform and
  // clear the bitmap for free, so when it is skipped both must be done
  // explicitly: setTransform (not scale, which would compound each frame)
  // and an explicit clear.
  const bw = Math.round(W*dpr), bh = Math.round(H*dpr);
  const resized = canvas.width !== bw || canvas.height !== bh;
  if (resized) { canvas.width = bw; canvas.height = bh; }
  canvas.style.width = W+'px'; canvas.style.height = H+'px';
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  if (!resized) ctx.clearRect(0, 0, W, H);
  const pad = {l:52,r:58,t:20,b:42};
  lastGeom = { W, H, pad };
  const xy = (tc,hr) => toXY(tc,hr,W,H,pad);
  const fs = sz => Math.max(9, Math.round(W*sz));

  const plotL=pad.l, plotR=W-pad.r, plotT=pad.t, plotB=H-pad.b;

  // ── Static layer: everything that depends on the view, the pressure and the
  // legend, but not on where Current and Target sit. Rendered once, blitted
  // after. `chartCacheEnabled` exists so a test can render both ways and
  // compare pixels — see test/e2e/visual.spec.js.
  const key = staticLayerKey(W, H, dpr, p);
  if (viewIsLive) {
    // Straight to the visible canvas: nothing would be reused anyway.
    drawStaticLayer(ctx, { W, H, p, plotL, plotR, plotT, plotB, xy, fs });
  } else {
  const reuse = staticLayer !== null && staticKey === key
    && staticLayer.width === bw && staticLayer.height === bh;
  if (!reuse) {
    if (!staticLayer || staticLayer.width !== bw || staticLayer.height !== bh) {
      staticLayer = document.createElement('canvas');
      staticLayer.width = bw; staticLayer.height = bh;
    }
    const sctx = staticLayer.getContext('2d');
    sctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    sctx.clearRect(0, 0, W, H);
    drawStaticLayer(sctx, { W, H, p, plotL, plotR, plotT, plotB, xy, fs });
    staticKey = key;
  }
  // Blit 1:1 against the backing store. Drawing it as (0,0,W,H) while the
  // context carries the dpr transform makes the browser resample a 2x bitmap
  // every frame, which cost more than the drawing it replaced — panning, where
  // the key misses on every frame, went from 3.3 ms to 6.0 ms. At identity
  // transform it is a straight copy.
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.drawImage(staticLayer, 0, 0);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  } // end cached path

  // The dynamic half runs under the same clip the static half used.
  ctx.save();
  ctx.beginPath(); ctx.rect(plotL, plotT, plotR-plotL, plotB-plotT); ctx.clip();
  // Points
  const tcA=fToC(state.aTemp), hrA=shell.humidityRatioG(tcA,state.aRH,p);
  // ── Actual trajectory from an imported BMS trend (legend-toggleable) ──
  // Drawn beneath the plan line and the points: reality is context, the plan
  // is the argument.
  if (state.visible.actual && shell.actualTrail() && shell.actualTrail().rows.length > 1) {
    ctx.strokeStyle = 'rgba(57,210,192,0.9)';
    ctx.lineWidth = 2;
    ctx.setLineDash([]);
    ctx.beginPath();
    // Break the line at data gaps (> 3× the median sample interval): a
    // six-hour comms dropout drawn as a straight line looks exactly like a
    // measured, perfectly linear move — the one lie an overlay must not tell.
    const gapMs = Math.max(3 * (shell.actualTrail().medianStepMs || 0), 1);
    shell.actualTrail().rows.forEach((r, i) => {
      const tcR = fToC(r.tempF);
      const [px, py] = xy(tcR, shell.humidityRatioG(tcR, r.rh, p));
      if (i === 0 || r.time - shell.actualTrail().rows[i - 1].time > gapMs) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    });
    ctx.stroke();
    const end = shell.actualTrail().rows[shell.actualTrail().rows.length - 1];
    const tcE = fToC(end.tempF);
    const [ex, ey] = xy(tcE, shell.humidityRatioG(tcE, end.rh, p));
    ctx.beginPath(); ctx.arc(ex, ey, 4.5, 0, Math.PI * 2);
    ctx.fillStyle = '#39d2c0'; ctx.fill();
    ctx.strokeStyle = '#0d1117'; ctx.lineWidth = 1.5; ctx.stroke();
  }

  const[axp,ayp]=xy(tcA,hrA);
  const tcB=fToC(state.bTemp), hrB=shell.humidityRatioG(tcB,state.bRH,p);
  const[bxp,byp]=xy(tcB,hrB);

  // ── A→B change plan line + arrow (toggleable) ──
  if (state.visible.plan) {
    ctx.strokeStyle='rgba(255,110,240,0.6)'; ctx.lineWidth=1.5; ctx.setLineDash([3,3]);
    ctx.beginPath(); ctx.moveTo(axp,ayp); ctx.lineTo(bxp,byp); ctx.stroke(); ctx.setLineDash([]);
    const dist=Math.sqrt((bxp-axp)**2+(byp-ayp)**2);
    if(dist>12){
      const ang=Math.atan2(byp-ayp,bxp-axp); ctx.fillStyle='rgba(255,110,240,0.8)';
      ctx.beginPath(); ctx.moveTo(bxp,byp);
      ctx.lineTo(bxp-10*Math.cos(ang-0.38),byp-10*Math.sin(ang-0.38));
      ctx.lineTo(bxp-10*Math.cos(ang+0.38),byp-10*Math.sin(ang+0.38));
      ctx.closePath(); ctx.fill();
    }

    // ── Hourly time-points along the move, paced by the core planner ──
    // Same SLA-limit × plant-capacity model as the readout, so they agree.
    if (state.visible.timepts) {
      const totalH = shell.planMove().hours;
      if (totalH > 0 && dist > 20) {
        // place a tick at each whole hour (the per-hour ramp boundary)
        const nTicks = Math.floor(totalH);
        ctx.fillStyle='rgba(255,110,240,0.95)'; ctx.strokeStyle='#0d1117';
        ctx.font=`bold ${fs(0.0092)}px monospace`; ctx.textAlign='center';
        for (let h=1; h<=nTicks; h++) {
          const f = h / totalH;                       // fraction along A→B
          const px = axp + (bxp-axp)*f, py = ayp + (byp-ayp)*f;
          ctx.beginPath(); ctx.arc(px,py,3.5,0,Math.PI*2); ctx.fill();
          ctx.lineWidth=1; ctx.stroke();
          ctx.fillStyle='rgba(255,150,245,0.85)';
          ctx.fillText(`${h}h`, px, py-7);
          ctx.fillStyle='rgba(255,110,240,0.95)';
        }
        // total-time label at the midpoint, offset perpendicular to the line
        const mx=(axp+bxp)/2, my=(ayp+byp)/2;
        const ang=Math.atan2(byp-ayp,bxp-axp);
        const ox=Math.sin(ang)*14, oy=-Math.cos(ang)*14;
        ctx.fillStyle='rgba(255,150,245,0.9)'; ctx.font=`bold ${fs(0.0105)}px sans-serif`;
        ctx.fillText(`≈ ${fmtHrs(totalH)}`, mx+ox, my+oy);
      }
    }

    // ── Ramp-playback marker: the hall "now", scrubbed or animated ──
    // Same pixel-space interpolation as the pacing ticks above, so the marker
    // rides exactly the line the ticks sit on.
    if (shell.playback().f > 0) {
      const px = axp + (bxp - axp) * shell.playback().f, py = ayp + (byp - ayp) * shell.playback().f;
      ctx.beginPath(); ctx.arc(px, py, 8, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(255,255,255,0.95)'; ctx.fill();
      ctx.strokeStyle = 'rgba(255,110,240,1)'; ctx.lineWidth = 3; ctx.stroke();
    }
  }

  function drawDot(cx,cy,color,top,bot,above){
    ctx.beginPath(); ctx.arc(cx,cy,7,0,Math.PI*2); ctx.fillStyle=color; ctx.fill();
    ctx.strokeStyle='#0d1117'; ctx.lineWidth=2; ctx.stroke();
    const ly = above?cy-13:cy+20;
    ctx.fillStyle=color; ctx.font=`bold ${fs(0.013)}px sans-serif`; ctx.textAlign='center'; ctx.fillText(top,cx,ly);
    ctx.font=`${fs(0.010)}px sans-serif`; ctx.fillStyle=color+'aa'; ctx.fillText(bot,cx,ly+12);
  }
  drawDot(axp,ayp,'#ffff00',`A  ${disp1(state.aRH)}% RH`,`${disp1(state.aTemp)}°F / ${disp1(tcA)}°C`,true);
  drawDot(bxp,byp,'#f0a500',`B  ${disp1(state.bRH)}% RH`,`${disp1(state.bTemp)}°F / ${disp1(tcB)}°C`,byp>ayp+20);

  // End clip — axes/labels live in the margins, outside the plot rect
  ctx.restore();

  // Axes
  ctx.strokeStyle='rgba(255,255,255,0.3)'; ctx.lineWidth=1.5;
  ctx.beginPath(); ctx.moveTo(pad.l,pad.t); ctx.lineTo(pad.l,H-pad.b); ctx.lineTo(W-pad.r,H-pad.b); ctx.stroke();
  ctx.fillStyle='rgba(255,255,255,0.4)'; ctx.font=`${fs(0.012)}px monospace`; ctx.textAlign='center';
  const tStep2  = Math.max(1, tickStep(view.tMax - view.tMin, 9));
  const hrStep2 = Math.max(1, tickStep(view.hrMax - view.hrMin, 8));
  const tDec  = decimalsFor(tStep2);
  const hrDec = decimalsFor(hrStep2);
  for(let t=Math.ceil(view.tMin/tStep2)*tStep2; t<=view.tMax; t+=tStep2){
    const[x]=xy(t,view.hrMin);
    ctx.strokeStyle='rgba(255,255,255,0.15)';ctx.lineWidth=0.8;ctx.beginPath();ctx.moveTo(x,H-pad.b);ctx.lineTo(x,H-pad.b+4);ctx.stroke();
    ctx.fillStyle='rgba(255,255,255,0.4)';ctx.fillText(t.toFixed(tDec),x,H-pad.b+15);
  }
  ctx.textAlign='right';
  for(let hr=Math.ceil(view.hrMin/hrStep2)*hrStep2; hr<=view.hrMax; hr+=hrStep2){
    const[,y]=xy(view.tMin,hr);
    ctx.strokeStyle='rgba(255,255,255,0.15)';ctx.lineWidth=0.8;ctx.beginPath();ctx.moveTo(pad.l,y);ctx.lineTo(pad.l-4,y);ctx.stroke();
    ctx.fillStyle='rgba(255,255,255,0.4)';ctx.fillText(hr.toFixed(hrDec),pad.l-6,y+4);
  }
  ctx.fillStyle='rgba(255,255,255,0.4)'; ctx.font=`${fs(0.013)}px sans-serif`; ctx.textAlign='center';
  ctx.fillText('Dry Bulb Temperature (°C)',pad.l+(W-pad.l-pad.r)/2,H-5);
  ctx.save(); ctx.translate(14,pad.t+(H-pad.t-pad.b)/2); ctx.rotate(-Math.PI/2); ctx.textAlign='center'; ctx.fillText('Humidity Ratio g/kg dry air',0,0); ctx.restore();

  // Pressure stamp + zoom indicator (top-left)
  ctx.fillStyle='rgba(240,165,0,0.7)'; ctx.font=`bold ${fs(0.012)}px monospace`; ctx.textAlign='left';
  const trunc = (s, n) => { s = s || ''; return s.length > n ? s.slice(0, n - 1) + '…' : s; };
  const stampCtx = [trunc(state.hall.name, 22), trunc(state.slaProfiles[state.activeSla].name, 22)].filter(Boolean).join(' · ');
  ctx.fillText(`${stampCtx}${stampCtx ? ' · ' : ''}${(state.hall.elevFt ?? 0).toLocaleString()} ft · ${p.toFixed(2)} kPa`, pad.l+6, pad.t+14);
  const zoomed = !(view.tMin===PC.tMin && view.tMax===PC.tMax && view.hrMin===PC.hrMin && view.hrMax===PC.hrMax);
  if (zoomed) {
    const zx = (PC.tMax-PC.tMin)/(view.tMax-view.tMin);
    ctx.fillStyle='rgba(59,158,255,0.85)';
    ctx.fillText(`⊕ ${zx.toFixed(1)}× — scroll/pinch to zoom · drag to pan · dbl-click to reset`, pad.l+6, pad.t+28);
  }
}
// ════════════════════════════════════════════════════════════
//  CHART ZOOM & PAN  (independent of page scroll)
//  The plot is anchored at freezing (0°C) and W=0 on the lower-left,
//  but extends without a hard wall up (humidity ratio) and right
//  (temperature) — curves are drawn across whatever the view shows.
// ════════════════════════════════════════════════════════════
const MIN_T_SPAN = 0.4, MIN_HR_SPAN = 0.2;  // tightest zoom in — fine enough for sub-degree/sub-g work
const MAX_T = 200, MAX_HR = 200;           // effective "infinity" ceiling for drawing
function clampView() {
  // ── The safety net. ──────────────────────────────────────────────────────
  // Every zoom and pan path writes to `view` and then calls this, so this is
  // the one place that can guarantee the window stays drawable. If any corner
  // has gone non-finite the whole chart renders as NaN coordinates: no
  // envelopes, no curves, not even gridlines or axes — a blank rectangle with
  // no way back except the Fit button, which nobody knows to look for.
  //
  // It got there through a pinch. Two fingers reported at the SAME point for
  // one frame make `pinchDist / d` divide by zero, and Infinity times a zero
  // offset (an anchor sitting exactly on an edge) is NaN. That is guarded at
  // the source below, but guarding it here as well is what makes the class of
  // bug impossible rather than just that one instance of it fixed.
  if (![view.tMin, view.tMax, view.hrMin, view.hrMax].every(Number.isFinite)
      || view.tMax <= view.tMin || view.hrMax <= view.hrMin) {
    resetView();
    return;
  }

  // tightest zoom
  if (view.tMax - view.tMin < MIN_T_SPAN) { const c=(view.tMin+view.tMax)/2; view.tMin=c-MIN_T_SPAN/2; view.tMax=c+MIN_T_SPAN/2; }
  if (view.hrMax - view.hrMin < MIN_HR_SPAN) { const c=(view.hrMin+view.hrMax)/2; view.hrMin=c-MIN_HR_SPAN/2; view.hrMax=c+MIN_HR_SPAN/2; }
  // anchor the lower-left at the physical floor (freezing-ish / dry air),
  // but allow the top and right to run far out toward "infinity"
  if (view.tMin < PC.tMin) { const span=view.tMax-view.tMin; view.tMin=PC.tMin; view.tMax=PC.tMin+span; }
  if (view.hrMin < PC.hrMin) { const span=view.hrMax-view.hrMin; view.hrMin=PC.hrMin; view.hrMax=PC.hrMin+span; }
  if (view.tMax > MAX_T) view.tMax = MAX_T;
  if (view.hrMax > MAX_HR) view.hrMax = MAX_HR;
}

function zoomAt(px, py, factor) {
  if (!lastGeom) return;
  const { W, H, pad } = lastGeom;
  // A zoom factor arrives from a wheel notch, a button, or the ratio of two
  // pinch distances — and that last one can be Infinity (fingers reported at
  // the same point) or NaN. Bound it to something a person could mean.
  if (!Number.isFinite(factor) || factor <= 0) return;
  factor = Math.min(Math.max(factor, 0.02), 50);
  // A plot rectangle with no width or height makes fromXY divide by zero. It
  // happens for a frame while a card is opening, which is exactly when a
  // finger is on the glass.
  if (W - pad.l - pad.r <= 0 || H - pad.t - pad.b <= 0) return;
  // anchor zoom on the data point under the cursor
  const [atc, ahr] = fromXY(px, py, W, H, pad);
  if (!Number.isFinite(atc) || !Number.isFinite(ahr)) return;
  view.tMin = atc - (atc - view.tMin) * factor;
  view.tMax = atc + (view.tMax - atc) * factor;
  view.hrMin = ahr - (ahr - view.hrMin) * factor;
  view.hrMax = ahr + (view.hrMax - ahr) * factor;
  clampView();
  drawChart();
}

function zoomCenter(factor) {
  if (!lastGeom) return;
  const { W, H, pad } = lastGeom;
  zoomAt((pad.l + W - pad.r)/2, (pad.t + H - pad.b)/2, factor);
}

function zoomToSLA() {
  const sla = state.slaProfiles[state.activeSla];
  const pts = slaPolygon(sla, state.pressure);
  let tmin=Infinity,tmax=-Infinity,hmin=Infinity,hmax=-Infinity;
  pts.forEach(([t,h])=>{ tmin=Math.min(tmin,t);tmax=Math.max(tmax,t);hmin=Math.min(hmin,h);hmax=Math.max(hmax,h); });
  const tpad=(tmax-tmin)*0.25+1, hpad=(hmax-hmin)*0.25+0.5;
  view.tMin=tmin-tpad; view.tMax=tmax+tpad; view.hrMin=Math.max(0,hmin-hpad); view.hrMax=hmax+hpad;
  clampView(); drawChart();
}

// Frame the A→B change plan: fit both points with margin so the move fills the view.
function zoomToPlan() {
  const p = state.pressure;
  const tA=fToC(state.aTemp), wA=shell.humidityRatioG(tA,state.aRH,p);
  const tB=fToC(state.bTemp), wB=shell.humidityRatioG(tB,state.bRH,p);
  const tmin=Math.min(tA,tB), tmax=Math.max(tA,tB);
  const hmin=Math.min(wA,wB), hmax=Math.max(wA,wB);
  const tspan=Math.max(tmax-tmin,4), hspan=Math.max(hmax-hmin,3);
  const tpad=tspan*0.4+1, hpad=hspan*0.5+1;
  view.tMin=tmin-tpad; view.tMax=tmax+tpad;
  view.hrMin=Math.max(0,hmin-hpad); view.hrMax=hmax+hpad;
  clampView(); drawChart();
}

// Center the current view on the midpoint of A and B without changing zoom level.
function centerView() {
  const p = state.pressure;
  const tA=fToC(state.aTemp), wA=shell.humidityRatioG(tA,state.aRH,p);
  const tB=fToC(state.bTemp), wB=shell.humidityRatioG(tB,state.bRH,p);
  const cT=(tA+tB)/2, cW=(wA+wB)/2;
  const tHalf=(view.tMax-view.tMin)/2, hHalf=(view.hrMax-view.hrMin)/2;
  view.tMin=cT-tHalf; view.tMax=cT+tHalf;
  view.hrMin=cW-hHalf; view.hrMax=cW+hHalf;
  clampView(); drawChart();
}

(function attachChartInteractions(){
  const canvas = canvasEl('psychCanvas');
  function localXY(e){
    const r = canvas.getBoundingClientRect();
    const cx = (e.touches ? e.touches[0].clientX : e.clientX) - r.left;
    const cy = (e.touches ? e.touches[0].clientY : e.clientY) - r.top;
    return [cx, cy];
  }
  // Wheel zoom — preventDefault stops the PAGE from scrolling
  canvas.addEventListener('wheel', (e)=>{
    e.preventDefault();
    const [px,py] = localXY(e);
    zoomAt(px, py, e.deltaY < 0 ? 0.88 : 1/0.88);
    updateHover(px, py);   // keep the inspector in sync with the new view
  }, { passive:false });

  // ── Hover inspector: crosshair + live psychrometric readout ──
  // Mouse: follows the cursor. Touch: a still tap pins it, the next tap (or
  // any pan/pinch) dismisses it — a phone in the hall could previously only
  // pan and zoom while the hint promised hover and modifier clicks.
  const vline = inp('ch-vline');
  const hline = inp('ch-hline');
  const tip   = inp('chart-tip');
  function hideHover() {
    if (vline) vline.style.display = 'none';
    if (hline) hline.style.display = 'none';
    if (tip)   tip.style.display = 'none';
  }
  function updateHover(px, py) {
    if (dragging || !lastGeom || !tip) { hideHover(); return; }
    const { W, H, pad } = lastGeom;
    if (px < pad.l || px > W - pad.r || py < pad.t || py > H - pad.b) { hideHover(); return; }
    const [tc, hr] = fromXY(px, py, W, H, pad);
    const { rh } = shell.rhAtPoint(tc, hr);
    const p = state.pressure;
    const tF = cToF(tc);
    let body;
    if (rh > 100.001) {
      body = `<div class="tt-head">${dispTs(tF)}${tLabel()} · fog</div>
        <div class="tt-row"><span class="tt-k">W</span><span>${hr.toFixed(2)} g/kg</span></div>
        <div class="tt-sla" style="color:var(--warn)">above saturation — supersaturated</div>`;
    } else {
      const d = deriveState(tc, rh, p);
      const dpC = d.tdpC, wbC = d.twbC, h = d.h, zone = d.zone;
      const chk = shell.checkSLA(tF, rh);
      body = `<div class="tt-head">${dispTs(tF)}${tLabel()} · ${disp1(rh)}% RH</div>
        <div class="tt-row"><span class="tt-k">W</span><span>${hr.toFixed(2)} g/kg</span></div>
        <div class="tt-row"><span class="tt-k">Dew pt</span><span>${dpC != null ? dispTs(cToF(dpC)) + ' ' + tLabel() : '—'}</span></div>
        <div class="tt-row"><span class="tt-k">Wet bulb</span><span>${dispTs(cToF(wbC))} ${tLabel()}</span></div>
        <div class="tt-row"><span class="tt-k">Enthalpy</span><span>${h.toFixed(1)} kJ/kg</span></div>
        <div class="tt-row"><span class="tt-k">ASHRAE</span><span class="zpill z${zone}">${zone}</span></div>
        <div class="tt-sla" style="color:${chk.ok ? 'var(--ok)' : 'var(--danger)'}">${chk.ok ? '✓ within SLA' : '✗ ' + fmtSlaReason(chk)}</div>`;
    }
    tip.innerHTML = body;
    vline.style.cssText = `display:block; left:${px}px; top:${pad.t}px; height:${H - pad.t - pad.b}px;`;
    hline.style.cssText = `display:block; top:${py}px; left:${pad.l}px; width:${W - pad.l - pad.r}px;`;
    tip.style.display = 'block';
    // flip the tooltip to whichever side of the cursor has room
    const tw = tip.offsetWidth || 170, th = tip.offsetHeight || 120;
    tip.style.left = (px + 16 + tw > W ? px - tw - 14 : px + 16) + 'px';
    tip.style.top  = Math.max(2, Math.min(py - th / 2, H - th - 2)) + 'px';
  }
  canvas.addEventListener('mousemove', (e)=>{ const [px,py]=localXY(e); updateHover(px,py); });
  canvas.addEventListener('mouseleave', hideHover);

  // Drag to pan · a still click (<5px travel) with a modifier SETS a point:
  // Shift-click places Target, Alt-click places Current — plan by pointing.
  let dragging=false, lastPx=0, lastPy=0, dragDist=0;
  canvas.addEventListener('mousedown', (e)=>{ dragging=true; setViewLive(true); dragDist=0; [lastPx,lastPy]=localXY(e); canvas.classList.add('grabbing'); hideHover(); });
  window.addEventListener('mousemove', (e)=>{
    if(!dragging||!lastGeom) return;
    const r=canvas.getBoundingClientRect();
    const px=e.clientX-r.left, py=e.clientY-r.top;
    const { W,H,pad }=lastGeom;
    const dT=(px-lastPx)/(W-pad.l-pad.r)*(view.tMax-view.tMin);
    const dH=(py-lastPy)/(H-pad.t-pad.b)*(view.hrMax-view.hrMin);
    view.tMin-=dT; view.tMax-=dT; view.hrMin+=dH; view.hrMax+=dH; // y inverted
    dragDist += Math.abs(px-lastPx)+Math.abs(py-lastPy);
    lastPx=px; lastPy=py; drawChart();
  });
  window.addEventListener('mouseup', (e)=>{
    if (dragging) setViewLive(false); // the view has settled; cache again
    if (dragging && dragDist < 5 && (e.shiftKey || e.altKey) && lastGeom) {
      const { W, H, pad } = lastGeom;
      if (lastPx >= pad.l && lastPx <= W - pad.r && lastPy >= pad.t && lastPy <= H - pad.b) {
        const [tc, hr] = fromXY(lastPx, lastPy, W, H, pad);
        const { rh } = shell.rhAtPoint(tc, hr);
        const tF = cToF(tc);
        if (e.shiftKey) { state.bTemp = shell.clampTargetF(tF); state.bRH = shell.clampRH(rh); }
        else            { state.aTemp = shell.clampF(tF);       state.aRH = shell.clampRH(rh); }
        shell.syncAllControls(); shell.update();
      }
    }
    dragging=false; canvas.classList.remove('grabbing');
  });

  // Double-click reset
  canvas.addEventListener('dblclick', (e)=>{ e.preventDefault(); resetView(); drawChart(); });

  // Keyboard: the canvas has always been in the tab order, but every
  // interaction (pan, zoom, inspect) was pointer-only — so a keyboard user
  // tabbed into a dead stop. Arrows pan by a tenth of the view, +/- zoom
  // about the centre, 0 resets. The aria-label advertises exactly this.
  canvas.addEventListener('keydown', (e) => {
    const panBy = (fx, fy) => {
      const dT = (view.tMax - view.tMin) * 0.1 * fx;
      const dH = (view.hrMax - view.hrMin) * 0.1 * fy;
      view.tMin += dT; view.tMax += dT; view.hrMin += dH; view.hrMax += dH;
    };
    switch (e.key) {
      case 'ArrowLeft': panBy(-1, 0); break;
      case 'ArrowRight': panBy(1, 0); break;
      case 'ArrowUp': panBy(0, 1); break;
      case 'ArrowDown': panBy(0, -1); break;
      case '+': case '=': zoomCenter(0.8); return e.preventDefault();
      case '-': case '_': zoomCenter(1 / 0.8); return e.preventDefault();
      case '0': resetView(); break;
      default: return;
    }
    e.preventDefault();
    drawChart();
  });

  // Touch: pinch zoom + one-finger pan; a still tap pins the inspector.
  let pinchDist=0, pinchMid=null, touchPan=null;
  let tapStart=null, tapTravel=0, tipPinned=false;
  canvas.addEventListener('touchstart',(e)=>{
    if(e.touches.length===2){
      e.preventDefault();
      pinchDist=touchDistance(e); pinchMid=touchMidpoint(e, canvas);
      tapStart=null; hideHover(); tipPinned=false;
      setViewLive(true);
    } else if(e.touches.length===1){
      const [px,py]=localXY(e); touchPan=[px,py];
      tapStart=[px,py]; tapTravel=0;
      // A single touch may become a pan; a tap that never moves costs one
      // uncached frame, which is the cheaper mistake.
      setViewLive(true);
    }
  },{passive:false});
  canvas.addEventListener('touchmove',(e)=>{
    if(e.touches.length===2){
      e.preventDefault();
      const d=touchDistance(e);
      // d === 0 means both contacts came back at the same coordinate, which is
      // not a pinch — dividing by it is how the view used to go non-finite and
      // the chart went blank.
      if(pinchDist>0 && d>0 && pinchMid){ zoomAt(pinchMid[0],pinchMid[1], pinchDist/d); }
      if(d>0){ pinchDist=d; pinchMid=touchMidpoint(e,canvas); }
    } else if(e.touches.length===1 && touchPan && lastGeom){
      e.preventDefault();
      const r=canvas.getBoundingClientRect();
      const px=e.touches[0].clientX-r.left, py=e.touches[0].clientY-r.top;
      const {W,H,pad}=lastGeom;
      if (W-pad.l-pad.r <= 0 || H-pad.t-pad.b <= 0) return;
      const dT=(px-touchPan[0])/(W-pad.l-pad.r)*(view.tMax-view.tMin);
      const dH=(py-touchPan[1])/(H-pad.t-pad.b)*(view.hrMax-view.hrMin);
      view.tMin-=dT; view.tMax-=dT; view.hrMin+=dH; view.hrMax+=dH;
      clampView(); //  a pan must go through the safety net like a zoom does
      tapTravel += Math.abs(px-touchPan[0]) + Math.abs(py-touchPan[1]);
      if (tapTravel >= 8) { hideHover(); tipPinned = false; }
      touchPan=[px,py]; drawChart();
    }
  },{passive:false});
  canvas.addEventListener('touchend',(e)=>{
    setViewLive(false);
    if(e.touches.length===1){
      // Lifting one finger out of a pinch: re-seed the pan origin from the
      // finger still down, or the next move pans by the whole distance from
      // where the FIRST finger originally landed and the chart jumps.
      const r=canvas.getBoundingClientRect();
      touchPan=[e.touches[0].clientX-r.left, e.touches[0].clientY-r.top];
      pinchDist=0; pinchMid=null; tapStart=null;
    }
    if(e.touches.length===0){
      // A tap that never really moved: toggle the pinned inspector at that
      // spot. preventDefault stops the browser's synthetic mousedown/mouseup
      // replay, whose mousedown handler would hide the tip we just pinned.
      if (tapStart && tapTravel < 8) {
        e.preventDefault();
        if (tipPinned) { hideHover(); tipPinned = false; }
        else { updateHover(tapStart[0], tapStart[1]); tipPinned = !!(tip && tip.style.display === 'block'); }
      }
      pinchDist=0; touchPan=null; tapStart=null;
    }
  },{passive:false});

  function touchDistance(e){ const a=e.touches[0],b=e.touches[1]; return Math.hypot(a.clientX-b.clientX,a.clientY-b.clientY); }
  function touchMidpoint(e,canvas){ const r=canvas.getBoundingClientRect(); const a=e.touches[0],b=e.touches[1]; return [((a.clientX+b.clientX)/2)-r.left, ((a.clientY+b.clientY)/2)-r.top]; }

  inp('zoom-in').onclick = ()=>zoomCenter(0.8);
  inp('zoom-out').onclick = ()=>zoomCenter(1/0.8);
  inp('zoom-sla').onclick = zoomToSLA;
  inp('zoom-plan').onclick = zoomToPlan;
  inp('zoom-center').onclick = centerView;
  inp('zoom-reset').onclick = ()=>{ resetView(); drawChart(); };
})();
