/**
 * The home screen's own script: the install offer, the offline worker, and
 * the "Upload logo" button.
 *
 * Small on purpose. The launcher exists to load instantly and hand you a
 * tool, so this imports only the pure palette and brand modules and the logo
 * kit, and Vite inlines all of it into index.html (see vite.config.js). The
 * page still makes no request it did not make before.
 *
 * The colours are applied before first paint by the inline script in
 * index.html's <head>; this adds the logo, the icons, and the button.
 */

import { applyBrand } from '../config/brand.js';
import {
  applyKit, buildKit, clearKit, decodeImage, deviceStore, loadKit, loadPalette, saveKit,
} from './logo-kit.js';
import { offerInstall, registerWorker } from './install-offer.js';

const store = deviceStore();
const $ = (id) => document.getElementById(id);

// ── Install, and stay current ───────────────────────────────────────────────
// This is the page the shared link opens and the installed app starts on, so
// it is where the offer to install has to be, and where the offline worker
// has to be registered: an app installed from here used to have no worker
// until the planner was opened once.
registerWorker({
  onUpdateReady: () => {
    $('update-note')?.classList.add('show');
  },
});
$('update-reload')?.addEventListener('click', () => location.reload());
offerInstall({ byId: $, store });

// ── Your logo ───────────────────────────────────────────────────────────────

/** One line of feedback under the button. There is no toast system here. */
function say(text, kind = '') {
  const el = $('logo-note');
  if (!el) return;
  el.textContent = text;
  el.dataset.kind = kind;
}

function showState(kit) {
  const reset = $('logo-reset');
  if (reset) reset.hidden = !kit;
  const pick = $('logo-pick');
  if (pick) pick.textContent = kit ? 'Change logo' : 'Upload logo';
}

const section = $('logo-kit');
if (section) section.hidden = false;

const kit = loadKit(store);
const palette = loadPalette(store);
applyKit(document, kit, palette);
showState(kit);

$('logo-pick')?.addEventListener('click', () => $('logo-file')?.click());

$('logo-file')?.addEventListener('change', async (e) => {
  const input = /** @type {HTMLInputElement} */ (e.target);
  const file = input.files && input.files[0];
  input.value = ''; // picking the same file again must fire again
  if (!file) return;
  try {
    const img = await decodeImage(file);
    const { kit: next, palette: colours } = buildKit(img);
    const saved = saveKit(store, next, colours);
    const inForce = colours || loadPalette(store);
    applyBrand(document, inForce);
    await applyKit(document, next, inForce);
    showState(next);
    const parts = [colours ? 'Colours and icon updated.' : 'Icon updated. That logo has no colour in it, so the colours stay as they were.'];
    parts.push('Already on your home screen? Remove it and add it again to get the new icon.');
    if (!saved.ok) parts.unshift('Applied for now, but this device would not save it, so it will be gone after a reload.');
    say(parts.join(' '), saved.ok ? 'ok' : 'warn');
  } catch (err) {
    say(err instanceof Error ? err.message : 'Could not read that file as an image.', 'warn');
  }
});

$('logo-reset')?.addEventListener('click', async () => {
  clearKit(store);
  applyBrand(document);
  await applyKit(document, null, null);
  showState(null);
  say('Back to the built-in colours and icon.', 'ok');
});
