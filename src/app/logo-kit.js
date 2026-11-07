/**
 * The logo kit — one uploaded logo becomes the tools' colours, their masthead
 * mark and their app icon, on this device only.
 *
 * Two callers, one implementation: the home screen's "Upload logo" button and
 * the planner's Branding card. Both build the same kit from the same file the
 * same way, because a logo that themed the launcher one way and the planner
 * another would be two brands.
 *
 * WHAT IS STORED. Everything lives in this device's storage and nowhere else:
 *   sdc_psychro_brand_v1  the five-colour palette (read by all three pages)
 *   sdc_psychro_logo_v1   the logo, the backdrop it sits on, and four PNG icons
 * Nothing is uploaded. There is no server to upload to: every page's CSP
 * forbids talking to one.
 *
 * WHAT CANNOT BE CHANGED. A page can swap its tab icon and the icon offered
 * the NEXT time someone adds it to a home screen. It cannot reach an icon
 * already installed: the operating system copied that at install time. The
 * button says so rather than pretend.
 *
 * The pure helpers (backdrop choice, icon geometry, manifest rewrite, kit
 * validation) take plain data so test/logo-kit.test.js can pin them without a
 * DOM. Only `buildKit` and `applyKit` touch a canvas or a document.
 */

import { dominantColors, derivePalette, isValidPalette, luma, hexOf } from '../config/palette.js';

export const BRAND_KEY = 'sdc_psychro_brand_v1';
export const LOGO_KEY = 'sdc_psychro_logo_v1';

/** Longest side of the stored logo, px. Sharp at 3× on a 32 px masthead. */
const LOGO_MAX = 384;

/** The dark the launcher and planner are painted on; a light logo's backdrop. */
const DARK_BACKDROP = '#0d1b2a';

const PNG_PREFIX = 'data:image/png;base64,';
const isPng = (v) => typeof v === 'string' && v.startsWith(PNG_PREFIX) && v.length > PNG_PREFIX.length;
const isHex = (v) => typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v);

/**
 * A stored kit is trusted only if every field is exactly what this module
 * writes: PNG data URLs and one #rrggbb. Anything else (a truncated write, a
 * hand-edited store, a kit from some future version) is ignored, so a broken
 * store can never put a foreign URL into an <img> or a <link>.
 */
export function isValidKit(k) {
  return !!k && typeof k === 'object' && k.v === 1
    && isPng(k.logo) && isHex(k.bg)
    && !!k.icons && typeof k.icons === 'object'
    && ['i192', 'i512', 'm512', 'a180'].every((n) => isPng(k.icons[n]));
}

/**
 * What the logo sits on, in the masthead and in the icon.
 *
 * An opaque image (a JPEG, a logo exported on its own paper) already has a
 * background: use it, sampled from the border, so the icon reads as the logo
 * and not as a logo pasted on a tile. A transparent mark needs one chosen for
 * it: white for a dark mark, the app's own dark for a light one. Choosing by
 * the logo's lightness is what keeps a white logo from vanishing on white.
 *
 * @param {Uint8Array|Uint8ClampedArray} px RGBA bytes
 * @param {number} w
 * @param {number} h
 * @returns {string} #rrggbb
 */
export function chooseBackdrop(px, w, h) {
  let edgeN = 0, edgeOpaque = 0, er = 0, eg = 0, eb = 0;
  const visit = (x, y) => {
    const i = (y * w + x) * 4;
    edgeN++;
    if (px[i + 3] >= 250) { edgeOpaque++; er += px[i]; eg += px[i + 1]; eb += px[i + 2]; }
  };
  for (let x = 0; x < w; x++) { visit(x, 0); if (h > 1) visit(x, h - 1); }
  for (let y = 1; y < h - 1; y++) { visit(0, y); if (w > 1) visit(w - 1, y); }
  if (edgeN && edgeOpaque / edgeN >= 0.9) return hexOf(er / edgeOpaque, eg / edgeOpaque, eb / edgeOpaque);

  let n = 0, sum = 0;
  for (let i = 0; i < px.length; i += 4) {
    if (px[i + 3] < 128) continue;
    n++; sum += luma(px[i], px[i + 1], px[i + 2]);
  }
  if (!n) return '#ffffff';
  return sum / n > 0.62 ? DARK_BACKDROP : '#ffffff';
}

/**
 * Where to draw a w×h logo on a square icon of side `size`.
 *
 * `maskable` icons get cropped by the launcher to any shape, a circle at
 * worst, and only the centre 80 % circle is promised to survive. A plain
 * icon only loses its corners to rounding, so the logo may fill 84 % of the
 * square. Either way the logo keeps its aspect ratio and is centred.
 *
 * @returns {{x:number, y:number, w:number, h:number}}
 */
export function iconRect(w, h, size, maskable = false) {
  const a = w / Math.max(h, 1e-9);
  let dw, dh;
  if (maskable) {
    // Largest rectangle of aspect a inside a circle of diameter 0.8·size.
    const d = 0.8 * size;
    dh = d / Math.sqrt(a * a + 1);
    dw = a * dh;
  } else {
    const box = 0.84 * size;
    const k = Math.min(box / w, box / h);
    dw = w * k; dh = h * k;
  }
  return { x: (size - dw) / 2, y: (size - dh) / 2, w: dw, h: dh };
}

/**
 * The static manifest, re-pointed at the kit's icons.
 *
 * The page's own manifest stays the one source of name, scope, id and
 * screenshots; this only swaps the icons and the theme colour. Every URL is
 * made absolute against the manifest's real address, because the rewritten
 * copy is served from a blob: URL that relative paths cannot resolve against.
 * `id` is preserved exactly, so the browser still sees the same app.
 *
 * @param {object} m the parsed static manifest
 * @param {{icons:{i192:string,i512:string,m512:string}}} kit
 * @param {string} manifestHref absolute URL the static manifest was read from
 * @param {{primary?:string}|null} palette
 */
export function manifestWithKit(m, kit, manifestHref, palette) {
  const abs = (u) => (typeof u === 'string' ? new URL(u, manifestHref).href : u);
  const out = { ...m };
  for (const k of ['start_url', 'scope', 'id']) if (k in out) out[k] = abs(out[k]);
  if (Array.isArray(out.screenshots)) out.screenshots = out.screenshots.map((s) => ({ ...s, src: abs(s.src) }));
  out.icons = [
    { src: kit.icons.i192, sizes: '192x192', type: 'image/png', purpose: 'any' },
    { src: kit.icons.i512, sizes: '512x512', type: 'image/png', purpose: 'any' },
    { src: kit.icons.m512, sizes: '512x512', type: 'image/png', purpose: 'maskable' },
  ];
  if (palette && isHex(palette.primary)) out.theme_color = palette.primary;
  return out;
}

// ── Storage ─────────────────────────────────────────────────────────────────

/**
 * This device's storage, for a page that cannot import the platform layer.
 *
 * The launcher is a few kilobytes on purpose and must not pull in the native
 * shells' plugin loaders. Inside those shells the Capacitor bridge is already
 * on `window`, so writes are mirrored to durable native storage the same way
 * the planner's are, and an iOS WebView eviction cannot take the logo with it.
 */
export function deviceStore(win = globalThis) {
  const nativePrefs = () => {
    try {
      const C = /** @type {any} */ (win).Capacitor;
      return C && C.isNativePlatform && C.isNativePlatform() ? C.Plugins && C.Plugins.Preferences : null;
    } catch { return null; }
  };
  return {
    get(key) {
      try { return win.localStorage.getItem(key); } catch { return null; }
    },
    set(key, value) {
      try { win.localStorage.setItem(key, value); } catch (error) { return { ok: false, error }; }
      try { const p = nativePrefs(); if (p) p.set({ key, value }); } catch { /* the live copy stands */ }
      return { ok: true };
    },
    remove(key) {
      try { win.localStorage.removeItem(key); } catch { /* nothing to remove */ }
      try { const p = nativePrefs(); if (p) p.remove({ key }); } catch { /* already gone */ }
    },
  };
}

/** The stored kit, or null if none, unreadable, or not exactly what we write. */
export function loadKit(store) {
  try {
    const k = JSON.parse(store.get(LOGO_KEY) || 'null');
    return isValidKit(k) ? k : null;
  } catch { return null; }
}

/** The stored palette override, or null. */
export function loadPalette(store) {
  try {
    const p = JSON.parse(store.get(BRAND_KEY) || 'null');
    return isValidPalette(p) ? p : null;
  } catch { return null; }
}

/**
 * Persist a kit and its palette. The palette is optional: a black-and-white
 * logo still makes an icon, it just has no colour to theme the tools with, so
 * the colours already in force are left alone.
 *
 * @returns {{ok:boolean}} false when storage refused (quota, private mode):
 *   the kit still applies for this visit, it just will not survive a reload.
 */
export function saveKit(store, kit, palette) {
  const a = store.set(LOGO_KEY, JSON.stringify(kit));
  const b = palette ? store.set(BRAND_KEY, JSON.stringify(palette)) : { ok: true };
  if (!a.ok) store.remove(LOGO_KEY); // never leave half a kit behind
  return { ok: !!(a.ok && b.ok) };
}

/** Forget the logo and the colours it set: back to the built-in brand. */
export function clearKit(store) {
  store.remove(LOGO_KEY);
  store.remove(BRAND_KEY);
}

// ── Canvas ──────────────────────────────────────────────────────────────────

/** Decode an image file into an <img>, or reject with a plain message. */
export function decodeImage(file, doc = document) {
  const url = URL.createObjectURL(file);
  return new Promise((resolve, reject) => {
    const img = doc.createElement('img');
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('That file is not an image this browser can read.')); };
    img.src = url;
  });
}

function canvas(doc, w, h) {
  const c = doc.createElement('canvas');
  c.width = Math.max(1, Math.round(w));
  c.height = Math.max(1, Math.round(h));
  const ctx = /** @type {CanvasRenderingContext2D} */ (c.getContext('2d', { willReadFrequently: true }));
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  return { c, ctx };
}

function renderIcon(doc, img, size, bg, maskable) {
  const { c, ctx } = canvas(doc, size, size);
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, size, size);
  const r = iconRect(img.naturalWidth, img.naturalHeight, size, maskable);
  ctx.drawImage(img, r.x, r.y, r.w, r.h);
  return c.toDataURL('image/png');
}

/**
 * Everything one logo yields: the kit to store and the palette to theme with.
 *
 * @param {HTMLImageElement} img a decoded image (see decodeImage)
 * @returns {{kit:object, palette:object|null}} palette null for a logo with
 *   no colour in it (all white, black and grey)
 */
export function buildKit(img, doc = document) {
  const iw = img.naturalWidth, ih = img.naturalHeight;
  if (!iw || !ih) throw new Error('That image has no pixels in it.');

  // Colour and backdrop are read from a small copy: proportions, not detail.
  const s = Math.min(1, 256 / Math.max(iw, ih));
  const probe = canvas(doc, iw * s, ih * s);
  probe.ctx.drawImage(img, 0, 0, probe.c.width, probe.c.height);
  const px = probe.ctx.getImageData(0, 0, probe.c.width, probe.c.height).data;
  const palette = derivePalette(dominantColors(px));
  const bg = chooseBackdrop(px, probe.c.width, probe.c.height);

  // The stored mark: transparent, so the masthead's backdrop shows through it.
  const k = Math.min(1, LOGO_MAX / Math.max(iw, ih));
  const mark = canvas(doc, iw * k, ih * k);
  mark.ctx.drawImage(img, 0, 0, mark.c.width, mark.c.height);

  const kit = {
    v: 1,
    logo: mark.c.toDataURL('image/png'),
    bg,
    icons: {
      i192: renderIcon(doc, img, 192, bg, false),
      i512: renderIcon(doc, img, 512, bg, false),
      m512: renderIcon(doc, img, 512, bg, true),
      a180: renderIcon(doc, img, 180, bg, false),
    },
  };
  return { kit, palette };
}

// ── Document ────────────────────────────────────────────────────────────────

/** Point a <link rel=…> at `href`, remembering the shipped one for a reset. */
function setLink(doc, rel, href) {
  const el = /** @type {HTMLLinkElement|null} */ (doc.querySelector(`link[rel="${rel}"]`));
  if (!el) return;
  if (el.dataset.shippedHref == null) el.dataset.shippedHref = el.getAttribute('href') || '';
  el.setAttribute('href', href || el.dataset.shippedHref);
}

/** Swap the manifest for one carrying the kit's icons (or put the shipped one back). */
async function swapManifest(doc, kit, palette) {
  const link = /** @type {HTMLLinkElement|null} */ (doc.querySelector('link[rel="manifest"]'));
  if (!link) return;
  if (link.dataset.shippedHref == null) link.dataset.shippedHref = link.getAttribute('href') || '';
  if (!kit) { link.setAttribute('href', link.dataset.shippedHref); return; }
  const href = new URL(link.dataset.shippedHref, doc.baseURI);
  // A file:// copy cannot be installed and cannot fetch its manifest either.
  if (href.protocol !== 'https:' && href.protocol !== 'http:') return;
  try {
    const res = await fetch(href.href);
    if (!res.ok) return;
    const m = manifestWithKit(await res.json(), kit, href.href, palette);
    const blob = new Blob([JSON.stringify(m)], { type: 'application/manifest+json' });
    link.setAttribute('href', URL.createObjectURL(blob));
  } catch { /* the shipped manifest stays in force: a worse icon, not a broken install */ }
}

/**
 * Put a kit on the page, or take it off (`kit` null).
 *
 * - `<html class="has-logo">` hides the text wordmark (`[data-brand="company"]`
 *   and `[data-brand="companySub"]`) so the logo replaces it, not joins it.
 * - every `img[data-brand-logo]` shows the logo on its backdrop.
 * - the tab icon, the Add-to-Home-Screen icon, the install banner's icon and
 *   the install manifest follow.
 * - `<meta name="theme-color">` follows the palette's primary.
 */
export function applyKit(doc, kit, palette = null, { manifest = true } = {}) {
  doc.documentElement.classList.toggle('has-logo', !!kit);
  doc.querySelectorAll('img[data-brand-logo]').forEach((/** @type {HTMLImageElement} */ img) => {
    if (kit) {
      img.src = kit.logo;
      img.style.background = kit.bg;
      img.hidden = false;
    } else {
      img.removeAttribute('src');
      img.style.background = '';
      img.hidden = true;
    }
  });
  setLink(doc, 'icon', kit && kit.icons.i192);
  setLink(doc, 'apple-touch-icon', kit && kit.icons.a180);
  // The install banner shows the icon you are about to install; it has to be
  // the one the kit will actually give you.
  doc.querySelectorAll('img[data-brand-icon]').forEach((/** @type {HTMLImageElement} */ img) => {
    if (img.dataset.shippedSrc == null) img.dataset.shippedSrc = img.getAttribute('src') || '';
    img.setAttribute('src', kit ? kit.icons.i192 : img.dataset.shippedSrc);
  });
  const meta = /** @type {HTMLMetaElement|null} */ (doc.querySelector('meta[name="theme-color"]'));
  if (meta) {
    if (meta.dataset.shipped == null) meta.dataset.shipped = meta.content;
    meta.content = palette && isHex(palette.primary) ? palette.primary : meta.dataset.shipped;
  }
  if (manifest) return swapManifest(doc, kit, palette);
  return Promise.resolve();
}
