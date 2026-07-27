# Contributing

This is a planning tool for critical facilities. Numbers it displays get acted
on. The conventions below exist to keep that trustworthy — they are about
accuracy and traceability, not ceremony.

## The gate

Everything must pass before a push:

```bash
npm ci
npm run lint
npm run typecheck
npm test                      # unit + CoolProp oracle + invariants + consistency
npm run build
npm run verify:bundle         # artifact integrity
npm run e2e                   # boots dist/, incl. offline + visual goldens
```

CI runs the same set. `npm run e2e` needs a build first — it deliberately tests
`dist/`, not the dev server.

## The accuracy contract

**Any change under `src/core/` must include the `npm run analyze` table, before
and after, in the pull request description.** That table is the measured
deviation from CoolProp across 3,898 reference points; it is the evidence that a
change to the physics did what it claimed and nothing else.

**Tolerances in `test/psychro.test.js` are frozen.** They record measured
worst-case error, not aspiration. If a change trips one:

1. Assume the change is wrong and investigate. A tripped tolerance has caught a
   real defect every time so far.
2. Only if the change is genuinely an improvement may the tolerance move — and
   then `docs/coolprop-comparison.md` §4 must be updated in the **same commit**,
   so the documented accuracy and the enforced accuracy can never disagree.

**Never assert a physical "law" without checking it against CoolProp first.**
Two invariant tests were written asserting things that turned out to be false
(mixture viscosity is *not* monotone in temperature at fixed RH). The oracle
settles these questions; intuition does not.

If you change the validated domain in `src/core/domain.js`, regenerate the
reference grid so the guard and the oracle stay in agreement:

```bash
pip install CoolProp
npm run reference
```

A CI test asserts those two declarations match, so a drift fails the build
rather than quietly widening what the app claims to be validated for.

## Single sources of truth

Every number the user sees should trace to exactly one tested implementation.

- Physics lives in `src/core/`. The UI never re-derives a property — it calls
  `deriveState` (`src/core/derive.js`).
- Contract logic (SLA compliance, envelopes) lives in `src/core/envelopes.js`,
  including the operator-facing strings. The UI binds; it does not reimplement.
- Anything touching persisted data needs a fixture test proving old saves still
  load, written **before** the refactor and captured from the current
  implementation's actual output. See `test/persistence.test.js`.

## Versioning and releases

Semantic versioning. The `version` in `package.json` is load-bearing: the
service-worker cache key and the in-app footer stamp derive from it plus the git
SHA, so **bumping the version is what rolls an update out to installed apps**.

- `patch` — fixes with no behaviour change for correct inputs
- `minor` — new features, new properties, new UI
- `major` — changed persisted-data format, or a physics change that moves
  displayed numbers

Record the change in `CHANGELOG.md` under `[Unreleased]` as you go; move it to a
version heading when you bump. Tag `v2.x.y` on merge. Merging to `main` deploys
to GitHub Pages automatically, behind the full gate.

## Visual goldens

`test/e2e/visual.spec.js-snapshots/` holds committed chart screenshots. After an
intentional visual change:

```bash
npm run build && npm run e2e:update
```

Look at the regenerated images before committing them — the point of a golden is
that a human confirmed it. Don't add a golden that duplicates an existing one; a
snapshot that never differs from another costs a re-bless and pins nothing.

## Recommended repo settings

Branch protection on `main` requiring the `test`, `build` and `e2e` checks.
