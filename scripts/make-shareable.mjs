/**
 * Produce StreamHallPlanner.html — the app as ONE self-contained file.
 *
 * `vite build` already bundles every module inline (vite-plugin-singlefile),
 * but the output still points at two sibling assets: the favicon and the PWA
 * manifest. Those 404 the moment the file travels alone by email or AirDrop,
 * so this step inlines the icon as a data URI and drops the manifest link (a
 * manifest is meaningless off an http origin). The result is shared like a
 * document and opens anywhere, fully offline.
 *
 * The sibling names are STABLE, not fingerprinted — `assetFileNames` in
 * vite.config.js turns hashing off, because `sw.js` precaches by literal path
 * and once precached the unhashed names while the HTML referenced the hashed
 * ones. The patterns below still accept an optional hash, so they keep matching
 * if fingerprinting ever returns rather than silently failing to substitute.
 *
 * Run via `npm run shareable` (which builds first). Output goes to the repo
 * root (the committed download, also used by the file:// E2E tests) and into
 * dist/ (what deploy.yml publishes — the live app's download link points at
 * ./StreamHallPlanner.html beside the deployed index).
 */
import { readFileSync, writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
let html = readFileSync(join(root, 'dist', 'planner.html'), 'utf8');
// One copy of the icon exists, at the repo root, and it is the same file vite
// emitted into dist/ — so this data URI is provably the built app's own image.
const icon =
  'data:image/png;base64,' + readFileSync(join(root, 'icon-192.png')).toString('base64');

// `\.?\/?` and `(?:-[\w-]+)?` make each pattern indifferent to a leading `./`
// and to fingerprinting, so neither cosmetic vite change can turn a required
// swap into a silent no-op.
// [pattern, replacement, required] — the banner <img> is usually inlined as a
// data URI by vite's asset threshold, so its swap is best-effort.
const swaps = [
  [/<link rel="manifest" href="\.?\/?manifest(?:-[\w-]+)?\.webmanifest">\n?/, '', true],
  [/href="\.?\/?icon-192(?:-[\w-]+)?\.png"/g, `href="${icon}"`, true],
  [/src="\.?\/?icon-192(?:-[\w-]+)?\.png"/g, `src="${icon}"`, false],
];
for (const [re, sub, required] of swaps) {
  if (!re.test(html)) {
    if (required) throw new Error(`pattern not found: ${re}`);
    continue;
  }
  html = html.replace(re, sub);
}
html = html.replace(
  '<title>',
  '<!-- Single-file distributable build. Source of truth: this repo; rebuild with `npm run shareable`. -->\n<title>',
);

const leftovers = html.match(/(src|href)="(?!data:|https:|#)[^"]*\.(png|webmanifest|css|js)"/g);
if (leftovers) throw new Error(`external refs remain: ${leftovers.join(', ')}`);

// Two copies, same bytes. The repo-root copy is the committed download that the
// raw-served tree and the file:// E2E tests use. The dist/ copy is what the
// DEPLOYED site links: deploy.yml publishes dist/ and the app's own download
// anchor points at ./StreamHallPlanner.html — without this copy that link
// 404'd in production while every test stayed green, because only the raw
// project asserted the link and the raw tree had the root copy.
// scripts/verify-bundle.mjs pins both presence and byte-equality.
const outputs = [join(root, 'StreamHallPlanner.html'), join(root, 'dist', 'StreamHallPlanner.html')];
for (const out of outputs) writeFileSync(out, html);
console.log(
  `wrote ${outputs.join(' and ')} (${(html.length / 1024).toFixed(0)} KB, no external refs)`,
);
