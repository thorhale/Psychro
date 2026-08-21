/**
 * The Branding card — upload a logo, get the palette.
 *
 * The sampling pipeline has existed since the palette was first derived
 * (`npm run brand:sample`), but it was build-time only: a script nobody on a
 * hall floor will ever run. This card is the same derivation — literally the
 * same module, `src/config/palette.js` — fed by a canvas instead of a PNG
 * decoder, with a button instead of a terminal.
 *
 * What it changes is COLOUR only. Wording (company, product) stays with the
 * committed BRAND: the card restyles the tools, it does not rename them.
 *
 * The applied palette persists in `sdc_psychro_brand_v1` and is read at boot
 * by all three pages — the planner through `applyBrand`, the launcher and the
 * CDU tool through small inline scripts, since those two are deliberately
 * static and cannot import modules.
 */

import { dominantColors, derivePalette, isValidPalette } from '../config/palette.js';
import { applyBrand } from '../config/brand.js';
import { storage } from '../platform/index.js';
import { toast } from '../ui/notify.js';
import { inp } from '../ui/dom.js';

export const BRAND_KEY = 'sdc_psychro_brand_v1';

/** The stored override, or null if none / unreadable / invalid. */
export function storedPalette() {
  try {
    const raw = storage.get(BRAND_KEY);
    if (!raw) return null;
    const p = JSON.parse(raw);
    return isValidPalette(p) ? p : null;
  } catch {
    return null;
  }
}

/**
 * Decode an image file to RGBA bytes via a canvas.
 *
 * Downscaled to fit 256×256: dominant-colour bucketing needs proportions, not
 * pixels, and a 4000×4000 logo is 64 MB of ImageData for the same answer.
 */
async function pixelsFrom(file) {
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    await new Promise((res, rej) => {
      img.onload = res;
      img.onerror = () => rej(new Error('not a readable image'));
      img.src = url;
    });
    const scale = Math.min(1, 256 / Math.max(img.naturalWidth, img.naturalHeight, 1));
    const w = Math.max(1, Math.round(img.naturalWidth * scale));
    const h = Math.max(1, Math.round(img.naturalHeight * scale));
    const canvas = document.createElement('canvas');
    canvas.width = w; canvas.height = h;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(img, 0, 0, w, h);
    return ctx.getImageData(0, 0, w, h).data;
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** Paint the five swatches and the sampled hexes into the preview row. */
function showPreview(p) {
  const row = inp('brand-preview');
  if (!row) return;
  row.style.display = p ? '' : 'none';
  if (!p) return;
  for (const [key, id] of [
    ['primary', 'bp-primary'], ['primaryDark', 'bp-primary-dark'],
    ['primaryLight', 'bp-primary-light'], ['accent', 'bp-accent'],
    ['accentDark', 'bp-accent-dark'],
  ]) {
    const el = inp(id);
    if (el) {
      el.style.background = p[key];
      el.title = `${key} ${p[key]}`;
    }
  }
  const hexes = inp('brand-hexes');
  if (hexes) hexes.textContent = `${p.primary} · ${p.accent}`;
}

export function wireBrandUi() {
  const file = /** @type {HTMLInputElement|null} */ (inp('brand-file'));
  if (!file) return;

  /** The palette sampled from the last upload, awaiting Apply. */
  let pending = null;

  file.addEventListener('change', async () => {
    const f = file.files && file.files[0];
    if (!f) return;
    try {
      const px = await pixelsFrom(f);
      pending = derivePalette(dominantColors(px));
      if (!pending) {
        toast('That image is all white and black — there is no colour in it to build a brand from.', { kind: 'warn' });
        showPreview(null);
        return;
      }
      showPreview(pending);
      const apply = /** @type {any} */ (inp('brand-apply'));
      if (apply) apply.disabled = false;
    } catch {
      toast('Could not read that file as an image.', { kind: 'warn' });
    }
  });

  inp('brand-apply')?.addEventListener('click', () => {
    if (!pending) return;
    const r = storage.set(BRAND_KEY, JSON.stringify(pending));
    applyBrand(document, pending);
    if (r.ok) toast('Brand applied — every tool now uses this palette.', { kind: 'ok' });
    else toast('Applied for this session, but saving failed — it will not survive a reload.', { kind: 'warn', duration: 8000 });
  });

  inp('brand-reset')?.addEventListener('click', () => {
    storage.remove(BRAND_KEY);
    pending = null;
    showPreview(null);
    const apply = /** @type {any} */ (inp('brand-apply'));
    if (apply) apply.disabled = true;
    applyBrand(document);
    toast('Back to the built-in brand.', { kind: 'ok' });
  });

  // A stored override previews itself on load, so the card shows what is
  // currently in force rather than an empty state that contradicts the page.
  const current = storedPalette();
  if (current) showPreview(current);
}
