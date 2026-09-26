# Contributing Guidelines

## Code Style

### Braces and Control Flow

Always wrap code blocks in braces, even single-line ones.

```ts
// Bad
if (!site) return;

// Good
if (!site) {
  return;
}
```

Enforced by the `curly` ESLint rule. Caveat: custom style rules must be declared **after** the `prettier` block in `eslint.config.mjs` — `eslint-config-prettier` sets `curly` to off, so a rule placed before that block is silently disabled.

Invert conditions early to reduce nesting:

```ts
// Bad
if (sliders.length > 0) {
  // 20 lines of indented code
}

// Good
if (sliders.length === 0) {
  return;
}
// 20 lines at base indentation
```

### Loops

Don't use `.forEach`. Use `for..of`.

```ts
// Bad
sites.forEach(site => { });

// Good
for (const site of sites) { }
```

### Lambdas

Single-param lambdas: use `x`. Saves naming time, reads clearly. Use full names only when `x` would be unclear.

```ts
const disabled = sliders.every(x => x.classList.contains('rc-slider-disabled'));
```

**Exception — `subscribe` callbacks:** When subscribing to elements from `C.X.className`, use `className` as the parameter name. Avoids name collisions in nested subscribes and keeps the selector self-documenting.

```ts
// subscribe to C.ColoredValue.negative → param is "negative"
subscribe($$(tile.anchor, C.ColoredValue.negative), negative => {
  negative.classList.add($style.lowValue);
});
```

### Numeric Truthiness

When `0` is a legal value (slider positions, prices, rates), compare against `undefined` explicitly. Truthiness checks both fail ESLint (`Unexpected object value in conditional` on optional-chained/object-typed values) and silently treat `0` as "missing".

```ts
// Bad
if (!fuel) { return; }
const initial = combo.fuel ? getSliderValue(combo.fuel) : undefined;

// Good
if (fuel === undefined) { return; }
const initial = combo.fuel !== undefined ? getSliderValue(combo.fuel) : undefined;
```

### Type Annotations

Don't add type definitions where TypeScript can infer the type.

```ts
// Bad
contextItems: (parameters: string[]) => { }

// Good (type inferred from contextItems signature)
contextItems: parameters => { }
```

### Template Literals

Don't wrap a single variable in `${}`.

```ts
// Bad
applyCssRule('INV', `${C.StoreView.row}`, classes.storeInfo);

// Good
applyCssRule('INV', C.StoreView.row, classes.storeInfo);
```

### Non-null Assertions

Use `!` for `parentElement` and similar DOM properties that are guaranteed to exist when we process elements at DOM-appearance time. Don't use `as HTMLDivElement` casts for this — `!` is shorter and clearer.

```ts
// Bad
tile.anchor.parentElement as HTMLDivElement

// Good
tile.anchor.parentElement!
```

### Array Access with Truthiness Checks

`arr[i]` is typed non-`undefined` (no `noUncheckedIndexedAccess`), so `if (arr[i])` fails `strict-boolean-expressions`. Use `.at(i)` (returns `T | undefined`) for arrays, and `children.item(i)` (returns `Element | null`) for DOM collections.

### Nullish Checks

Don't use `||` with numbers — use explicit checks.

```ts
// Bad
const divisor = value || 1;

// Good
let divisor = value;
if (divisor === 0) {
  divisor = 1;
}
```

### Truthiness Checks on Objects

ESLint `strict-boolean-expressions` rejects truthiness checks on object-typed values (array indexing, record lookups). Compare against `undefined` explicitly.

```ts
// Bad
const next = stops[i + 1];
if (next) { }

// Good
const next = stops[i + 1];
if (next !== undefined) { }
```

### null vs undefined

Some PrUn API fields are `| null` (e.g. `Ship.address`) while helper functions accept `| undefined`. Convert with `?? undefined` instead of disabling types.

```ts
// Bad
getEntityNaturalIdFromAddress(ship.address) // TS error: null not assignable

// Good
getEntityNaturalIdFromAddress(ship.address ?? undefined)
```

### Comments

Put on a separate line, start with a capital letter, end with a full stop.

```ts
// Bad
const x = foo; // gets the thing

// Good
// Gets the thing.
const x = foo;
```

### Unicode

Prefer unicode escape values over characters for non-standard or font-awesome codepoints — easier to search for.

```ts
// Bad
'\u{1F441}'  // or pasting the emoji directly

// Good
'\uf070'  // font-awesome eye-slash
```

Standard unicode symbols (arrows, geometric shapes, etc.) are fine as literal characters.

### CSS Values

Omit `px` from zero values.

```css
/* Bad */
padding-top: 0px;

/* Good */
padding-top: 0;
```

---

## Feature Design Rules

### Basic vs. Advanced

The split between `basic/` and `advanced/` is documented in `feature-patterns.md`. The key decision criterion: if a feature removes, shortens, or hides information, it goes in `advanced/`.

### One Feature, One Responsibility

Don't combine unrelated functionality. If you're shortening material names AND hiding fee collector links, those are two features.

### Feature Dependencies

Don't make one feature depend on another — 95% chance the design is wrong. Merge tightly coupled functionality into a single feature instead.

### Vanilla Bugs

Fixes for base-game PrUn bugs go in `src/features/basic/prun-bugs.ts`, not in a separate feature.

### Feature Settings Philosophy

All features are enabled by default. If a feature needs to be "disabled by default", it probably doesn't belong in the extension.

Minimize settings. Features should either:
- Work for everyone as a nonconfigurable default, or
- Have settings placed right where the feature is used (not in a global settings page)

Adding extra settings/toggles has costs: UI bloat, more code to maintain, and removal is harder than addition because someone always ends up using them.

### Feature Approval Threshold

New features that take vertical space or are potentially controversial need a Discord poll. If less than ~75% vote yes, the feature is rejected. Vertical space is precious — users are very defensive about it.

---

## UI/UX Philosophy

### Minimize New Elements

PrUn UI is already packed with information. Don't add elements unless they bring clear value. Every tooltip, button, or indicator should be justified for its specific context — avoid global/blanket application.

### Respect PrUn's Visual Style

Don't use overly bright or imposing colors. PrUn has a toned-down interface — use colors already in the game's palette.

```css
/* Bad: too imposing for a non-critical warning */
background-color: rgb(255, 0, 0);

/* Good: uses PrUn's own red */
background-color: rgb(217, 83, 79);
```

### Tooltips

Use `data-tooltip` attribute for instant tooltips (PrUn-style). Don't use `title` attribute — browser tooltips have a ~2 second delay, and most players will never see them.

### Server Communication & ToS

Every action that triggers server communication must require a user click. No automated server requests without explicit player action. This is a hard rule from the game developers.

The extension does make some background server requests (e.g., `XIT BURN` opens invisible buffers). This is a known ToS violation with explicit developer permission — don't extend this pattern without discussion.

---

## Workflow

### Pulling Updates

`main` tracks the `nn` remote (Euovo/NN), but that remote is not used — pulls must come from `origin` (CMDRKilmer/RUNCN). The `xxc` remote is unreachable and can be ignored/removed. Local uncommitted `public/manifest.json` version bumps are intentional user state; preserve them across pulls and rebuilds. Rebuild dist with `pnpm run build` after merging.

### Changelog

Don't modify `CHANGELOG.md` in PRs. The maintainer adds changelog notes right before merging. This avoids merge conflicts.

### Release

Releases are cut by CI (`.github/workflows/release.yml`); never tag or zip by hand.

- **Trigger:** a push to `main` that touches `CHANGELOG.md`, or a manual `workflow_dispatch` (optional `keep` input). Pushing anything else never publishes.
- **Version:** today's date in `Asia/Shanghai` as `y.m.d` (e.g. `26.9.23`), with `.1`/`.2` appended for a second release on the same day — it never rolls over to the next day. Existing tags are skipped.
- **An empty `[Unreleased]` fails loudly:** the parse step exits with code 78, which makes the `build` job **red** (it is not a graceful skip). Don't push a `CHANGELOG.md` edit just to probe the pipeline.
- **Output:** a GitHub Release with `琉璃小工具-<version>.zip` + `.crx`, plus automatic submissions to Chrome, Edge and Firefox (AMO). Those store jobs have **no approval gate**, and a published store version cannot be rolled back — proofread the notes before pushing.
- **Asset filenames must be pure ASCII.** GitHub strips non-ASCII characters from release **asset** names, so every release up to and including `26.9.26` shipped assets named `-<version>.zip` / `-<version>.crx` — the prefix was silently *deleted*, not mangled. This is a property of the asset name, not of the workflow, and the obvious hypothesis is wrong: `26.9.26` set `FILENAME_ZIP="琉璃小工具-$VERSION.zip"` as a literal inside the `run` script (not via `env`), the local file really had that name, and the uploaded asset still came back as `-26.9.26.zip`. The release **title** is a separate field and keeps its Chinese. Use `RefinedPrun-<version>.zip` / `.crx` and put the Chinese brand only in `--title`.
- **`archive` job:** runs as `github-actions[bot]`, moves the `[Unreleased]` body into a versioned section, syncs `package.json` `version`, then pushes back to `main`. It pushes with `GITHUB_TOKEN`, so it does not re-trigger the workflow. Run `git pull --ff-only` after a release before pushing again.
- **`prune` job:** keeps the newest `KEEP_RELEASES` (env, default 10) releases and deletes older ones **including their tags**.
- **Edge key expiry:** `EDGE_API_KEY_EXPIRY` in `release.yml` must stay in sync with `edge-key-expiry.yml` — update both when renewing.
- Notes are parsed with `^## \[Unreleased\][\s\S]*?(?=^## \[|^---$)`, so a bare `---` line inside the body truncates the release notes.

### Check Open PRs Before Starting Work

Before beginning new feature work, run `gh pr list --state open` (or equivalent) to see what's already in flight. Code search and the working tree reflect only `main` (or the current branch); unmerged feature branches are invisible to the search agent and to file reads. Duplicating an already-developed feature wastes effort and produces conflicting PRs.

### Import Sorting

Don't enable auto-import-sorting in your editor. It creates merge conflicts when the same file is touched in two branches. Import sorting should be project-wide (via eslint/prettier), not per-editor.

### Dead Code Cleanup

Tool output (knip, tsc no-unused) needs manual verification before deletion:
- unimport auto-imports symbols from 9 modules (see architecture.md) — usage without an import statement is normal.
- Modules mount exports as object properties (e.g. `contractsStore.active`) — check the store object's property accessors, not just named imports.
- Local same-name implementations can shadow exports (e.g. PLAN.vue defines its own `isProductionBuilding`).

Verify with `pnpm run compile` and `pnpm run lint` after removal.

### Existing Components

Check `src/components/` before creating new UI components. Reusable components like `PrunButton`, `PrunLink`, `ContextControls`, and `ContextControlsItem` already exist.

Use Vue slots instead of adding new props to display custom text inside existing components.

```tsx
// Bad: adding a commandText prop to PrunLink
<PrunLink command="MAT RAT" commandText="RAT" />

// Good: using slots
<PrunLink inline command={`MAT ${material}`}>
  {material}
</PrunLink>
```

### Keep Docs and Comments in Sync

A behavior change must be propagated to **every** place that asserts the old behavior: `docs/`, `guides/`, source file-header comments, and the header comments of `scripts/verify-*.mjs`. These files accumulate "round N" narratives that describe superseded behavior, so a stale claim can end up sitting right next to a correct one and contradicting it (including comments that say a feature is still gated when the gate was deleted).

After changing an interface, constant, or calibration:

1. Grep the old conclusion's keywords (e.g. `未标定`, `待办`, `偏快`, or the old numeric sample) across `docs/`, `guides/`, `src/` and `scripts/`.
2. Run `find docs/ -name "*.md" | sort` and check every affected file.
3. User-facing text must compute its numbers from the current run — never hardcode a value taken from a historical sample, because the next reader will silently compare it against a fresh reading and get a contradiction.

### Type Checking Covers `.vue` Too

`pnpm run compile` runs `vue-tsc --noEmit`, not `tsc --noEmit`. Plain `tsc` cannot parse `.vue`, so every `<script setup lang="ts"` block was invisible to both `compile` and CI, and its errors surfaced only in the editor (Volar). Four of them survived ~3 weeks and three releases. `lint.yml` already runs `pnpm compile && pnpm lint` on every push/PR, so changing the script gave CI full coverage with no workflow edit. Keep `vue-tsc` in `devDependencies`; `typescript` alone does not check `.vue`. A `get_errors`/editor read on a file that was never opened in the session reports nothing — run `pnpm exec vue-tsc --noEmit --pretty` when you need the real list.

### Local Lint Noise (`dist-firefox`, `.tmp`)

ESLint does not read `.gitignore`, so every non-source directory that can exist in a working tree has to be listed in `eslint.config.mjs`'s `ignores`. Two were missing:

- `dist-firefox/` (build output) — `pnpm run lint` failed locally with ~1250 "Parsing error ... TSConfig does not include this file" errors after minutes of scanning bundled output.
- `.tmp/` (scratch scripts written by skills such as `/save-plan` and `/review-pr`) — 3 parsing errors, because those `.mjs` files fall outside `tsconfig.json`'s `include`.

Both are ignored now, so `pnpm run lint` is clean locally (~40 s). CI was never affected — a fresh checkout has neither directory, which is why the failure looked local-only. When adding a gitignored directory that can hold `.js/.ts/.mjs/.vue`, add it to `ignores` in the same commit instead of working around it by linting single files. Note `scripts/*.mjs` are excluded from eslint entirely (they are only type/format checked via prettier).

### Windows-created Files Are CRLF

Files created on Windows (e.g. by an agent's file tool) default to CRLF line endings, but the repo is LF. ESLint then reports hundreds of `prettier/prettier` "Delete `␍`" warnings on every line of the new file — this is a line-ending issue, not a formatting one. Run `prettier --write <file>` on the new files (fixes line endings + formatting in one pass) and re-lint before considering it done.

### Regression Scripts Drive Real Modules

`scripts/verify-*.mjs` are exit-code-checked regression scripts (末行 `PASS n/n`；失败行 `FAIL <场景> expected=… actual=…`；用法写在文件头注释里，含明确局限)。

- Prefer driving the **real** module: a Node loader hook (`scripts/lib/*-loader.mjs`) redirects only browser-side deps (`vue`, `@src/*`) to stubs while the logic under test (routing, model, orchestration) keeps its real implementation. Never re-implement the logic inside the stub — the test would then prove nothing about production.
- If the logic lives in a file that cannot load in Node (Vue/DOM features), extract the pure part into its own module and drive that (e.g. `sfc-route-push-gate.ts` for the SFC push gate). Non-feature helper files living next to features are fine — see `src/features/basic/parse-safe-image.ts`.
- A stub that turns a code path into a no-op makes every assertion about that path near-vacuous. Give the stub an observable difference instead (e.g. `showBuffer` records calls and `hasSystemData` only flips true after it) and assert the difference.
- **Write expected constants as literals in the assertion, never `import` the production constant of the same name** (e.g. `1234`, `0.42`). If the constant is wrong, an assertion that imports it drifts along with it and stays green — the test then proves nothing about the number it claims to lock. Production constants are for driving the code under test, not for spelling out expectations.
- Each check prepares its own state (fixtures, store contents, timers). A check leaning on the previous check's leftovers silently drifts when run alone or reordered.
- Debounced persistence means a synchronous `localStorage.getItem` right after a dispatch reads stale data — await the debounce first (`settlePersist()` in `verify-ftc-geometry-source.mjs`, matching the 1000ms debounce in `system-bodies.ts`).
- Reviewing an **assertion change** (any `⚠️ 断言变更记录（第 N 轮）`): re-keying a fixture is not weakening per se, but three things must hold together — the expected values are not smaller, at least one **negative assertion** was added (the old key/path must be `undefined`), and an **independent source** corroborates the same conclusion (another script, a real data file, or a physical derivation). "All tests green" is not evidence by itself: when fixture and implementation share an author, editing the fixture *is* editing the answer. Print the **actual** value with a throwaway diagnostic before changing code — never infer it. When checking that an old wording is really gone, use `git grep -E`: under the default BRE, `A|B` is a literal, so a "clean" result can be a false negative.
- A **write path and its lookup path that are wrong in the same way stay green** — they are self-consistent, so the bug hides (e.g. `recordStlSegments` wrote the approach key from `lastJump.origin` while `routeMetrics` read `lastLeg.from`; both matched, so natural-route lookups never failed and only the gateway route exposed it). Symmetry between the two ends is the tell: when one end derives its key from `firstJump.destination`, the other must mirror it (`lastJump.destination`), not take the opposite side.
- **Verify a model assumption against real data before changing code.** Four rounds of the gateway-route bug were "fixed" by reasoning about the game's segment structure ("gateways have `DEPARTURE`/`APPROACH` too, same shape as natural: `DEPARTURE → JUMP|JUMP_GATEWAY → APPROACH`") and all four missed. One look at the FTC panel's **native** flight-plan table settled it in minutes: the real 16-segment plan was a *mixed* route (2 natural jumps **and** 2 gateway jumps), `APPROACH` sat in the **middle** with a destination that was not the target, the leg that actually reached the destination was a `TRANSIT`, and the first jump was natural while the last was a gateway — so every key derived from "first/last jump" was guaranteed to miss. A structure inferred from a simple case holds for the case you imagined and breaks for the one the user has. Get the rendered table (or log the raw segments) **first**, then design.

### Code Scanning

CodeQL runs via GitHub default setup (analysis key `dynamic/github-code-scanning/codeql` — no workflow file in the repo). Every push to `main` triggers a "dynamic Push on main" run containing the Analyze jobs. To resolve an alert: push a fix to `main`; the alert auto-flips to `fixed` after that run — no manual dismissal needed. Watch with `gh run watch <id>` then check states via `gh api repos/CMDRKilmer/RUNCN/code-scanning/alerts`.

`js/bad-tag-filter` ("Bad HTML filtering regexp") fires on **any** regex containing a literal `-->` constant that matches `-->` but not `--`/`--!>` (see CodeQL `BadTagFilterQuery.qll`) — even when the regex is not used for HTML filtering at all. Gateway-name arrow regexes (`(?:->|-->|→)`, used with `.match()` to split display names) are a recurring false positive. Fix without changing semantics: rewrite the alternation as `(?:-{1,2}>|→)` — no literal `-->` token remains, behavior identical.
