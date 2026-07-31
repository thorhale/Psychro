/**
 * The privacy policy, as data.
 *
 * Both app stores require a privacy policy: a public URL in the store console
 * (served as /privacy.html on the deployed site) AND access from inside the
 * app (Google Play's User Data policy requires the in-app copy). This module
 * is the in-app copy, shown from the footer via `confirmDialog`, so it works
 * offline, over file://, and in the native shells without any network.
 *
 * `privacy.html` at the repo root carries the same statements for the hosted
 * URL. `test/assets.test.js` asserts every line below appears there verbatim,
 * so the two copies cannot drift apart silently — if the policy changes, both
 * files and the store-console answers must change together (see
 * docs/store/README.md).
 */

export const PRIVACY_TITLE = 'Privacy';

/** Each entry is one plain-language statement, rendered as a line. */
export const PRIVACY_STATEMENTS = [
  'This app does not collect, transmit, sell, or share any data.',
  'Everything you enter — halls, SLA profiles, scenarios — stays on your device.',
  'The app makes no network requests after it loads; it works fully offline.',
  'There are no accounts, no analytics, no advertising, and no tracking of any kind.',
  'Deleting the app deletes everything it stored.',
];

/** The dialog body: the statements joined for `confirmDialog`'s message. */
export const PRIVACY_TEXT = PRIVACY_STATEMENTS.join('\n\n');
