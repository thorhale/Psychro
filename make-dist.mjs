// Build the single-file distributable: dist/StreamHallPlanner.html
//
// The app is already one HTML file, but it leans on four sibling files
// (manifest, two icon references, sw.js) that 404 when someone receives
// index.html alone by email/AirDrop/Teams. This inlines the icons as data
// URIs and strips the PWA plumbing that only functions on an http(s) origin,
// so the output is a complete app in one file — share it like a PDF, open it
// anywhere, works fully offline.
//
//   node make-dist.mjs
import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const root = dirname(fileURLToPath(import.meta.url));
let html = readFileSync(join(root, 'index.html'), 'utf8');
const icon = 'data:image/png;base64,' + readFileSync(join(root, 'icon-192.png')).toString('base64');

const swaps = [
  // PWA manifest — meaningless from file:// and would 404 when hosted alone
  [/<link rel="manifest" href="manifest.webmanifest">\n?/, ''],
  // Icons → data URIs so the tab icon and install banner still render
  [/href="icon-192\.png"/g, `href="${icon}"`],
  [/src="icon-192\.png"/g,  `src="${icon}"`],
  // Service-worker registration — sw.js isn't in this file; registration is
  // already http-guarded but would 404 if the single file is hosted somewhere
  [/if \('serviceWorker' in navigator[^\n]*\n/, '// service worker omitted in single-file build (no sw.js alongside)\n'],
];
for (const [re, sub] of swaps) {
  if (!re.test(html)) throw new Error('pattern not found: ' + re);
  html = html.replace(re, sub);
}
html = html.replace('<title>', '<!-- Single-file distributable build. Source of truth: index.html in the repo. -->\n<title>');

mkdirSync(join(root, 'dist'), { recursive: true });
const out = join(root, 'dist', 'StreamHallPlanner.html');
writeFileSync(out, html);
console.log(`wrote ${out} (${(html.length / 1024).toFixed(0)} KB)`);
const leftovers = html.match(/(src|href)="(?!data:|https:|#)[^"]+\.(png|js|webmanifest|css)"/g);
console.log('external file refs remaining:', leftovers ?? 'none');
