/**
 * Branding — the one place identity lives.
 *
 * This used to be an aspiration: a BRAND object nobody imported, while the
 * real strings and hex codes sat inline in the stylesheet, the toast styles
 * and the PDF renderer. "Change it here" changed nothing. Now every surface
 * reads from this file, so swapping the branding is editing this file and
 * dropping new artwork in `assets/`.
 *
 * COLOURS ARE SAMPLED, NOT TYPED. `npm run brand:sample` decodes the logo
 * artwork, finds the dominant saturated colour, and derives the shades and
 * the interactive accent from it; `-- --write` rewrites the block below.
 * That keeps the palette honestly tied to the mark instead of drifting from
 * it one hand-picked hex at a time.
 *
 * The accent's saturation and lightness are fixed rather than sampled, so a
 * future logo in any hue still yields something legible on a dark interface —
 * the app's contrast must not depend on the artwork's.
 */

/** Palette derived from `assets/` by scripts/sample-brand-colors.mjs. */
export const PALETTE = {
  /* SAMPLED:start */
  primary: '#193c76',
  primaryDark: '#11284e',
  primaryLight: '#4c6794',
  accent: '#10a8c6',
  accentDark: '#0b758b',
  /* SAMPLED:end */
};

/** Names and wording. Everything an operator reads that is not a number. */
export const BRAND = {
  company: 'STREAM',
  companySub: 'DATA CENTERS',
  product: 'Hall Environment Planner',
  tagline: 'Critical Engineering · ASHRAE TC 9.9',
  ...PALETTE,
};

/**
 * The palette as CSS custom properties.
 *
 * The stylesheet declares these same names with the current values as
 * literals, so the app still renders correctly with scripting disabled and in
 * any context that never runs `applyBrand()`. This overrides them at boot,
 * which is what makes a swapped brand take effect everywhere at once —
 * including rules this module has never heard of.
 */
export const CSS_VARS = {
  '--brand-primary': PALETTE.primary,
  '--brand-primary-dark': PALETTE.primaryDark,
  '--brand-primary-light': PALETTE.primaryLight,
  '--brand-accent': PALETTE.accent,
  '--brand-accent-dark': PALETTE.accentDark,
  // Legacy names the stylesheet has used since before the palette was
  // derived. Kept pointed at the brand so existing rules follow a swap.
  '--stream-navy': PALETTE.primary,
  '--stream-teal': PALETTE.accent,
  '--accent': PALETTE.accent,
};

/** Push the brand onto the document, and the product name into the title. */
export function applyBrand(doc = document) {
  const root = doc.documentElement;
  for (const [k, v] of Object.entries(CSS_VARS)) root.style.setProperty(k, v);
  const sub = doc.querySelector('[data-brand="company"]');
  if (sub) sub.textContent = BRAND.company;
  const subtitle = doc.querySelector('[data-brand="companySub"]');
  if (subtitle) subtitle.textContent = BRAND.companySub;
  const product = doc.querySelector('[data-brand="product"]');
  if (product) product.textContent = BRAND.product;
  const tagline = doc.querySelector('[data-brand="tagline"]');
  if (tagline) tagline.textContent = BRAND.tagline;
}
