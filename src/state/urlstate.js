/**
 * Scenario deep-links: the whole A→B setup in the URL hash.
 *
 * A "move plan" becomes something you can paste into a change ticket, text to
 * the on-call phone, print as a QR on the door placard, or write to an NFC
 * tag — and opening it lands the recipient on the exact same numbers. Works
 * over file:// and in the single-file build: nothing here needs a server.
 *
 * Format (versioned, human-readable on purpose):
 *
 *   #v=1&a=68,45&b=75,35&u=F&hall=Hall%201&sla=Base%20SLA&elev=1066
 *
 * `a`/`b` are dry-bulb °F and RH% (the canonical internal units — the `u`
 * param only selects the DISPLAY unit on arrival). `hall`/`sla` are matched
 * by name on the receiving device; `elev` (ft) lets a device that doesn't
 * have the named hall still land at the right pressure — pressure changes
 * the numbers, so a shared link carries it.
 *
 * The hash is read once at boot (it wins over stored state, because the
 * person clicked it on purpose) and is never written back automatically —
 * the URL only changes when the user asks for a link.
 */

import { isValidScenario } from './schema.js';

export const URLSTATE_VERSION = 1;

/** Round for the URL: enough precision to reproduce state, short enough to share. */
const enc = (n) => String(Math.round(n * 100) / 100);

/**
 * Build the hash fragment (leading '#') for a scenario-shaped object.
 * @param {{aTemp:number,aRH:number,bTemp:number,bRH:number,
 *          tempUnit?:string,hallName?:string,slaName?:string,elevFt?:number}} s
 * @returns {string}
 */
export function encodeStateHash(s) {
  const q = new URLSearchParams();
  q.set('v', String(URLSTATE_VERSION));
  q.set('a', `${enc(s.aTemp)},${enc(s.aRH)}`);
  q.set('b', `${enc(s.bTemp)},${enc(s.bRH)}`);
  if (s.tempUnit) q.set('u', s.tempUnit);
  if (s.hallName) q.set('hall', s.hallName);
  if (s.slaName) q.set('sla', s.slaName);
  if (s.elevFt != null && isFinite(s.elevFt)) q.set('elev', String(Math.round(s.elevFt)));
  return '#' + q.toString();
}

/**
 * Parse a location.hash. Returns null for anything that is not a valid
 * v1 state link — including hostile numbers; the result is guaranteed to
 * satisfy `isValidScenario` and carry only finite, range-clamped values.
 *
 * @param {string} hash location.hash, with or without the leading '#'
 * @returns {{aTemp:number,aRH:number,bTemp:number,bRH:number,tempUnit:string|null,
 *            hallName:string|null,slaName:string|null,elevFt:number|null}|null}
 */
export function parseStateHash(hash) {
  if (typeof hash !== 'string') return null;
  const raw = hash.startsWith('#') ? hash.slice(1) : hash;
  if (!raw.includes('a=') || !raw.includes('b=')) return null;
  let q;
  try {
    q = new URLSearchParams(raw);
  } catch {
    return null;
  }
  if (q.get('v') !== String(URLSTATE_VERSION)) return null;

  const pair = (key) => {
    const parts = (q.get(key) ?? '').split(',');
    if (parts.length !== 2) return null;
    const t = Number(parts[0]);
    const rh = Number(parts[1]);
    // Generous clamps — the app's own clamps run again on apply; these only
    // reject garbage, they don't redefine app limits.
    if (!isFinite(t) || !isFinite(rh) || t < -100 || t > 200) return null;
    return { t, rh: Math.min(100, Math.max(0, rh)) };
  };
  const a = pair('a');
  const b = pair('b');
  if (!a || !b) return null;

  const unit = q.get('u');
  const elev = q.get('elev') != null ? Number(q.get('elev')) : null;
  const out = {
    aTemp: a.t,
    aRH: a.rh,
    bTemp: b.t,
    bRH: b.rh,
    tempUnit: unit === 'F' || unit === 'C' || unit === 'K' ? unit : null,
    hallName: q.get('hall') || null,
    slaName: q.get('sla') || null,
    elevFt: elev != null && isFinite(elev) ? Math.min(20000, Math.max(-15000, elev)) : null,
  };
  return isValidScenario(out) ? out : null;
}
