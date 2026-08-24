/**
 * Image and PDF export — the artifacts that leave the app.
 *
 * Everything here renders to a file somebody else will read on paper or on a
 * phone, away from the app that produced it. That changes the rules: an
 * artifact cannot be interactive, cannot be re-checked against live state,
 * and cannot say "estimated" in a tooltip. Whatever it claims, it claims
 * standing alone — which is why the pressure basis and the plan assumptions
 * are printed on it rather than assumed.
 */

import { state } from './state.js';
import { BRAND } from '../config/brand.js';
import { toast } from '../ui/notify.js';
import { dispTs, dispDeltaT, disp1, tLabel, deltaLabel } from '../ui/format.js';
import { deriveStateF } from '../core/derive.js';
import { fmtHrs } from '../core/planner.js';
import { drawQr } from '../lib/qr.js';
import { logError } from '../lib/errors.js';
import { VERSION_LABEL } from './version.js';
import { inp, canvasEl } from '../ui/dom.js';

/**
 * The few things only the entry point can answer: how a file should be named,
 * what the current share link is, how this hall's pressure was arrived at,
 * and the live plan. Supplied once at boot so this module never imports
 * main.js back.
 * @type {{currentShareUrl:Function, exportName:Function,
 *         pressureBasisText:Function, planMove:Function}}
 */
/**
 * @type {{
 *   currentShareUrl: () => string,
 *   exportName: (kind: string, ext: string) => string,
 *   pressureBasisText: () => string,
 *   planMove: (opts?: object) => any,
 * }}
 */
let shell = {
  currentShareUrl: () => '', exportName: () => 'export',
  pressureBasisText: () => '', planMove: () => null,
};

/** Hand this module the few things only the entry point can do. */
export function wireExport(callbacks) {
  shell = { ...shell, ...callbacks };
}

function buildExportCanvas() {
  const src = canvasEl('psychCanvas');
  const scale = 2;                       // crisp on retina / when embedded
  const W = 1000, headH = 150, chartH = 560, footH = 70;
  const H = headH + chartH + footH;
  const c = document.createElement('canvas');
  c.width = W * scale; c.height = H * scale;
  const x = c.getContext('2d'); x.scale(scale, scale);

  // Background
  x.fillStyle = '#0d1b2a'; x.fillRect(0, 0, W, H);

  // Header band (Stream navy → teal underline)
  const grad = x.createLinearGradient(0, 0, W, 0);
  grad.addColorStop(0, BRAND.primary); grad.addColorStop(1, BRAND.primaryDark);
  x.fillStyle = grad; x.fillRect(0, 0, W, headH);
  x.fillStyle = BRAND.accent; x.fillRect(0, headH - 4, W, 4);

  x.fillStyle = '#fff'; x.font = '800 26px -apple-system,Segoe UI,sans-serif';
  x.textBaseline = 'top';
  x.fillText('STREAM', 28, 22);
  x.fillStyle = BRAND.accent; x.font = '600 12px -apple-system,Segoe UI,sans-serif';
  x.fillText('DATA CENTERS', 130, 30);
  x.fillStyle = '#fff'; x.font = '700 20px -apple-system,Segoe UI,sans-serif';
  x.fillText('Hall Environment Planner', 28, 60);

  // Operating summary line
  const sla = state.slaProfiles[state.activeSla];
  const U = tLabel();
  x.fillStyle = '#9db8d0'; x.font = '13px -apple-system,Segoe UI,sans-serif';
  x.fillText(`${state.hall.name || 'Hall'}  ·  ${sla.name}  ·  ${state.hall.siteName || '—'}  ·  ${(state.hall.elevFt ?? 0).toLocaleString()} ft  ·  ${state.pressure.toFixed(1)} kPa  ·  eff ${Math.round(state.hall.effPct ?? 100)}%`, 28, 92);
  x.fillStyle = '#e6edf3'; x.font = '600 15px -apple-system,Segoe UI,sans-serif';
  const cur = `${dispTs(state.aTemp)}${U} / ${disp1(state.aRH)}%`;
  const tgt = `${dispTs(state.bTemp)}${U} / ${disp1(state.bRH)}%`;
  const plan = shell.planMove();
  const planTxt = plan.hours > 0 ? `      ·      est. ≥ ${fmtHrs(plan.hours)} (${plan.binding})` : '';
  x.fillText(`CURRENT  ${cur}      →      TARGET  ${tgt}${planTxt}`, 28, 112);

  // Derived properties, from the same deriveState() the table and readout use —
  // an exported sheet has to stand on its own, and dew point in particular is
  // what SLA caps are written against.
  const dA = deriveStateF(state.aTemp, state.aRH, state.pressure);
  const dB = deriveStateF(state.bTemp, state.bRH, state.pressure);
  const dpTxt = (d) => (d.tdpF != null ? `${dispTs(d.tdpF)}${U}` : '—');
  x.fillStyle = '#9db8d0'; x.font = '12px -apple-system,Segoe UI,sans-serif';
  x.fillText(
    `dew pt ${dpTxt(dA)} → ${dpTxt(dB)}   ·   W ${dA.Wg.toFixed(2)} → ${dB.Wg.toFixed(2)} g/kg   ·   ` +
      `wet bulb ${dispTs(dA.twbF)} → ${dispTs(dB.twbF)}${U}   ·   ASHRAE ${dA.zone} → ${dB.zone}`,
    28,
    132,
  );

  // Chart image
  if (src) {
    try { x.drawImage(src, 20, headH + 10, W - 40, chartH - 20); } catch (e) { logError('export-chart-draw', e); }
  }

  // Footer
  x.fillStyle = BRAND.primaryDark; x.fillRect(0, H - footH, W, footH);
  x.fillStyle = BRAND.accent; x.fillRect(0, H - footH, W, 3);
  x.fillStyle = '#9db8d0'; x.font = '11px -apple-system,Segoe UI,sans-serif';
  x.fillText('ASHRAE TC 9.9 psychrometrics · barometric pressure corrected for site elevation · generated ' + new Date().toLocaleString(), 28, H - footH + 22);
  x.fillStyle = '#6f8aa3'; x.font = '10px -apple-system,Segoe UI,sans-serif';
  x.fillText('Stream Data Centers — Critical Engineering Tool', 28, H - footH + 42);

  return c;
}
/**
 * The door placard: one printable page per hall — envelope snapshot, the
 * do-not-cross numbers, site pressure basis, and a QR deep-link to the live
 * planner. Meant to be laminated and taped to the hall door.
 */
function buildPlacardCanvas() {
  const scale = 2;
  const W = 620, H = 850;
  const c = document.createElement('canvas');
  c.width = W * scale; c.height = H * scale;
  const x = c.getContext('2d');
  x.scale(scale, scale);

  // PRINT palette: this is a laminated door sheet, not a screen. A dark
  // full-bleed page drained a toner cartridge per hall and collapsed the
  // amber/red limit columns to matching grey on a mono laser — black on
  // white with bold weight survives any printer.
  x.fillStyle = '#ffffff'; x.fillRect(0, 0, W, H);
  // Header band
  x.fillStyle = BRAND.primary; x.fillRect(0, 0, W, 64);
  x.fillStyle = BRAND.accent; x.fillRect(0, 64, W, 3);
  x.fillStyle = '#ffffff'; x.font = 'bold 20px sans-serif'; x.textAlign = 'left';
  x.fillText('HALL ENVIRONMENT LIMITS', 24, 30);
  x.fillStyle = '#cfe3f2'; x.font = '12px sans-serif';
  x.fillText('Post at the hall door · verify against site instrumentation before acting', 24, 50);

  // Hall identity
  const hall = state.hall || {};
  x.fillStyle = '#10151b'; x.font = 'bold 22px sans-serif';
  x.fillText([hall.name, hall.siteName].filter(Boolean).join(' — ') || 'Hall', 24, 100);
  x.fillStyle = '#41576b'; x.font = '13px monospace';
  x.fillText(
    `${Math.round(hall.elevFt ?? 0).toLocaleString()} ft · ${shell.pressureBasisText()} — dew-point cap evaluated at this pressure`,
    24, 122,
  );

  // Do-not-cross table from the active SLA
  // An empty placard is better than a wrong one: with no profile active the
  // table below simply has no rows to print.
  const sla = /** @type {SlaProfile|undefined} */ (state.slaProfiles[state.activeSla]);
  if (!sla) return c;
  const U = tLabel();
  const rows = [
    ['Temperature', `${dispTs(sla.tMinF)} ${U}`, `${dispTs(sla.tMaxF)} ${U}`],
    ['Relative humidity', `${sla.rhMin}%`, `${sla.rhMax}%`],
    ...(sla.dpMaxF != null ? [['Dew point (cap)', '—', `${dispTs(sla.dpMaxF)} ${U}`]] : []),
    ...(sla.maxDtHr != null ? [['Ramp: temperature', '—', `${Math.round(dispDeltaT(sla.maxDtHr) * 10) / 10}${deltaLabel()}/hr`]] : []),
    ...(sla.maxDrhHr != null ? [['Ramp: RH', '—', `${sla.maxDrhHr}%/hr`]] : []),
  ];
  let ty = 156;
  x.fillStyle = BRAND.accentDark; x.font = 'bold 13px sans-serif';
  x.fillText(`DO NOT CROSS — ${sla.name || 'SLA'}`, 24, ty);
  ty += 10;
  x.font = '13px monospace';
  const cols = [24, 280, 440];
  x.fillStyle = '#41576b';
  ['limit', 'min', 'max'].forEach((h, i) => x.fillText(h, cols[i], ty + 20));
  ty += 28;
  x.strokeStyle = '#b9c8d4'; x.beginPath(); x.moveTo(24, ty); x.lineTo(W - 24, ty); x.stroke();
  x.font = 'bold 13px monospace'; // limits must survive a mono laser: weight, not hue
  for (const [name, lo, hi] of rows) {
    ty += 24;
    x.fillStyle = '#10151b'; x.fillText(name, cols[0], ty);
    x.fillStyle = '#8a5a00'; x.fillText(String(lo), cols[1], ty);
    x.fillStyle = '#a01818'; x.fillText(String(hi), cols[2], ty);
  }
  ty += 16;

  // Envelope snapshot — blit the live chart, framed so the dark chart reads
  // as a figure on the white page instead of a hole in it.
  const src = canvasEl('psychCanvas');
  const chartH = 330;
  try {
    x.drawImage(src, 24, ty, W - 48, chartH);
    x.strokeStyle = '#b9c8d4'; x.strokeRect(24, ty, W - 48, chartH);
  } catch { /* chart not ready — placard still useful */ }
  ty += chartH + 12;

  // QR deep-link + footer. The caption promises exactly what the link
  // carries (set-points, unit, hall/SLA names, elevation) — it used to
  // promise "limits and move timing", which the URL does not encode.
  const qrCanvas = document.createElement('canvas');
  try {
    drawQr(qrCanvas, shell.currentShareUrl(), 4);
    x.drawImage(qrCanvas, 24, ty, 120, 120);
    x.strokeStyle = '#b9c8d4'; x.strokeRect(24, ty, 120, 120);
  } catch { /* URL too long for v10 would throw — placard survives */ }
  x.fillStyle = '#10151b'; x.font = 'bold 14px sans-serif';
  x.fillText('Scan for the live planner', 160, ty + 40);
  x.fillStyle = '#41576b'; x.font = '12px sans-serif';
  x.fillText('Opens the planner preloaded with this hall’s set-points', 160, ty + 62);
  x.fillText('and site elevation. The limits are on this sheet.', 160, ty + 78);
  x.fillStyle = '#8a5a00'; x.font = 'bold 12px sans-serif';
  x.fillText('PLANNING AID, NOT A CONTROL SYSTEM', 160, ty + 106);
  x.fillStyle = '#41576b'; x.font = '11px monospace';
  x.fillText(`generated ${new Date().toISOString().slice(0, 10)} · ${VERSION_LABEL}`, 24, H - 18);
  return c;
}

inp('export-placard')?.addEventListener('click', () => {
  try {
    exportPdfJpeg(buildPlacardCanvas(), { portrait: true, filename: shell.exportName('placard', 'pdf') });
  } catch (e) {
    logError('export-placard', e);
    toast('Placard export failed: ' + e.message, { kind: 'error' });
  }
});

inp('export-png').addEventListener('click', () => {
  try {
    const c = buildExportCanvas();
    c.toBlob(blob => {
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = shell.exportName('chart', 'png');
      document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url);
    }, 'image/png');
  } catch (e) { logError('export-png', e); toast('PNG export failed: ' + e.message, { kind: 'error' }); }
});
inp('export-pdf').addEventListener('click', () => {
  try {
    const c = buildExportCanvas();
    exportPdfJpeg(c);   // dependency-free single-page PDF (DCTDecode/JPEG)
  } catch (e) { logError('export-pdf', e); toast('PDF export failed: ' + e.message, { kind: 'error' }); }
});
function exportPdfJpeg(canvas, opts = {}) {
  const jpeg = canvas.toDataURL('image/jpeg', 0.92);
  const b64 = jpeg.split(',')[1];
  const raw = atob(b64);
  const imgBytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) imgBytes[i] = raw.charCodeAt(i);
  const imgW = canvas.width, imgH = canvas.height;
  // Letter, landscape by default; the door placard asks for portrait.
  const pageW = opts.portrait ? 612 : 792, pageH = opts.portrait ? 792 : 612, margin = 24;
  const scale = Math.min((pageW - margin*2)/imgW, (pageH - margin*2)/imgH);
  const dW = imgW*scale, dH = imgH*scale, ox = (pageW-dW)/2, oy = (pageH-dH)/2;

  const enc = s => new TextEncoder().encode(s);
  const objOffsets = [];
  const buf = [];
  const add = u8 => buf.push(u8);
  const lenOf = arr => arr.reduce((a,u)=>a+u.length,0);

  add(enc('%PDF-1.4\n%\xFF\xFF\xFF\xFF\n'));
  const recordOffset = () => objOffsets.push(lenOf(buf));

  recordOffset(); add(enc('1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n'));
  recordOffset(); add(enc('2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n'));
  recordOffset(); add(enc(`3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pageW} ${pageH}] /Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>\nendobj\n`));
  recordOffset();
  add(enc(`4 0 obj\n<< /Type /XObject /Subtype /Image /Width ${imgW} /Height ${imgH} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${imgBytes.length} >>\nstream\n`));
  add(imgBytes);
  add(enc('\nendstream\nendobj\n'));
  const content = `q\n${dW.toFixed(2)} 0 0 ${dH.toFixed(2)} ${ox.toFixed(2)} ${oy.toFixed(2)} cm\n/Im0 Do\nQ\n`;
  recordOffset(); add(enc(`5 0 obj\n<< /Length ${content.length} >>\nstream\n${content}endstream\nendobj\n`));

  const xrefPos = lenOf(buf);
  let xref = `xref\n0 6\n0000000000 65535 f \n`;
  objOffsets.forEach(o => { xref += String(o).padStart(10,'0') + ' 00000 n \n'; });
  add(enc(xref));
  add(enc(`trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xrefPos}\n%%EOF`));

  const blob = new Blob(buf, { type:'application/pdf' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = opts.filename || shell.exportName('chart', 'pdf');
  document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url);
}

