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
