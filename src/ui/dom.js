/**
 * Typed element lookups.
 *
 * `document.getElementById` is declared to return `HTMLElement`, which has no
 * `.value`, no `.checked`, no `.files` and no `.getContext`. Every one of this
 * app's several hundred control reads therefore fails a type check, and the
 * usual response — casting at each call site — buries the code in noise and
 * teaches nobody anything.
 *
 * These helpers state the intent once. Picking the wrong one is caught the
 * moment you use a member the chosen kind does not have, which is the same
 * protection an inline cast gives, minus the repetition.
 */

/** A control the app reads a value from: input, select or textarea. */
export const inp = (id) =>
  /** @type {HTMLInputElement|null} */ (document.getElementById(id));

/** A plain element — content, classes, listeners; no value. */
export const el = (id) =>
  /** @type {HTMLElement|null} */ (document.getElementById(id));

/** A canvas, for the chart and every exported image. */
export const canvasEl = (id) =>
  /** @type {HTMLCanvasElement|null} */ (document.getElementById(id));
