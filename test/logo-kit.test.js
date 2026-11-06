/**
 * The logo kit's pure parts: what a logo sits on, where it is drawn on an
 * icon, how the install manifest is re-pointed, and what a stored kit has to
 * look like before any of it is allowed near an <img> or a <link>.
 *
 * The canvas half (buildKit, applyKit) is driven end to end in
 * test/e2e/logo.spec.js, in a real browser.
 */

import { describe, it, expect } from 'vitest';
import {
  chooseBackdrop, iconRect, manifestWithKit, isValidKit, saveKit, loadKit, clearKit, loadPalette,
  LOGO_KEY, BRAND_KEY,
} from '../src/app/logo-kit.js';

/** An RGBA image of w×h filled by fn(x, y) → [r, g, b, a]. */
function image(w, h, fn) {
  const px = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) px.set(fn(x, y), (y * w + x) * 4);
  return px;
}

const PNG = 'data:image/png;base64,iVBORw0KGgo=';
const KIT = { v: 1, logo: PNG, bg: '#ffffff', icons: { i192: PNG, i512: PNG, m512: PNG, a180: PNG } };

/** A store with the same contract as the platform's: set → {ok}. */
function memStore({ failOn = null } = {}) {
  const m = new Map();
  return {
    m,
    get: (k) => (m.has(k) ? m.get(k) : null),
    set: (k, v) => { if (k === failOn) return { ok: false }; m.set(k, v); return { ok: true }; },
    remove: (k) => { m.delete(k); },
  };
}

describe('chooseBackdrop', () => {
  it('an opaque logo keeps its own paper, sampled from the border', () => {
    // Cream paper, a navy block in the middle: the icon tile must be cream.
    const px = image(20, 20, (x, y) => (x > 5 && x < 14 && y > 5 && y < 14 ? [25, 60, 118, 255] : [250, 245, 230, 255]));
    expect(chooseBackdrop(px, 20, 20)).toBe('#faf5e6');
  });

  it('a dark mark on transparency gets white', () => {
    const px = image(20, 20, (x, y) => (x > 5 && x < 14 && y > 5 && y < 14 ? [25, 60, 118, 255] : [0, 0, 0, 0]));
    expect(chooseBackdrop(px, 20, 20)).toBe('#ffffff');
  });

  it('a white mark on transparency gets the app dark, so it cannot vanish on white', () => {
    const px = image(20, 20, (x, y) => (x > 5 && x < 14 && y > 5 && y < 14 ? [255, 255, 255, 255] : [0, 0, 0, 0]));
    expect(chooseBackdrop(px, 20, 20)).toBe('#0d1b2a');
  });

  it('a fully transparent image still yields a usable colour', () => {
    expect(chooseBackdrop(image(4, 4, () => [0, 0, 0, 0]), 4, 4)).toBe('#ffffff');
  });
});

describe('iconRect', () => {
  it('keeps the aspect ratio and centres the logo', () => {
    const r = iconRect(300, 100, 512, false);
    expect(r.w / r.h).toBeCloseTo(3, 9);
    expect(r.x + r.w / 2).toBeCloseTo(256, 9);
    expect(r.y + r.h / 2).toBeCloseTo(256, 9);
    expect(r.w).toBeCloseTo(0.84 * 512, 9); // wide logo: width is the limit
  });

  it('a maskable icon keeps every corner of the logo inside the 80 % safe circle', () => {
    for (const [w, h] of [[100, 100], [400, 100], [100, 400], [1000, 37]]) {
      const r = iconRect(w, h, 512, true);
      const corner = Math.hypot(r.w / 2, r.h / 2);
      expect(corner).toBeLessThanOrEqual(0.4 * 512 + 1e-9);
      expect(corner).toBeGreaterThan(0.4 * 512 - 1e-6); // and uses all of it
    }
  });
});

describe('manifestWithKit', () => {
  const shipped = {
    name: 'Planner', start_url: './', scope: './', id: '/Psychro/', theme_color: '#1a3a5c',
    icons: [{ src: 'icon-192.png', sizes: '192x192' }],
    screenshots: [{ src: 'screenshot-wide.png', sizes: '1280x800' }],
  };
  const href = 'https://example.org/Psychro/manifest.webmanifest';

  it('swaps only the icons and the theme colour', () => {
    const m = manifestWithKit(shipped, KIT, href, { primary: '#8b1a1a' });
    expect(m.name).toBe('Planner');
    expect(m.icons.map((i) => [i.sizes, i.purpose])).toEqual([
      ['192x192', 'any'], ['512x512', 'any'], ['512x512', 'maskable'],
    ]);
    expect(m.icons.every((i) => i.src === PNG)).toBe(true);
    expect(m.theme_color).toBe('#8b1a1a');
    expect(shipped.icons[0].src).toBe('icon-192.png'); // the input is not mutated
  });

  it('makes every URL absolute, because a blob: copy cannot resolve relative ones', () => {
    const m = manifestWithKit(shipped, KIT, href, null);
    expect(m.start_url).toBe('https://example.org/Psychro/');
    expect(m.scope).toBe('https://example.org/Psychro/');
    expect(m.screenshots[0].src).toBe('https://example.org/Psychro/screenshot-wide.png');
    // Same identity as the shipped manifest, so the browser sees the same app.
    expect(m.id).toBe('https://example.org/Psychro/');
    expect(m.theme_color).toBe('#1a3a5c'); // no palette: theme left alone
  });
});

describe('the stored kit', () => {
  it('accepts exactly what buildKit writes', () => {
    expect(isValidKit(KIT)).toBe(true);
  });

  it('rejects anything that could put a foreign URL into the page', () => {
    expect(isValidKit({ ...KIT, logo: 'https://evil.example/x.png' })).toBe(false);
    expect(isValidKit({ ...KIT, logo: 'javascript:alert(1)' })).toBe(false);
    expect(isValidKit({ ...KIT, icons: { ...KIT.icons, i192: 'data:text/html;base64,PHNjcmlwdD4=' } })).toBe(false);
    expect(isValidKit({ ...KIT, bg: 'red;background:url(x)' })).toBe(false);
    expect(isValidKit({ ...KIT, v: 2 })).toBe(false);
    expect(isValidKit({ ...KIT, icons: { i192: PNG } })).toBe(false);
    expect(isValidKit(null)).toBe(false);
  });

  it('round-trips through a store and clears completely', () => {
    const s = memStore();
    const pal = { primary: '#8b1a1a', primaryDark: '#5b1111', primaryLight: '#a94747', accent: '#14b1d1', accentDark: '#0e7c92' };
    expect(saveKit(s, KIT, pal).ok).toBe(true);
    expect(loadKit(s)).toEqual(KIT);
    expect(loadPalette(s)).toEqual(pal);
    clearKit(s);
    expect(s.m.has(LOGO_KEY)).toBe(false);
    expect(s.m.has(BRAND_KEY)).toBe(false);
  });

  it('a colourless logo leaves the colours already in force alone', () => {
    const s = memStore();
    s.set(BRAND_KEY, '{"keep":"me"}');
    saveKit(s, KIT, null);
    expect(s.get(BRAND_KEY)).toBe('{"keep":"me"}');
  });

  it('a refused write leaves no half-kit behind and says so', () => {
    const s = memStore({ failOn: BRAND_KEY });
    const pal = { primary: '#8b1a1a', primaryDark: '#5b1111', primaryLight: '#a94747', accent: '#14b1d1', accentDark: '#0e7c92' };
    expect(saveKit(s, KIT, pal).ok).toBe(false);
    const full = memStore({ failOn: LOGO_KEY });
    expect(saveKit(full, KIT, pal).ok).toBe(false);
    expect(full.m.has(LOGO_KEY)).toBe(false);
  });

  it('garbage in the store reads as no kit', () => {
    const s = memStore();
    s.set(LOGO_KEY, '{"v":1,"logo":');
    expect(loadKit(s)).toBeNull();
  });
});
