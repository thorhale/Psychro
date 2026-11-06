/**
 * The Branding card — upload a logo, get the palette.
 *
 * The sampling pipeline has existed since the palette was first derived
 * (`npm run brand:sample`), but it was build-time only: a script nobody on a
 * hall floor will ever run. This card is the same derivation — literally the
 * same module, `src/config/palette.js` — fed by a canvas instead of a PNG
 * decoder, with a button instead of a terminal.
 *
 * It is the same kit the home screen's "Upload logo" button builds, from the
 * same module (src/app/logo-kit.js): the palette themes every tool, the logo
 * replaces the wordmark in the header, and the tab and home-screen icons
 * become the logo. Product wording stays with the committed BRAND.
 *
 * Everything is stored on this device only: the palette in
 * `sdc_psychro_brand_v1` (read at boot by all three pages) and the logo and
 * its icons in `sdc_psychro_logo_v1`.
 */

import { applyBrand } from '../config/brand.js';
import { storage } from '../platform/index.js';
import { toast } from '../ui/notify.js';
import { inp } from '../ui/dom.js';
import {
  BRAND_KEY, applyKit, buildKit, clearKit, decodeImage, loadKit, loadPalette, saveKit,
} from './logo-kit.js';

export { BRAND_KEY };

/** The stored override, or null if none / unreadable / invalid. */
export function storedPalette() {
  return loadPalette(storage);
}

/** The stored logo kit, or null. */
export function storedKit() {
  return loadKit(storage);
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

  /** The kit built from the last upload, awaiting Apply. */
  let pending = null;

  file.addEventListener('change', async () => {
    const f = file.files && file.files[0];
    file.value = ''; // choosing the same file again must fire again
    if (!f) return;
    try {
      pending = buildKit(await decodeImage(f));
      if (!pending.palette) {
        toast('That logo has no colour in it, so only the icon and header will change.', { kind: 'warn' });
      }
      showPreview(pending.palette);
      const apply = /** @type {any} */ (inp('brand-apply'));
      if (apply) apply.disabled = false;
    } catch (err) {
      pending = null;
      toast(err instanceof Error ? err.message : 'Could not read that file as an image.', { kind: 'warn' });
    }
  });

  inp('brand-apply')?.addEventListener('click', () => {
    if (!pending) return;
    const r = saveKit(storage, pending.kit, pending.palette);
    const inForce = pending.palette || storedPalette();
    applyBrand(document, inForce);
    applyKit(document, pending.kit, inForce);
    if (r.ok) toast('Logo applied to every tool on this device. Already on your home screen? Remove it and add it again for the new icon.', { kind: 'ok', duration: 8000 });
    else toast('Applied for this session, but saving failed — it will not survive a reload.', { kind: 'warn', duration: 8000 });
  });

  inp('brand-reset')?.addEventListener('click', () => {
    clearKit(storage);
    pending = null;
    showPreview(null);
    const apply = /** @type {any} */ (inp('brand-apply'));
    if (apply) apply.disabled = true;
    applyBrand(document);
    applyKit(document, null, null);
    toast('Back to the built-in brand.', { kind: 'ok' });
  });

  // A stored override previews itself on load, so the card shows what is
  // currently in force rather than an empty state that contradicts the page.
  const current = storedPalette();
  if (current) showPreview(current);
}
