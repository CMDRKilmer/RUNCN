# Feature Patterns

## Feature types

- **Basic** (`src/features/basic/`): enhances UI without removing information. Loaded for all users.
- **Advanced** (`src/features/advanced/`): removes, shortens, or hides information. Loaded for user that turned on FULL feature mode.

## Adding a Feature

Each feature is a self-contained `.ts` or `.tsx` file registered at the end:

```ts
function init() {
  tiles.observe('BBL', onTileReady);
}

features.add(import.meta.url, init, 'BBL: Short description of what this does.');
```

- `import.meta.url` → the filename (without extension) becomes the feature ID.
- Then import the file in `src/features/basic/index.ts` or `src/features/advanced/index.ts`.

### Naming

If a feature targets a specific buffer command, prefix the feature ID and mention it in the description:

```ts
// Feature file: src/features/basic/sysi-blue-negative-value.ts
features.add(import.meta.url, init, 'SYSI: Makes lower negative planet values blue instead of red.');
```

If a feature touches more than one command, don't prefix with a single command name.

```ts
// Bad: feature affects PROD, PRODQ, and PRODCO
features.add(import.meta.url, init, 'PROD: Highlights orders with errors.');

// Good
features.add(import.meta.url, init, 'Highlights production orders with errors.');
```

### File Organization

If a feature has more than a `.ts` + `.module.css` pair, create a folder for it.

Vue component filenames must match the import name:

```ts
// If you write: import ContextRow from './ContextRow.vue';
// The file MUST be: ContextRow.vue (not my-feature.vue)
```

### Parameter Checks

If a tile command can't be opened without a parameter (like `PRODQ`), don't guard against missing parameters.

```ts
// Bad (PRODQ always has a parameter)
if (!tile.parameter) {
  return;
}

// Just use tile.parameter directly
```

## Adding an XIT Command

XIT commands are custom in-game panels opened via the `XIT` buffer. Register in a `.ts` file.

User-facing `name` and `description` strings are written in Chinese (see existing commands in `src/features/XIT/`).

```ts
xit.add({
  command: ['CMD', 'CMDALIAS'],  // one or more
  name: '面板标题',                // or (params) => string for dynamic title
  description: '面板功能描述。',
  mandatoryParameters: 'PARAM1',  // optional
  optionalParameters: 'PARAM2',   // optional
  component: params => MyVue,     // Vue component factory; params is string[]
  bufferSize: [600, 400],         // optional default window size [w, h]
  contextItems: params => [{ cmd: 'XIT OTHER', label: 'Link' }],  // optional
});
```

Then import the file in `src/features/XIT/index.ts`.

The command should be short. Refer to `docs/game/commands.csv` for an example of game commands. Alias is usually added for backwards compatibility or if the community REALLY wants it.

### Tile State Persistence

`tileStatePlugin` binds each XIT component to `getTileState(tile)`, keyed by the tile's numeric ID. Numeric IDs are **non-persistent** — pruned when the tile closes. Named string keys (e.g., `getTileState('my-workspace')`) **are** persistent.

To pass data between XIT commands (e.g., a list view opening an editor), use a named workspace key as a transfer buffer:

1. **Sender** writes data to `getTileState('my-workspace')`, then calls `showBuffer()`.
2. **Receiver** checks the workspace on setup, copies data into its own tile state via `useTileState`, then clears the workspace.

The receiver's `useTileState` reads from its own tile ID (injected by the plugin), **not** from the named key. You must explicitly consume and clear the workspace.

Non-Vue basic features (e.g., a feature that builds a DOM panel via `tiles.observe`) can't use `useTileState`. They read the workspace directly via `getTileState('my-workspace')` on panel mount, copy the value into the panel's local DOM (textarea, input, etc.), then `delete` the workspace key — same consume-and-clear contract, just without the Vue composable.

---

## Auto-Imports (no explicit import needed)

| Symbol | Source |
| -------- | -------- |
| Vue composables (`ref`, `computed`, `reactive`, `watch`, …) | `vue` |
| `$`, `$$`, `_$`, `_$$` | `@src/utils/select-dom` |
| `C` | `@src/infrastructure/prun-ui/prun-css` |
| `subscribe` | `@src/utils/subscribe-async-generator` |
| `tiles` | `@src/infrastructure/prun-ui/tiles` |
| `features` | `@src/features/feature-registry` |
| `xit` | `@src/features/XIT/xit-registry` |
| `config` | `@src/infrastructure/shell/config` |
| `createFragmentApp` | `@src/utils/vue-fragment-app` |
| `applyCssRule` | `@src/infrastructure/prun-ui/refined-prun-css` |

---

## `C` Object

`C` maps all PrUn CSS class names with auto-complete. Always prefer `C` over hardcoded hashed class names — hashes change between game updates.

```typescript
// Bad: brittle
applyCssRule('.Frame__logo___qu6xPzo', $style.logo);

// Good: robust
applyCssRule(`.${C.Frame.logo}`, $style.logo);
```

### Known limitations

- `C.ColoredValue` only exposes `.positive` and `.negative`. There is no `.danger`/`.warning`. For three-tier color coding (red/orange/green), fall back to inline `style` on the element: `style="color: #d9534f"` (red), `style="color: #f0ad4e"` (orange), `style="color: #5cb85c"` (green).
- `C.Select` does not exist. For `<select>` elements in Vue templates, use a plain `<select>` (no class binding) or define a local `style module` class. `SelectInput.vue` is the reusable option if you need a styled wrapper.

---

## Automating PrUn Inputs (React Controlled Components)

PrUn ships a React bundle from its CDN. Its React-Autowhatever wrappers (AddressSelector, MaterialSelector) and most form `<input>`/`<select>` elements are **React controlled**. To set their values from an extension:

### Value-setting recipe

```ts
import { changeInputValue } from '@src/util';

// 1. Focus first so React-Autowhatever opens the listbox.
input.focus();
await sleep(50);
// 2. Set value through the native prototype setter (bypasses React's
//    per-instance override) and dispatch the same events React's
//    onChange listens for. Do NOT add `beforeinput` — it suppresses
//    AddressSelector's server search.
changeInputValue(input, value);
// 3. Wait for the search to actually return before picking: for an
//    AddressSelector the pacing factor is the server round-trip —
//    wait for a listbox item matching the search term rather than a
//    fixed 500ms sleep (fast searches shouldn't waste time, slow
//    ones shouldn't race into clicking a stale suggestion). See
//    fillAddress in src/features/basic/contd-auto-fill.ts.
// 4. Click the listbox item using the NATIVE .click() (not a full
//    pointer/mouse event sequence). React-Autowhatever's
//    onSuggestionSelected listens for the trusted click that
//    HTMLElement.click() synthesizes. Synthetic dispatchEvent
//    sequences are filtered out.
await selectListboxItem(input, value);
```

Prefer adaptive waits over fixed sleeps: fixed sleeps both waste time on fast connections and race slow ones. The real completion signals are the listbox portal unmounting (react-autosuggest removes it on selection) or the input value being replaced by the committed suggestion. `selectListboxItem` in `src/features/basic/contd-auto-fill.ts` waits for either and throws a clear error on timeout instead of silently continuing with an uncommitted value.

### Click recipe

```ts
// Good — triggers React-Autowhatever onSuggestionSelected reliably.
target.click();

// Bad — dispatches full pointer/mouse sequence. Often results in the
// listbox item being hovered/highlighted but never selected, so
// onSuggestionSelected never fires and PrUn's modal-close drops the
// value silently.
await clickElement(target);
```

### Why this matters

PrUn's modal dialogs (template selection, contract conditions) read their state from PrUn's React state tree at the moment their `应用` / `保存` button is clicked. If `onSuggestionSelected` never fired, the value visible in `input.value` is just a DOM mirror — the React state stays empty, and the modal-close drops the value. The `_valueTracker` reset + native setter + clickElement chain we tried first did populate `input.value` but never reached React state.

### Selecting from listbox

See `selectListboxItem` in `src/features/basic/contd-auto-fill.ts` for a working universal selector that handles both flat MaterialSelector lists and nested AddressSelector sections.

Only one listbox can be open at a time — react-autosuggest closes the focused input's listbox when another input takes focus, so listbox interactions in a multi-row form must run one row at a time. Plain value writes (amount, price) are safe to run in parallel, but a write can land on a node React swapped under a concurrent re-render. Follow parallel writes with a sequential verify-and-fixup pass that re-writes mismatches, so races become retries instead of silent corruption — see the two-wave fill in `contd-auto-fill.ts`.

---

## DOM Helpers

Four auto-imported functions for finding elements by CSS class name (`C.X.y`) or HTML tag name.

| Function | Returns | Mechanism | Use When |
| ---------- | --------- | ----------- | ---------- |
| `$` | `Promise<Element>` | MutationObserver — resolves when first match appears | Waiting for element to render (gate pattern) |
| `$$` | `AsyncIterable<Element>` | MutationObserver — yields existing + future matches | Processing current and dynamically added elements |
| `_$` | `Element \| undefined` | Sync `getElementsByClassName` / `getElementsByTagName` | Element is guaranteed to exist already |
| `_$$` | `Element[]` | Sync snapshot of all matches | All target elements exist already |

### Selectors

Selectors are **not CSS selector strings**. Internally they resolve to `getElementsByClassName` or `getElementsByTagName`.

Valid selectors:

- `C.ComponentName.className` — a PrUn CSS class name (preferred)
- HTML tag names: `'div'`, `'tr'`, `'td'`, etc

### `$` — Async Single Element (Gate Pattern)

`Promise` that resolves when the first matching element appears. Blocks execution until the element exists — acts as a natural gate that filters out tiles without the expected DOM structure.

```ts
// Wait for container before proceeding
const container = await $(tile.anchor, C.StoreView.container);

// Chain awaits for nested elements
const text = await $(container, C.CommodityAd.text);
```

### `$$` — Async Iterable (Subscribe Pattern)

`AsyncIterable` that yields existing matches immediately, then watches for new ones via MutationObserver. Almost always paired with `subscribe()`.

```ts
// Process each row as it appears (current + future)
subscribe($$(tile.anchor, 'tr'), row => {
  // Called once per row, including rows added later
});

// Nested subscribes for hierarchical DOM traversal
subscribe($$(tile.anchor, C.ScrollView.view), scroll => {
  subscribe($$(scroll, 'table'), async table => {
    // ...
  });
});

// Async operations inside subscribe callback
subscribe($$(tile.anchor, C.FormComponent.containerPassive), async container => {
  const label = await $(container, 'label');
  hideField(container, label, 'MaterialInformation.ticker');
});
```

### `_$` — Sync Single Element

Immediate lookup — returns first match or `undefined`. Use inside `subscribe` callbacks or other contexts where the parent is already available.

```ts
// Check for element existence
const isHeader = _$(row, 'th') !== undefined;

// Find a specific child
const label = _$(row, C.ColoredIcon.label);
if (label) {
  row.classList.toggle(css.hidden, !visibleMaterials.value?.includes(label.textContent!));
}
```

### `_$$` — Sync All Elements

Returns an array snapshot of all current matches. Use when all target elements are already rendered.

```ts
// Get all cells in a row
const cells = _$$(row, 'td');
if (isEmpty(cells)) {
  return;
}

// Combine: $$ for parent iteration, _$$ for child lookup
subscribe($$(tile.anchor, C.InventoriesListContainer.filter), async filter => {
  for (const label of _$$(filter, C.RadioItem.value)) {
    label.textContent = map.get(label.textContent!) ?? label.textContent;
  }
});
```

### Choosing the Right Function

```text
Need to wait for element? → $ (async single) or $$ (async iterable)
Element already exists?   → _$ (sync single) or _$$ (sync all)
Processing one element?   → $ or _$
Processing many elements? → $$ or _$$
```

Prefer async (`$`/`$$`) over sync (`_$`/`_$$`) when possible — they're type-safe (no `undefined` return for `$`) and handle timing automatically.

---

## Key Concepts

**Tiles** are the game's UI panels — each opened by a command (e.g., `INV`, `PROD`, `FLT`). See `docs/game/ui-concepts.md` for full APEX interface reference.

**`C` object** maps all PrUn CSS class names, parsed at runtime from the game's hashed stylesheets. Always use `C.Component.class` — never hardcode hashed class names.

---

## Observing Tiles

```ts
function onTileReady(tile: PrunTile) {
  // tile.command, tile.parameter, tile.frame, tile.anchor
}

tiles.observe('BBL', onTileReady);          // single command
tiles.observe(['FLT', 'FLTS'], onTileReady); // multiple commands
tiles.observeAll(onTileReady);              // every command

// subscribe() calls callback for each match, including future ones
subscribe($$(tile.anchor, C.SectionList.section), section => { ... });
```

---

## Mounting Vue Components

```ts
createFragmentApp(MyComponent, { prop: value })
  .appendTo(container)   // also: .prependTo(), .before(sibling), .after(sibling)

// Reactive props — wrap in reactive() so Vue sees live values
subscribe($$(tile.anchor, 'tr'), row => {
  createFragmentApp(MyComponent, reactive({ id: refPrunId(row) })).appendTo(row);
});
// Note: refPrunId() returns Ref<string | null>. Vue auto-unwraps Refs nested inside
// reactive(), so the component receives a live string | null, not a Ref object.
// The prop type should be declared as `string | null`, not `Ref<string | null>`.

// Inline TSX (no .vue file needed for simple UI)
createFragmentApp(() => (
  <div class={[C.MaterialIcon.indicator, hiddenClass.value]}>
    {count.value}
  </div>
)).appendTo(container);
```

Auto-unmounts when the parent node disconnects from the DOM.

Extract external DOM handling from Vue components into the feature `.ts` file. Vue components handle rendering; feature files handle DOM wiring and game data access. Use callback props to communicate values from Vue to the feature.

---

## Reactively Mutating DOM Attributes

Watcher stops automatically when the node disconnects from the DOM.

```ts
import { watchEffectWhileNodeAlive } from '@src/utils/watch';

watchEffectWhileNodeAlive(row, () => {
  const value = someComputed.value;
  if (value !== undefined) {
    element.dataset.tooltip = value;
    element.dataset.tooltipPosition = 'right';
  } else {
    delete element.dataset.tooltip;
    delete element.dataset.tooltipPosition;
  }
});
```

`watchEffectWhileNodeAlive` runs immediately — don't duplicate initialization code before it.

---

## Appending Reactive Text to Existing Elements

Lighter than a full Vue component. `undefined` hides the element, string shows it.

```ts
import { createReactiveSpan } from '@src/utils/reactive-element'; // also: createReactiveDiv

const text = computed(() => someCondition ? 'value' : undefined);
existingElement.appendChild(createReactiveSpan(owner, text));
```

---

## Wrapping DOM Values as Refs

```ts
import { refTextContent, refAttributeValue, refValue, refAnimationFrame } from '@src/utils/reactive-dom';

refTextContent(element)              // Ref<string | null> — MutationObserver on textContent
refAttributeValue(element, 'attr')   // Ref<string | null> — MutationObserver on attribute
refValue(inputElement)               // Ref<T> — polls .value via rAF
refAnimationFrame(element, x => x.someProperty)  // Ref<K> — polls via rAF, auto-cleans when disconnected

// Shorthand for data-prun-id attribute
import { getPrunId, refPrunId } from '@src/infrastructure/prun-ui/attributes';
getPrunId(element)   // string | null — sync read
refPrunId(element)   // Ref<string | null> — reactive
```

---

## Accessing Game Data

All stores in `@src/infrastructure/prun-api/data/`. File name matches entity: `sites.ts` → `sitesStore`, `planets.ts` → `planetsStore`, etc.

```ts
import { sitesStore } from '@src/infrastructure/prun-api/data/sites';

const site = computed(() => sitesStore.getById(siteId));  // reactive
sitesStore.all.value      // undefined until fetched, then array
sitesStore.fetched.value  // boolean
```

A few stores (e.g. `blueprintsStore`) are wrapped in `createRequestStore` — accessing any property triggers a guarded one-shot fetch, so reading `blueprintsStore.all.value` opens the `BLU` buffer once automatically and manual requesting is unnecessary.

---

## Data & Reactivity Rules

### Identifying Things in the UI

Never rely on strings in HTML to identify game entities. Use IDs from API stores — they're stable across localizations and UI changes.

```ts
// Bad: fragile, breaks with localization or UI changes
const planet = element.textContent?.includes('Promitor');

// Good: use store IDs
const store = getInvStore(tile.parameter);
const site = sitesStore.getById(store?.addressableId);
const naturalId = getEntityNaturalIdFromAddress(site?.address);
```

### Localized Text

Avoid matching on localized text (like "Weight", "Volume"). Use element index or `PrunI18N` lookup instead.

### Reactivity

**Prefer `computed` over `watch`/`watchEffect`.** Thinking in computed produces more compact and readable code.

```ts
// Good: store.getById is reactive under the hood
const line = computed(() => productionStore.getById(tile.parameter));
```

**Never use `onApiMessage` in features.** It's a low-level API for entity stores in `infrastructure/prun-api`. All API data lands in entity stores — derive what you need with `computed` or `watchEffect`.

**Timestamps in ETAs must stay reactive.** Use `timestampEachMinute` (not `Date.now()`) when calculating ETAs, so it re-renders automatically.

---

## Opening Panels Programmatically

```ts
import { showBuffer } from '@src/infrastructure/prun-ui/buffers';

showBuffer('CXM AI1.RAT');  // opens a buffer with the given command
```

---

## URL Handling

DOM-text → URL sinks (e.g. `<img src={x}>`, `script.src = x`, `iframe.src = x`) are a CodeQL `js/xss-through-dom` finding. Two rules keep the sink clean:

### Use `isSafeUrl` (or a similar guard) for non-trivial URLs

```ts
import { isSafeUrl } from '@src/utils/is-valid-url';

// Bad — passes any parseable URL through, including javascript: and data:
clone.src = script.textContent;

// Good — enforces scheme + exact hostname
if (!isSafeUrl(text, 'apex.prosperousuniverse.com')) {
  return;
}
clone.src = text;
```

`isSafeUrl(url, hostname)` only accepts `http:` and `https:` schemes. For image-only helpers, build a parallel `parseSafeImage(url)` that also validates extension against `URL.pathname` (the regex should not match the raw input — it must match the parsed pathname).

### Never use substring/endsWith for host checks

```ts
// Bad — `evil-apex.prosperousuniverse.com` and `evil.com/apex.prosperousuniverse.com` match
if (s.src.includes('apex.prosperousuniverse.com')) { ... }

// Good — strict hostname comparison
try {
  if (new URL(s.src, location.href).hostname === 'apex.prosperousuniverse.com') { ... }
} catch { /* ignore */ }
```

Substring / suffix / contains checks are flagged by `js/incomplete-url-substring-sanitization`.

### Route the sink value through `new URL(x).href`

CodeQL's dataflow tracks tainted DOM text into the sink. Routing the value through `new URL(text).href` so that the sink reads from the *parsed* URL object (not the original variable) breaks the taint propagation in the sanitizer model:

```ts
// Bad — CodeQL still flags the flow
clone.src = text;

// Good — value reaches the sink via `new URL().href`
clone.src = new URL(text).href;
```

This is what made the CodeQL alerts close on `deserialize-prun-app.ts:9` and `chat-images.tsx:21` even after scheme/host validation alone wasn't sufficient.

---

## CSS

Each feature needing CSS gets a `.module.css` alongside the `.ts`. `applyCssRule` and `C` are auto-imported.

```ts
import $style from './my-feature.module.css';

function init() {
  applyCssRule(`.${C.Frame.logo}`, $style.logo);                              // global
  applyCssRule('PROD', `.${C.OrderTile.overlay}`, $style.disablePointerEvents); // scoped to command
  applyCssRule(['PROD', 'PRODQ'], `.${C.OrderTile.overlay}`, $style.x);        // scoped to multiple
}
```

`applyCssRule` must be called during feature `init()`.

For hover/focus/etc., use CSS Nesting inside the module — one `applyCssRule` call handles both base and nested rules:

```css
.logo {
  cursor: pointer;

  &:hover {
    background-color: rgba(128, 128, 128, 0.5);
  }
}
```

### Class Names

Name classes after where they're applied, not what they do. Fall back to "what it does" only when "where" makes no sense.

```css
/* Bad */
.padLeftRight { }
.flexRow { }

/* Good */
.sortControls { }
.storeInfoColumn { }
```

### Scoping

If a feature targets specific commands, always use scoped CSS rules. Otherwise, styles leak to other commands that share the same DOM structure.

```ts
// Bad: leaks to SHPI and other store views
applyCssRule(`.${C.StoreView.row}`, $style.storeInfo);

// Good: only affects INV
applyCssRule('INV', `.${C.StoreView.row}`, $style.storeInfo);
```

For more specific selectors (descendant combinators, `:nth-child`, etc.), tighten them further to improve performance.

### Import Naming

When importing CSS modules into feature `.ts` files, use `$style` for consistency with Vue's `$style` object.

```ts
import $style from './my-feature.module.css';
```

### Reuse

Use `css.hidden` from `@src/utils/css-utils.module.css` instead of creating your own hidden class.

### `:has` Selector

Use `:has` to implement conditional styling in pure CSS, avoiding unnecessary JS.

```js
/* Highlights the parent when a descendant has the error class */
applyCssRule(`.${C.InputsOutputsView.input}:has(.${C.InputsOutputsView.amountMissing})`, $style.input);
```

### Dynamic & Global Styles (outside `applyCssRule`)

`applyCssRule` wraps every rule in `.refined-prun { … }` (the class sits on `<html>`). That makes it unsuitable for rules that target `:root`/`html`/`::selection` directly, or whose values are computed at runtime (e.g. a user-configurable color or CSS filter).

For those cases, own a `<style>` element and rewrite it from a `watchEffect` that reads `userData` (auto-synced, so no manual save needed):

```ts
import { userData } from '@src/store/user-data';

function init() {
  const style = document.createElement('style');
  document.head.appendChild(style);
  watchEffect(() => {
    const s = userData.settings.someSetting;
    style.textContent = s.enabled ? `html { filter: ...; }` : '';
  });
}

features.add(import.meta.url, init, '...');
```

See `src/features/basic/dark-mode.ts` for a working example.

---

## Formatting Dates and Numbers

All formatters are locale-aware (use `Intl.DateTimeFormat` / `Intl.NumberFormat` with the user's preferred locale). Import from `@src/utils/format`.

### Date Formatters

Signature: `(date?: number | Date | undefined) => string`

| Formatter | Output | Example |
| ----------- | -------- | --------- |
| `ddmm` | Month + day | `"03/09"` |
| `ddmmyyyy` | Month + day + year | `"03/09/2026"` |
| `hhmm` | Hours + minutes (respects user's 12H/24H setting) | `"14:30"` |
| `hhmmss` | Hours + minutes + seconds | `"14:30:00"` |

### Number Formatters

Signature: `(value: number) => string`. Do **not** accept `undefined`.

| Formatter | Decimals | Example | Use For |
| ----------- | ---------- | --------- | --------- |
| `fixed0` | 0 | `"1,235"` | Integer amounts, large values |
| `fixed01` | 0–1 | `"1,234"`, `"1,234.5"` | Mid-range values |
| `fixed02` | 0–2 | `"1,234"`, `"1,234.56"` | Values where trailing zeros are noise |
| `fixed1` | 1 | `"1,234.6"` | Always 1 decimal |
| `fixed2` | 2 | `"1,234.56"` | Prices, always exactly 2 decimals |
| `percent0` | 0 | `"43%"` | Large percentages (>100%) |
| `percent1` | 1 | `"42.5%"` | Medium percentages (10–100%) |
| `percent2` | 2 | `"3.45%"` | Small percentages (<10%) |

Always use number formatters when showing numbers in the UI.

### `formatEta(from, to)`

Takes two timestamps, returns time string with day offset. Uses `hhmm` internally.

```ts
formatEta(timestampEachMinute.value, arrival.value)  // "14:30" or "14:30 +2d"
```

### `formatCurrency(value, format?)`

Formats a number with the user's currency symbol, position, and spacing. Returns `'--'` for `null`/`undefined`.

```ts
formatCurrency(price)              // "1,235 ₳" (defaults to fixed0)
formatCurrency(price, fixed2)      // "1,234.56 ₳"
```

Dynamic format selection based on value magnitude:

```ts
let format = fixed02;
if (price >= 100) format = fixed0;
else if (price >= 10) format = fixed01;
return formatCurrency(price, format);
```
