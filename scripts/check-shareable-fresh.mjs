/**
 * Guard: the committed StreamHallPlanner.html must be a build of the CURRENT
 * source.
 *
 * That file is committed (Pages serves the repo raw, so it has to be) and is
 * what people download. If someone edits `src/` and forgets `npm run
 * shareable`, the downloaded app silently drifts from the hosted one — which
 * has already happened once and is the whole reason this check exists.
 *
 * Plain byte equality does NOT work: the bundle embeds the build's git SHA
 * (`v2.0.0 (1b5f5d6)`), so a file committed at one commit can never match a
 * rebuild at a later commit. `git diff --exit-code` on it therefore fails on
 * every single run regardless of drift — it reports the commit ID, not staleness.
 *
 * So: normalise the version stamp on both sides, then compare. Everything that
 * actually comes from source still has to match exactly.
 *
 *   node scripts/check-shareable-fresh.mjs <committed-copy> <freshly-built>
 */
import { readFileSync } from 'fs';

const [committedPath, freshPath] = process.argv.slice(2);
if (!committedPath || !freshPath) {
  console.error('usage: check-shareable-fresh.mjs <committed> <fresh>');
  process.exit(2);
}

/** Blank out the one token that legitimately changes between builds. */
const VERSION_STAMP = /v\d+[\w.-]*\s\([0-9a-f]{6,40}\)/g;
const normalise = (s) => s.replace(VERSION_STAMP, 'vVERSION (SHA)');

const committed = normalise(readFileSync(committedPath, 'utf8'));
const fresh = normalise(readFileSync(freshPath, 'utf8'));

if (committed === fresh) {
  console.log('StreamHallPlanner.html is a build of the current source ✓');
  process.exit(0);
}

// Report enough to act on: where they diverge and what is around it.
let i = 0;
while (i < committed.length && i < fresh.length && committed[i] === fresh[i]) i++;
const ctx = (s) => JSON.stringify(s.slice(Math.max(0, i - 100), i + 100));
console.error(
  [
    'StreamHallPlanner.html is STALE — it is not a build of the current source.',
    '',
    `  committed length ${committed.length}, fresh length ${fresh.length}`,
    `  first difference at character ${i}`,
    `  committed: ${ctx(committed)}`,
    `  fresh    : ${ctx(fresh)}`,
    '',
    'Fix: run `npm run shareable` and commit the regenerated file.',
  ].join('\n'),
);
process.exit(1);
