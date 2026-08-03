/**
 * Escape user-supplied text for HTML interpolation.
 *
 * Every name in this app — halls, sites, SLA profiles, scenarios, sensors —
 * can arrive from a COLLEAGUE'S SAVE FILE, not just from the keyboard, so
 * "the user only hurts themselves" was never true: a shared save file with a
 * crafted hall name would run in this origin with access to every stored
 * profile and the whole calibration logbook. Anywhere such a string meets
 * `innerHTML`, it goes through here first.
 *
 * Its own module because every panel that renders a name needs it, and a
 * panel that has to reach back into main.js for its escaping is a panel that
 * will eventually be written without any.
 *
 * @param {unknown} s
 * @returns {string}
 */
export const escHtml = (s) =>
  String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
