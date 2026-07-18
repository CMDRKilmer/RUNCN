// Auto-fills a contract draft from a JSON config pasted into a textarea.
// Adapted from the PrUn Operator user script (https://prop.auroras.xyz/prun-operator.user.js).

import { changeInputValue, changeSelectIndex, clickElement, focusElement } from '@src/util';
import { sleep } from '@src/utils/sleep';
import { materialsStore } from '@src/infrastructure/prun-api/data/materials';
import { getI18nValue } from '@src/infrastructure/prun-ui/i18n';
import $style from './contd-auto-fill.module.css';

interface DraftItem {
  amount: number;
  commodity: string;
  price: number;
}

interface DraftConfig {
  template: string;
  currency: string;
  items: DraftItem[];
  // BUY/SELL templates take a single `location` (the delivery point).
  location?: string;
  // SHIP templates take origin + destination; the player doing the
  // shipping is the intermediary. Per PrUn docs, one of these must
  // be at the shipper's current location. The interface accepts both
  // shapes; we pick the right pair to feed into the modal based on
  // the template.
  origin?: string;
  destination?: string;
  // SHIP templates take a single global price for all items (written
  // to the contract-level `price` input). BUY/SELL prices live per-row
  // on each DraftItem.price. Required when template === 'SHIP'.
  price?: number;
  // Optional. Falls back to the template's default (typically 3 days) when
  // omitted.
  deadline?: number;
  // Optional. When provided, overwrites the 合同名称 field on the draft
  // header. Otherwise the existing name is left untouched.
  name?: string;
}

const MARKER = 'data-rprun-auto-fill';

// Hard-coded location aliases. PrUn's AddressSelector searches by
// naturalId and by station name. Tickers like `HRT` are CX-exchange
// codes derived from the station naturalId — but PrUn's search index
// may not include them. We expand them to the display name so the
// listbox has something to match. If the search still fails, the
// caller should fall back to the exact planet naturalId (e.g.
// "VH-331c") instead of the CX exchange ticker. Anything not in this
// table is passed through verbatim.
const LOCATION_ALIASES: Record<string, string> = {
  HRT: 'Hortus Station',
  ANT: 'Antares Station',
  BEN: 'Benten Station',
  MOR: 'Moria Station',
};

function expandLocationAlias(input: string): string {
  return LOCATION_ALIASES[input.trim().toUpperCase()] ?? input;
}

// Iterative Levenshtein distance — O(len(a)*len(b)) time and space,
// fine for naturalId-sized strings.
function levenshtein(a: string, b: string): number {
  if (a === b) {
    return 0;
  }
  if (a.length === 0) {
    return b.length;
  }
  if (b.length === 0) {
    return a.length;
  }
  let prev = new Array<number>(b.length + 1);
  let curr = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j++) {
    prev[j] = j;
  }
  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min((prev[j] ?? 0) + 1, (curr[j - 1] ?? 0) + 1, (prev[j - 1] ?? 0) + cost);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[b.length] ?? 0;
}

// Find the candidate whose leading naturalId token is closest to
// `needle`. Returns the naturalId (or undefined if no candidate is
// close enough — distance > 3 is too far for a typo).
// Pulls candidate identifier tokens out of a listbox suggestion's
// text. Returns an array because the suggestion can have multiple
// possible matches (e.g. "Hortus Station (Hortus)" — both
// "Hortus Station" and "Hortus" are valid input, and we want to
// match whichever the user typed). Returned in priority order:
//   1. Parenthetical naturalId: "Antares I - Eos (ZV-307a)" → "ZV-307a"
//   2. Bare naturalId: "ZV-307c"                            → "ZV-307c"
//   3. Leading display name (catches stations whose naturalId IS
//      their name, like "Hortus Station (Hortus)"):
//        "Hortus Station (Hortus)" → "Hortus Station"
//        "Animus a (VH-874a)"      → "Animus a"
function extractIdCandidates(text: string): string[] {
  const out: string[] = [];
  const paren = text.match(/\(([A-Z0-9]{2,}-[A-Za-z0-9]+)\)\s*$/i);
  if (paren !== null) {
    out.push(paren[1]);
  }
  const bare = text.match(/^([A-Z0-9]{2,}-[A-Za-z0-9]+)\s*$/);
  if (bare !== null) {
    out.push(bare[1]);
  }
  // Leading display name = text up to " (" or end of string.
  const leading = text.match(/^([^(]+?)\s*(?:\(|$)/);
  if (leading !== null) {
    const name = leading[1].trim();
    if (name.length > 0 && !out.includes(name)) {
      out.push(name);
    }
  }
  return out;
}

// Walks every listbox item, returns the first whose extracted
// naturalId equals `needle` (case-insensitive). Used both for
// readiness polling (so we wait until the server-search result is in)
// and for picking the target item to click.
function findListboxMatch(listbox: HTMLElement, needle: string): HTMLElement | undefined {
  const items = listbox.querySelectorAll(
    `li, .${C.AddressSelector.suggestion}`,
  ) as NodeListOf<HTMLElement>;
  // Pass 1: exact naturalId match (existing behaviour).
  for (const item of Array.from(items)) {
    const text = (item.textContent ?? '').trim();
    const ids = extractIdCandidates(text);
    for (const id of ids) {
      if (id.toUpperCase() === needle) {
        return item;
      }
    }
  }
  // Pass 2: stations whose naturalId IS their display name (e.g.
  // "Hortus Station" → "(Hortus)" paren would not extract but the
  // leading name "Hortus Station" matches the user's typed text).
  // Match when the candidate's leading display name equals needle
  // (case-insensitive, exact).
  for (const item of Array.from(items)) {
    const text = (item.textContent ?? '').trim();
    if (text.length === 0) {
      continue;
    }
    const leading = text.match(/^([^(]+?)\s*\(/);
    if (leading !== null) {
      const displayName = leading[1].trim();
      if (displayName.toUpperCase() === needle) {
        return item;
      }
    }
  }
  // Diagnostic: log why we failed so the next round of debugging
  // can see exactly which items the listbox had at click-time vs
  // poll-time. Without this we can only guess at whether polling
  // exited too early or whether the click target is from a stale
  // listbox.
  console.warn(
    '[contd-auto-fill] findListboxMatch: no match for',
    needle,
    'in listbox containing',
    items.length,
    'items; sample texts:',
    JSON.stringify(
      Array.from(items)
        .slice(0, 8)
        .map(i => {
          const text = (i.textContent ?? '').trim();
          return { text, candidates: extractIdCandidates(text) };
        }),
      null,
      2,
    ),
  );
  return undefined;
}

// The trade-row label uses different names per template: BUY/SELL
// use `trades[<i>].*`, SHIP uses `shipments[<i>].*` (PrUn renamed
// the array when the SHIP template was added). Both are arrays of
// rows and the rest of the row layout is the same. We accept both
// prefixes uniformly via this helper so callers don't have to know
// which template they're in.
function findRowLabel(
  form: HTMLElement,
  rowIndex: number,
  suffix: string,
): HTMLLabelElement | null {
  for (const prefix of ['trades', 'shipments']) {
    const exact = form.querySelector(`label[for="${prefix}[${rowIndex}].${suffix}"]`);
    if (exact !== null) {
      return exact as HTMLLabelElement;
    }
  }
  // Fallback: any row label in either array.
  const any = Array.from(form.querySelectorAll('label')).find(l => {
    const forAttr = l.getAttribute('for') ?? '';
    return (
      forAttr.startsWith(`trades[${rowIndex}].`) || forAttr.startsWith(`shipments[${rowIndex}].`)
    );
  });
  return (any as HTMLLabelElement | undefined) ?? null;
}

// Returns the first <input name="<prefix>[<i>].<suffix>"> matching
// either `trades` or `shipments` prefix. Used for amount, pricePerUnit,
// and any other per-row field that has a real name attribute.
function findRowInput(
  form: HTMLElement,
  rowIndex: number,
  suffix: string,
): HTMLInputElement | null {
  for (const prefix of ['trades', 'shipments']) {
    const sel = `input[name="${prefix}[${rowIndex}].${suffix}"]`;
    const el = form.querySelector(sel);
    if (el !== null) {
      return el as HTMLInputElement;
    }
  }
  return null;
}

// Counts the number of per-row labels in either array. Mirrors
// findRowLabel's fallback strategy so SHIP and BUY/SELL both report
// their row count correctly.
function countRowLabels(form: HTMLElement): number {
  // Count distinct row indices across both arrays. We don't double-
  // count if a label exists in both (which never happens in practice
  // — each template uses one array exclusively).
  const indices = new Set<number>();
  for (const label of Array.from(form.querySelectorAll('label'))) {
    const forAttr = label.getAttribute('for') ?? '';
    const match = forAttr.match(/^(?:trades|shipments)\[(\d+)\]\./);
    if (match !== null) {
      indices.add(Number(match[1]));
    }
  }
  return indices.size;
}

// Finds the naturalId in `candidates` that's closest to `needle`
// (case-insensitive Levenshtein). Returns the candidate naturalId, or
// undefined if every candidate is too far away (> 2 edits away —
// anything more would be a wild guess for the user).
function suggestSimilar(needle: string, candidates: HTMLElement[]): string | undefined {
  const upperNeedle = needle.trim().toUpperCase();
  let best: { token: string; distance: number } | undefined;
  for (const item of candidates) {
    const text = (item.textContent ?? '').trim();
    if (text.length === 0) {
      continue;
    }
    for (const id of extractIdCandidates(text)) {
      const distance = levenshtein(upperNeedle, id.toUpperCase());
      if (best === undefined || distance < best.distance) {
        best = { token: id, distance };
      }
    }
  }
  if (best === undefined || best.distance > 2) {
    return undefined;
  }
  return best.token;
}

// Waits until `predicate()` returns truthy or the deadline elapses.
// `diagnostic` is an optional function that returns extra context
// appended to the timeout error message.
async function waitFor(
  predicate: () => boolean,
  description: string,
  timeoutMs = 8000,
  diagnostic?: () => string,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    await sleep(50);
  }
  const detail = diagnostic === undefined ? '' : ` (${diagnostic()})`;
  throw new Error(`Timed out waiting for ${description}${detail}`);
}

// Variant of `waitFor` that returns the predicate's value on success,
// throws on timeout. Use when you need to capture what you waited for.
async function waitForValue<T>(
  producer: () => T | null | undefined,
  description: string,
  timeoutMs = 8000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = producer();
    if (value !== null && value !== undefined) {
      return value as T;
    }
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for ${description}`);
    }
    await sleep(50);
  }
}

// Picks the closest-matching <option> in a <select> for a user-supplied
// value. Accepts ticker, localized name, or partial matches.
function selectByValueOrLabel(select: HTMLSelectElement, value: string): void {
  const upper = value.trim().toUpperCase();
  const options = Array.from(select.options);
  if (options.length === 0) {
    throw new Error(`Select has no options`);
  }
  // Exact value match (case-insensitive).
  let index = options.findIndex(o => o.value.toUpperCase() === upper);
  if (index < 0) {
    // Substring of label, since users often write the human label like
    // "NCE Coupons" or "Martian Coin" instead of the ticker.
    index = options.findIndex(o => o.textContent?.toUpperCase().includes(upper));
  }
  if (index < 0) {
    const printable = options.map(o => o.value).join(', ');
    throw new Error(`Option "${value}" not found in select (available values: ${printable})`);
  }
  changeSelectIndex(select, index);
}

function notNullish<T>(value: T | null | undefined, message: string): T {
  if (value === null || value === undefined) {
    throw new Error(message);
  }
  return value;
}

interface ResolvedMaterial {
  ticker: string;
  name: string;
}

function resolveMaterial(input: string): ResolvedMaterial | undefined {
  const trimmed = input.trim();
  if (trimmed.length === 0) {
    return undefined;
  }
  const upper = trimmed.toUpperCase();
  // 1. Exact ticker (case-insensitive). Most reliable.
  if (upper.length === 3) {
    const material = materialsStore.getByTicker(upper);
    if (material) {
      return { ticker: material.ticker, name: material.name };
    }
  }
  // 2. Exact localized name. The game's listbox items are formatted as
  //    "<TICKER> <name>"; matching the full name disambiguates between
  //    e.g. "Iron Ore" and "Iron Bar".
  const lower = trimmed.toLowerCase();
  for (const material of materialsStore.all.value ?? []) {
    if (material.name.toLowerCase() === lower) {
      return { ticker: material.ticker, name: material.name };
    }
  }
  // 3. Exact ticker case-insensitive even when length != 3 (e.g. user
  //    typed "rat " or "RAT.").
  for (const material of materialsStore.all.value ?? []) {
    if (material.ticker.toUpperCase() === upper) {
      return { ticker: material.ticker, name: material.name };
    }
  }
  return undefined;
}

// Picks the best-matching listbox item for the current search.
// Two listbox flavours exist:
//   * MaterialSelector: <ul role="listbox"><li>…</li></ul>
//   * AddressSelector:  <div role="listbox"><div class="AddressSelector__suggestion">…</div></div>
// Both render section wrappers ("搜索结果" / "Results" for live search;
// "Infrastructure" / "Bases" / "Warehouses" / "Commodity exchanges" for
// the address selector's fallback list). For the address selector the
// items are divs, not <li>s.
//
// Selection ladder:
//   1. Look inside "搜索结果" / "Results" section first (live-search hits).
//   2. Try an exact, case-insensitive match against the ticker.
//   3. Try an exact, case-insensitive match against the localized name.
//   4. Try a token-prefix match against the user-provided needle.
//   5. Fallback to the first visible item.
function findListboxItem(
  listbox: HTMLElement,
  resolved: ResolvedMaterial | undefined,
  fallbackNeedle: string,
): HTMLElement {
  const collectItems = (root: HTMLElement): HTMLElement[] => {
    const out: HTMLElement[] = [];
    // 1. Native <li> items (MaterialSelector).
    for (const node of Array.from(root.querySelectorAll('li'))) {
      if (node.querySelector('li') === null) {
        out.push(node as HTMLElement);
      }
    }
    // 2. AddressSelector items: divs carrying the
    //    AddressSelector.suggestion class. We additionally look for
    //    any descendant div whose own descendants are just text, so we
    //    also catch unclassed suggestion wrappers the game may add
    //    later.
    const suggestions = root.querySelectorAll(`.${C.AddressSelector.suggestion}`);
    for (const node of Array.from(suggestions)) {
      if (!out.includes(node as HTMLElement)) {
        out.push(node as HTMLElement);
      }
    }
    return out;
  };

  // Prefer the live-search section when present.
  let candidates = collectItems(listbox);
  for (const section of Array.from(listbox.children) as HTMLElement[]) {
    const header = Array.from(section.children).find(
      c => c.children.length === 0 || c.tagName === 'H6' || /^h\d/i.test(c.tagName),
    );
    if (!header) {
      continue;
    }
    if (/搜索结果|results/i.test(section.textContent ?? '')) {
      const sectionItems = collectItems(section);
      if (sectionItems.length > 0) {
        candidates = sectionItems;
        break;
      }
    }
  }

  if (candidates.length === 0) {
    throw new Error(`Listbox has no selectable items (search: "${fallbackNeedle}")`);
  }

  const textOf = (el: HTMLElement): string => (el.textContent ?? '').trim();
  const upper = (s: string) => s.toUpperCase();

  // 2. Exact ticker.
  if (resolved !== undefined) {
    const tickerUpper = upper(resolved.ticker);
    const exact = candidates.find(li => {
      const text = upper(textOf(li));
      return (
        text === tickerUpper ||
        text.startsWith(`${tickerUpper} `) ||
        text.endsWith(` ${tickerUpper}`)
      );
    });
    if (exact !== undefined) {
      return exact;
    }
  }

  // 3. Exact name match (against the whole listbox text, since items are
  //    formatted as "TICKER NAME").
  if (resolved !== undefined) {
    const nameUpper = upper(resolved.name);
    const exactName = candidates.find(li => upper(textOf(li)).includes(nameUpper));
    if (exactName !== undefined) {
      return exactName;
    }
  }

  // 4. Token-prefix match on the fallback needle (what the user actually
  //    typed). Every whitespace-separated token must appear in the item
  //    text. This way "Iron Ore" matches "IRON ORE" but not "IRON BAR".
  const tokens = fallbackNeedle
    .trim()
    .split(/\s+/)
    .filter(x => x.length > 0)
    .map(upper);
  if (tokens.length > 0) {
    const tokenMatch = candidates.find(li => {
      const text = upper(textOf(li));
      return tokens.every(t => text.includes(t));
    });
    if (tokenMatch !== undefined) {
      return tokenMatch;
    }
  }

  // 5. Last resort: first visible item.
  return candidates[0];
}

async function waitForListboxItems(
  input: HTMLInputElement,
  timeoutMs = 8000,
): Promise<HTMLElement> {
  // The listbox lives in a React-Autosuggest / Autowhatever portal under
  // document.body, not inside the input's row. Find it by the
  // aria-controls attribute on the combobox wrapper.
  const combobox = input.closest('[role="combobox"]') as HTMLElement | null;
  const controlsId = combobox?.getAttribute('aria-controls') ?? input.getAttribute('aria-controls');
  // Re-query the listbox on every iteration. React-Autosuggest replaces
  // the listbox element on each render, so the captured reference can
  // become detached mid-loop and `listbox.children` would always read
  // as 0 — making the wait loop hang until the timeout.
  // We MUST scope to this input's controlsId: a page may have several
  // AddressSelector inputs (e.g. origin + destination on SHIP) and the
  // first listbox to mount may not belong to us.
  const queryListbox = (): HTMLElement | null => {
    if (controlsId !== null && controlsId !== undefined) {
      return document.getElementById(controlsId);
    }
    // Fallback: any listbox that isn't already paired to another input.
    return document.querySelector('ul[role="listbox"], div[role="listbox"]');
  };
  const listbox = queryListbox();
  if (listbox === null) {
    throw new Error('Listbox not found after typing search term');
  }
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const live = queryListbox();
    if (live !== null && live.children.length > 0) {
      return live;
    }
    await sleep(50);
  }
  const liveAtTimeout = queryListbox();
  console.warn(
    '[contd-auto-fill] waitForListboxItems timeout: listbox=',
    liveAtTimeout === null
      ? 'NOT MOUNTED'
      : `mounted with ${liveAtTimeout.children.length} children`,
    'input.value=',
    `"${input.value}"`,
  );
  throw new Error(`Listbox opened but no items appeared within ${timeoutMs}ms`);
}

async function selectListboxItem(input: HTMLInputElement, expectedText: string) {
  // The listbox lives in a React-Autosuggest / Autowhatever portal under
  // document.body, not inside the input's row. Find it by the
  // aria-controls attribute on the combobox wrapper.
  const combobox = input.closest('[role="combobox"]') as HTMLElement | null;
  const controlsId = combobox?.getAttribute('aria-controls') ?? input.getAttribute('aria-controls');
  let listbox: HTMLElement | null = null;
  if (controlsId) {
    listbox = document.getElementById(controlsId) as HTMLElement | null;
  }
  if (!listbox) {
    listbox = document.querySelector('ul[role="listbox"]') as HTMLElement | null;
  }
  if (!listbox) {
    throw new Error('Listbox not found after typing search term');
  }
  // Wait for at least one list item to populate.
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline && listbox.children.length === 0) {
    await sleep(50);
  }
  // The listbox may be flat (MaterialSelector) or nested in grouped sections
  // (AddressSelector: "搜索结果" / "Infrastructure" / "Bases" / "Warehouses"
  //  / "Commodity exchanges"). Use querySelectorAll to find leaf <li>s.
  const allLi = Array.from(listbox.querySelectorAll('li')) as HTMLElement[];
  if (allLi.length === 0) {
    throw new Error(`No <li> found in listbox for "${expectedText}"`);
  }
  const needle = expectedText.trim().toUpperCase();
  // Prefer items under a section titled "搜索结果" (the live search hits).
  const sections = Array.from(listbox.children) as HTMLElement[];
  let candidates = allLi;
  for (const section of sections) {
    if (/搜索结果/i.test(section.textContent ?? '')) {
      const sectionItems = Array.from(section.querySelectorAll('li')) as HTMLElement[];
      if (sectionItems.length > 0) {
        candidates = sectionItems;
        break;
      }
    }
  }
  // For AddressSelector items that aren't <li>s but use the
  // AddressSelector.suggestion class, gather those too. Prefer
  // candidates that start with our needle (case-insensitive exact).
  const addrSuggestionItems = Array.from(
    listbox.querySelectorAll(`.${C.AddressSelector.suggestion}`),
  ) as HTMLElement[];
  let target = candidates.find(li => (li.textContent ?? '').toUpperCase().includes(needle));
  if (target === undefined) {
    target = addrSuggestionItems.find(li => (li.textContent ?? '').toUpperCase().includes(needle));
  }
  if (target === undefined) {
    target = candidates[0] ?? addrSuggestionItems[0];
  }
  if (target === undefined) {
    throw new Error(`No list item matched "${expectedText}"`);
  }
  target.scrollIntoView();
  // Native HTMLElement.click() — synthesizes a click that
  // react-autosuggest's onClick handler picks up reliably.
  (target as HTMLElement).click();
  await sleep(150);
  // Fallback: drive selection via keyboard on the input. Re-focus
  // first because clicking the <li> may have blurred the input.
  input.focus();
  await sleep(50);
  input.dispatchEvent(
    new KeyboardEvent('keydown', {
      key: 'ArrowDown',
      code: 'ArrowDown',
      keyCode: 40,
      bubbles: true,
      cancelable: true,
    }),
  );
  input.dispatchEvent(
    new KeyboardEvent('keydown', {
      key: 'Enter',
      code: 'Enter',
      keyCode: 13,
      bubbles: true,
      cancelable: true,
    }),
  );
  await sleep(150);
}

async function findConditionsForm(tile: PrunTile): Promise<HTMLElement> {
  // CONTD has three Draft__form blocks: (1) read-only header fields
  // (status/name/notes), (2) conditions — the one we want, containing the
  // "选择模板" / "Select Template" button, (3) send-draft. The conditions
  // form is the one that holds an ActionBar.
  for (const candidate of _$$(tile.anchor, C.Draft.form)) {
    if (_$(candidate, C.ActionBar.container) !== undefined) {
      return candidate;
    }
  }
  // Fallback: the second Draft.form is usually conditions.
  const all = _$$(tile.anchor, C.Draft.form);
  return await $(tile.anchor, C.Draft.form).then(() => all[1] ?? all[0]);
}

async function applyConfig(tile: PrunTile, config: DraftConfig) {
  // 0. Optional header fields (合同名称, 截止时间, etc.). We only
  //    touch name/deadline here; the template modal handles its own
  //    per-template form fields further down. Both header inputs
  //    live in the first Draft__form, identified by their wrapping
  //    FormComponent__label.
  if (config.name !== undefined) {
    const nameLabel = getI18nValue('Contract.name', 'Contract Name');
    const nameInput = findLabeledInput(tile.anchor as HTMLElement, nameLabel);
    if (nameInput === null) {
      // PrUn's CONTD header doesn't expose a contract-name input —
      // the draft's `name` field mirrors `naturalId` (e.g.
      // "CD-QASS-5072") and isn't editable in the UI. We silently
      // skip "name" so users can still fill template/currency/items
      // /etc. without the optional name field.
    } else {
      focusElement(nameInput);
      await sleep(50);
      // Reset React's value tracker so the upcoming value change is
      // considered "new" by React's onChange compare (otherwise React
      // suppresses the event and the input snaps back). Same trick
      // as the template-select handler below.
      const trackerKey = Object.keys(nameInput).find(
        k => k.startsWith('_valueTracker') || k === '__value',
      );
      if (trackerKey !== undefined) {
        const tracker = (nameInput as unknown as Record<string, { stop?: () => void }>)[trackerKey];
        tracker?.stop?.();
      }
      changeInputValue(nameInput, config.name);
      await sleep(50);
      // The header form has its own 保存 button (separate from the
      // conditions-form 保存 we click later). Clicking it forces a
      // PATCH on the contract-draft row, which is the only path we
      // know works to persist the name — the per-field onBlur autosave
      // is debounced and unreliable when the next PATCH (the
      // conditions save) lands within a second or two. We click the
      // button and wait for the next save to round-trip before
      // opening the template modal, so the name lands first and the
      // modal's PATCH can't overwrite it with a stale value.
      const headerForm = nameInput.closest('form') as HTMLFormElement | null;
      const headerSaveButton = _$$(headerForm ?? (tile.anchor as HTMLElement), 'button').find(b =>
        /^save$|^保存$/i.test(b.textContent ?? ''),
      );
      if (headerSaveButton !== undefined) {
        await clickElement(headerSaveButton);
        await sleep(300);
      } else {
        // Fallback to blur if the header has no visible save button.
        nameInput.dispatchEvent(new Event('blur', { bubbles: true }));
        await sleep(300);
      }
    }
  }

  // Click "选择模板" inside the conditions form if the template modal
  // isn't already open.
  if (_$(tile.anchor, C.TemplateSelection.container) === undefined) {
    const conditionsForm = await findConditionsForm(tile);
    const selectButton = _$$(conditionsForm, 'button').find(b =>
      /select template|选择模板/i.test(b.textContent ?? ''),
    );
    if (!selectButton) {
      throw new Error('选择模板 button not found in conditions form');
    }
    await clickElement(selectButton);
    await sleep(200);
  }

  // Wait for the template modal to render. It lives inside the tile anchor
  // as an Overlay containing a TemplateSelection.container with the
  // templateTypeSelect and the per-template form.
  const tsContainer = await $(tile.anchor, C.TemplateSelection.container);

  // 1. Pick template. The modal's <form> may exist but be empty while
  // React is still rendering (esp. under slow font loads). Wait for
  // the templateTypeSelect wrapper to attach a real <select> child
  // before we touch it.
  const templateSelect = await waitForValue<HTMLSelectElement>(
    () =>
      (
        _$(tsContainer, C.TemplateSelection.templateTypeSelect) as HTMLElement | null
      )?.querySelector('select') ?? null,
    'template <select> to mount',
    15000,
  );
  const wantsTemplate = (() => {
    const upper = config.template.trim().toUpperCase();
    const options = Array.from(templateSelect.options);
    const exact = options.find(o => o.value.toUpperCase() === upper);
    if (exact === undefined) {
      const printable = options.map(o => o.value).join(', ');
      throw new Error(
        `Template "${config.template}" not offered by the modal (available: ${printable})`,
      );
    }
    return exact.value;
  })();
  const currentTemplate = templateSelect.value;
  if (currentTemplate.toUpperCase() !== wantsTemplate.toUpperCase()) {
    // React's controlled <select> needs both the value to change AND
    // React's value tracker to see a new "previous value" so it fires
    // onChange. Use the prototype's value setter (bypasses React's
    // per-instance override) + a manual value-tracker stop so React's
    // internal compare (`_valueTracker.getValue() !== input.value`)
    // returns true.
    templateSelect.focus();
    const idx = Array.from(templateSelect.options).findIndex(o => o.value === wantsTemplate);
    if (idx < 0) {
      throw new Error(`Template option "${wantsTemplate}" not in <select>`);
    }
    const valueSetter = Object.getOwnPropertyDescriptor(
      window.HTMLSelectElement.prototype,
      'value',
    );
    valueSetter?.set?.call(templateSelect, wantsTemplate);
    // Reset React's value tracker so it considers the change "new".
    // The tracker is exposed under a private key on each input/select.
    const trackerKey = Object.keys(templateSelect).find(
      k => k.startsWith('_valueTracker') || k === '__value',
    );
    if (trackerKey !== undefined) {
      const tracker = (templateSelect as unknown as Record<string, { stop?: () => void }>)[
        trackerKey
      ];
      tracker?.stop?.();
    }
    templateSelect.dispatchEvent(new Event('input', { bubbles: true, cancelable: true }));
    templateSelect.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }));
  }
  // Wait for the per-template <form> to render a row 0. BUY/SELL use
  // `trades[0].*`, SHIP uses `shipments[0].*` (PrUn renamed the array
  // for the SHIP template). The material input has no name attribute
  // (the name is only on the wrapper div), so we locate by any
  // `trades[0].*` or `shipments[0].*` label.
  await waitFor(
    () => {
      const form = _$(tsContainer, 'form') as HTMLFormElement | null;
      if (form === null) {
        return false;
      }
      const hasAmount =
        findRowInput(form, 0, 'amount') !== null ||
        form.querySelector('input[name="trades[0].amount"]') !== null;
      const hasRowLabel =
        findRowLabel(form, 0, 'material') !== null || findRowLabel(form, 0, 'cargo') !== null;
      return hasAmount && hasRowLabel;
    },
    'first trade row to render',
    15000,
    () => {
      // Diagnostic: dump modal state on timeout so we can see whether
      // the modal is empty, has wrong-template fields, or something else.
      const form = _$(tsContainer, 'form') as HTMLFormElement | null;
      const allInputs = form === null ? '<no form>' : form.querySelectorAll('input').length;
      const allLabels =
        form === null
          ? '<no form>'
          : Array.from(form.querySelectorAll('label'))
              .map(l => {
                const text = (l.textContent ?? '').trim();
                const forAttr = l.getAttribute('for') ?? '';
                return forAttr ? `${text}[for=${forAttr}]` : text;
              })
              .join(' | ');
      const tplSelect = tsContainer.querySelector('select') as HTMLSelectElement | null;
      return (
        `select=${tplSelect?.value ?? '<none>'}/${tplSelect?.options.length ?? 0} options; ` +
        `form inputs=${allInputs}; labels=[${allLabels}]`
      );
    },
  );

  // 2. Pick currency. Re-fetch the form in case React swapped it.
  const currency = notNullish(
    (_$(tsContainer, 'form') as HTMLFormElement | null)?.querySelector(
      'select[name="currency"]',
    ) as HTMLSelectElement | null,
    'Currency select not found',
  );
  selectByValueOrLabel(currency, config.currency);
  // Currency change may trigger a partial re-render — re-establish
  // that row 0 is still there before continuing. Without this, the
  // per-row loop races with React's reconciliation and can stall
  // indefinitely under slow hydration. Match any row-0 label
  // (trades[0].* OR shipments[0].*) and amount input either way.
  await waitFor(
    () => {
      const form = _$(tsContainer, 'form') as HTMLFormElement | null;
      if (form === null) {
        return false;
      }
      const hasRowLabel =
        findRowLabel(form, 0, 'material') !== null || findRowLabel(form, 0, 'cargo') !== null;
      const hasAmount = findRowInput(form, 0, 'amount') !== null;
      return hasRowLabel && hasAmount;
    },
    'first trade row to re-appear after currency change',
    8000,
  );

  // 3. Top up commodity rows. The game re-renders rows asynchronously,
  // so we must wait for the new row's material input to appear before
  // moving on — otherwise the next iteration's querySelector returns
  // the stale row's element. Re-fetch the form and add-button on every
  // poll in case React swapped the elements after a previous interaction.
  const findAddButton = (): HTMLButtonElement | null => {
    const form = _$(tsContainer, 'form') as HTMLFormElement | null;
    if (form === null) {
      return null;
    }
    // Match a button that adds a new row to the trade/shipments array.
    // Different templates use different labels: "添加商品" (BUY/SELL),
    // "添加货物" (SHIP), or English variants. The button is the one
    // that lives in a FormComponent__containerCommand row (the game's
    // "指令" container with inline action buttons). Prefer that
    // structural signal over text matching, since text is localized.
    const commandContainer = Array.from(form.querySelectorAll('div')).find(d =>
      Array.from(d.children).some(
        c => c.tagName === 'LABEL' && (c.textContent ?? '').trim() === '指令',
      ),
    );
    if (commandContainer !== undefined) {
      const btn = commandContainer.querySelector('button');
      if (btn !== null) {
        return btn as HTMLButtonElement;
      }
    }
    // Fallback: any button whose text matches common patterns.
    return (
      _$$(form, 'button').find(b =>
        /add commodity|添加商品|add cargo|add item|add shipment|添加货物|add package|添加包裹/i.test(
          b.textContent ?? '',
        ),
      ) ?? null
    );
  };
  const rowCount = () => {
    // Material inputs don't carry a name attribute — the name lives on
    // the surrounding wrapper div. Count distinct row indices across
    // BOTH `trades[i].*` (BUY/SELL) and `shipments[i].*` (SHIP).
    const form = _$(tsContainer, 'form') as HTMLFormElement | null;
    if (form === null) {
      return 0;
    }
    return countRowLabels(form);
  };
  // Row 0 was already verified to exist before this point, so the
  // rowCount baseline is >= 1. Skip the redundant first wait.
  for (let i = 1; i < config.items.length; i++) {
    const addButton = findAddButton();
    if (addButton === null) {
      const form = _$(tsContainer, 'form') as HTMLFormElement | null;
      const buttonTexts =
        form === null
          ? '<no form>'
          : Array.from(form.querySelectorAll('button'))
              .map(b => `"${(b.textContent ?? '').trim()}"`)
              .join(', ');
      throw new Error(`Add row button not found (iter ${i}). Buttons in modal: ${buttonTexts}`);
    }
    await clickElement(addButton);
    const target = i;
    await waitFor(() => rowCount() > target, `commodity row #${target} to render`);
  }

  // 4. Fill each row. Re-resolve the form before every read so React's
  // re-renders (which may swap <form> elements) don't leave us
  // querying a detached node.
  const currentForm = (): HTMLFormElement | null =>
    _$(tsContainer, 'form') as HTMLFormElement | null;
  for (let i = 0; i < config.items.length; i++) {
    const item = notNullish(config.items[i], `Item ${i} missing in config`);

    await waitFor(
      () => currentForm() !== null && findRowInput(currentForm()!, i, 'amount') !== null,
      `row #${i} amount input to render`,
    );
    const formForRow = notNullish(currentForm(), `Modal <form> missing for row ${i}`);

    const amountInput = notNullish(
      findRowInput(formForRow, i, 'amount'),
      `Amount input for item ${i} not found`,
    );
    changeInputValue(amountInput, String(item.amount));
    await sleep(50);

    // The material input has no `name` attribute — the name is on its
    // parent wrapper div. Locate via the row's `material` or `cargo`
    // label (BUY/SELL use `.material`, SHIP uses `.cargo`) and pick
    // the MaterialSelector input inside the label's container row.
    const materialLabel = notNullish(
      findRowLabel(formForRow, i, 'material') ?? findRowLabel(formForRow, i, 'cargo'),
      `Material/cargo label for item ${i} not found`,
    );
    const materialRow = materialLabel.parentElement!;
    const materialInput = notNullish(
      (materialRow.querySelector(`input.${C.MaterialSelector.input}`) ??
        materialRow.querySelector('input')) as HTMLInputElement | null,
      `Material input for item ${i} not found`,
    );
    focusElement(materialInput);
    await sleep(50);
    const resolved = resolveMaterial(item.commodity);
    const searchText = resolved?.ticker ?? item.commodity;
    changeInputValue(materialInput, searchText);
    // Wait for the listbox to actually populate with results before
    // trying to pick — older code assumed 150ms was enough and silently
    // hit a stale DOM under slow loads.
    await selectListboxItem(materialInput, resolved?.name ?? item.commodity);
    await sleep(50);

    // Per-row price only exists in BUY/SELL (each row has its own
    // pricePerUnit). SHIP has a single global `price` field outside
    // the shipments array — handled separately below for the first
    // row only.
    // Per-row price falls back to top-level `config.price` when the
    // item itself omits it — validateConfig guarantees one of the
    // two is present for BUY/SELL.
    const rowPrice = item.price ?? config.price;
    const priceInput = findRowInput(formForRow, i, 'pricePerUnit');
    if (priceInput !== null && rowPrice !== undefined) {
      changeInputValue(priceInput, String(rowPrice));
      await sleep(50);
    } else if (i === 0 && config.template === 'SHIP') {
      // SHIP template: write the single contract price to the global
      // `price` input. `config.price` is the top-level price for SHIP;
      // it is required by validateConfig when template === 'SHIP'.
      const globalPrice = formForRow.querySelector(
        'input[name="price"]',
      ) as HTMLInputElement | null;
      if (globalPrice !== null) {
        changeInputValue(globalPrice, String(config.price));
        await sleep(50);
      }
    }
  }

  // 5. Locations. BUY/SELL take a single delivery point (`location`);
  // SHIP takes origin + destination. We match every AddressSelector
  // input currently in the modal and pair them in DOM order with the
  // `origin` / `destination` values from the config — first input gets
  // origin, second gets destination. This avoids hardcoding which
  // label the SHIP template uses.
  const addressInputs = Array.from(
    currentForm()?.querySelectorAll(`input.${C.AddressSelector.input}`) ?? [],
  ) as HTMLInputElement[];
  if (addressInputs.length === 0) {
    throw new Error('No AddressSelector input found in template form');
  }
  const fillAddress = async (input: HTMLInputElement, raw: string) => {
    // The template's "位置" / "location" field is an AddressSelector
    // backed by PrUn's server search. We just focus, set the value,
    // wait briefly for PrUn's debounce + server round-trip to
    // populate the listbox, then let selectAddressListboxItem pick
    // the matching item. The 500ms wait was the key bit that the
    // bb9720ce working version used; removing it caused the
    // subsequent fillAddress experiments to fail.
    input.focus();
    await sleep(50);
    const expanded = expandLocationAlias(raw).trim();
    changeInputValue(input, expanded);
    await sleep(500);
    await selectListboxItem(input, expanded);
  };
  if (config.template.toUpperCase() === 'SHIP') {
    if (addressInputs.length < 2) {
      throw new Error(
        `SHIP template needs two address inputs (origin + destination) but found ${addressInputs.length}`,
      );
    }
    await fillAddress(notNullish(addressInputs[0], 'origin input missing'), config.origin!);
    await fillAddress(
      notNullish(addressInputs[1], 'destination input missing'),
      config.destination!,
    );
  } else {
    if (addressInputs.length !== 1) {
      throw new Error(
        `${config.template} template needs one address input but found ${addressInputs.length}`,
      );
    }
    await fillAddress(notNullish(addressInputs[0], 'location input missing'), config.location!);
  }

  // 5b. Optional deadline (days). Leave the template default if omitted.
  if (config.deadline !== undefined) {
    const deadlineInput = currentForm()?.querySelector(
      'input[name="deadline"]',
    ) as HTMLInputElement | null;
    if (deadlineInput !== null) {
      focusElement(deadlineInput);
      await sleep(50);
      changeInputValue(deadlineInput, String(config.deadline));
      await sleep(50);
    }
  }

  // 6. Apply template → modal closes, conditions form refreshes.
  const applyForm = notNullish(
    _$(tsContainer, 'form') as HTMLFormElement | null,
    'Modal <form> missing when looking for Apply button',
  );
  // Diagnostic: log the address input values right before Apply
  // so we can confirm the address is still set when Apply is clicked.
  const addressInputsBeforeApply = Array.from(
    applyForm.querySelectorAll(`input.${C.AddressSelector.input}`),
  ).map(i => `"${(i as HTMLInputElement).value}"`);
  console.info(
    '[contd-auto-fill] before Apply: address inputs =',
    addressInputsBeforeApply.join(', ') || '<none>',
  );
  const applyButton = notNullish(
    _$$(applyForm, 'button').find(b => /apply template|应用模板/i.test(b.textContent ?? '')),
    'Apply Template button not found',
  );
  await clickElement(applyButton);
  await sleep(500);
  // Diagnostic: log the conditions form text after Apply to confirm
  // whether the address carried over.
  const conditionsFormForDump = await findConditionsForm(tile);
  const conditionsText = (conditionsFormForDump.textContent ?? '').replace(/\s+/g, ' ').trim();
  console.info('[contd-auto-fill] after Apply: conditions text =', conditionsText);

  // 7. The conditions form now has a "保存" button. Click it.
  const conditionsForm = await findConditionsForm(tile);
  const saveButton = notNullish(
    _$$(conditionsForm, 'button').find(b => /^save$|^保存$/i.test(b.textContent ?? '')),
    'Save button not found in conditions form',
  );
  await clickElement(saveButton);
}

function isContractNotesLabel(label: Element): boolean {
  const text = label.textContent?.trim() ?? '';
  return text === '合同注解' || text === getI18nValue('Contract.notes', 'Contract Notes');
}

// Walks every FormComponent label inside `root`, returns the first
// input/textarea in the same FormComponent row whose label text
// matches `labelText` (exact match, after trim). Used for header
// fields like the contract name input that don't carry a stable
// `name` attribute. Labels inside the auto-fill panel itself are
// skipped so we never accidentally match our own injected "JSON
// 配置" row. Returns null when the label or its input isn't found.
//
// Both containerPassive (e.g. status / naturalId) and containerActive
// (e.g. editable inputs like name / notes) are accepted — the input
// can live in either, so we just look for the nearest FormComponent
// ancestor and search inside it.
function findLabeledInput(root: HTMLElement, labelText: string): HTMLInputElement | null {
  const matcher = (l: Element) => (l.textContent ?? '').trim() === labelText;
  // PrUn's labels inside Draft__form are sometimes plain `<label>`
  // with no FormComponent__label class (the rendered HTML is
  // `<label><span>名称</span></label>`). Accept both classful and
  // bare labels so we can find the contract-name row either way.
  const labelSelector = [`.${C.FormComponent.label}`, 'label'].join(', ');
  for (const label of Array.from(root.querySelectorAll(labelSelector))) {
    // Skip our own panel — its label is "JSON 配置".
    if (label.closest(`[${MARKER}]`) !== null) {
      continue;
    }
    if (matcher(label)) {
      const row =
        label.closest(`.${C.FormComponent.containerPassive}`) ??
        label.closest(`.${C.FormComponent.containerActive}`);
      if (row === null) {
        continue;
      }
      const input = row.querySelector('input');
      if (input !== null) {
        return input as HTMLInputElement;
      }
    }
  }
  return null;
}

function findNotesRow(headerForm: HTMLElement): HTMLElement | undefined {
  for (const label of _$$(headerForm, C.FormComponent.label)) {
    if (!isContractNotesLabel(label)) {
      continue;
    }
    const row = label.closest(`.${C.FormComponent.containerPassive}`);
    if (row) {
      return row as HTMLElement;
    }
  }
  return undefined;
}

function buildPanel(tile: PrunTile) {
  // Build a native FormComponent row: label on the left, input column on
  // the right. This mirrors the 合同注解 / 周期重复 rows above so the
  // panel blends in with the surrounding CONTD header.
  const row = document.createElement('div');
  row.className = `${C.FormComponent.containerPassive} ${C.forms.passive} ${C.forms.formComponent}`;
  row.setAttribute(MARKER, 'true');

  const label = document.createElement('label');
  label.className = `${C.FormComponent.label} ${C.fonts.fontRegular} ${C.type.typeRegular}`;
  label.textContent = 'JSON 配置';
  row.appendChild(label);

  const inputWrap = document.createElement('div');
  inputWrap.className = `${C.FormComponent.input} ${C.forms.input} ${$style.input}`;

  const textarea = document.createElement('textarea');
  textarea.className = $style.textarea;
  textarea.placeholder = 'Enter contract configuration as JSON';
  textarea.spellcheck = false;
  inputWrap.appendChild(textarea);

  const controls = document.createElement('div');
  controls.className = $style.controls;

  const button = document.createElement('button');
  button.type = 'button';
  button.className = `${C.Button.btn} ${C.Button.dark} ${$style.button}`;
  button.textContent = '填写';
  controls.appendChild(button);

  const status = document.createElement('span');
  status.className = $style.status;
  controls.appendChild(status);

  inputWrap.appendChild(controls);

  row.appendChild(inputWrap);

  function setStatus(text: string, isError = false) {
    status.textContent = text;
    status.classList.toggle($style.error, isError);
  }

  function validateConfig(raw: unknown): DraftConfig {
    if (typeof raw !== 'object' || raw === null) {
      throw new Error('JSON must be an object');
    }
    const cfg = raw as Record<string, unknown>;
    if (typeof cfg.template !== 'string' || cfg.template.length === 0) {
      throw new Error('"template" is required (e.g. "BUY", "SELL", "SHIP")');
    }
    const template = cfg.template.toUpperCase();
    if (typeof cfg.currency !== 'string' || cfg.currency.length === 0) {
      throw new Error('"currency" is required (e.g. "NCC", "ICA", "CIS", "AIC")');
    }
    if (!Array.isArray(cfg.items) || cfg.items.length === 0) {
      throw new Error('"items" must be a non-empty array');
    }
    for (let i = 0; i < cfg.items.length; i++) {
      const item = cfg.items[i] as Record<string, unknown> | null;
      if (item === null || typeof item !== 'object') {
        throw new Error(`items[${i}] must be an object`);
      }
      if (typeof item.amount !== 'number' || !isFinite(item.amount) || item.amount <= 0) {
        throw new Error(`items[${i}].amount must be a positive number`);
      }
      if (typeof item.commodity !== 'string' || item.commodity.trim().length === 0) {
        throw new Error(`items[${i}].commodity is required`);
      }
      // For BUY/SELL, each row needs a per-row price — unless a top-
      // level `price` is set, in which case it defaults every row's
      // price. Per-row `price` overrides the top-level value when
      // present (so heterogeneous prices work too). For SHIP, the
      // top-level `price` is required and shared across all rows.
      if (template !== 'SHIP') {
        const rowPrice = item.price ?? cfg.price;
        if (typeof rowPrice !== 'number' || !isFinite(rowPrice) || rowPrice < 0) {
          throw new Error(`items[${i}].price (or top-level "price") must be a non-negative number`);
        }
      } else if (
        item.price !== undefined &&
        (typeof item.price !== 'number' || !isFinite(item.price) || item.price < 0)
      ) {
        throw new Error(`items[${i}].price must be a non-negative number if provided`);
      }
    }
    if (template === 'SHIP') {
      if (
        cfg.price === undefined ||
        typeof cfg.price !== 'number' ||
        !isFinite(cfg.price) ||
        cfg.price < 0
      ) {
        throw new Error('"price" is required for SHIP contracts (single price for all items)');
      }
    }
    // Location requirements differ by template:
    //   BUY/SELL — single delivery point (`location`)
    //   SHIP     — origin + destination (the shipper is the intermediary;
    //              one of these must match the shipper's current location)
    if (template === 'SHIP') {
      if (typeof cfg.origin !== 'string' || cfg.origin.trim().length === 0) {
        throw new Error('"origin" is required for SHIP contracts');
      }
      if (typeof cfg.destination !== 'string' || cfg.destination.trim().length === 0) {
        throw new Error('"destination" is required for SHIP contracts');
      }
      // SHIP is a transport contract between two distinct locations —
      // PrUn will reject origin === destination. Compare after the
      // alias expansion so e.g. `HRT`/`hrt`/`Hortus Station` (all
      // expanded to `VH-331a`) collide as expected.
      const originExpanded = expandLocationAlias(cfg.origin).trim().toUpperCase();
      const destinationExpanded = expandLocationAlias(cfg.destination).trim().toUpperCase();
      if (originExpanded === destinationExpanded) {
        throw new Error(
          `"origin" and "destination" must be different for SHIP contracts (both resolved to "${originExpanded}")`,
        );
      }
    } else {
      if (typeof cfg.location !== 'string' || cfg.location.trim().length === 0) {
        throw new Error('"location" is required (use "origin" + "destination" for SHIP)');
      }
    }
    if (
      cfg.deadline !== undefined &&
      (typeof cfg.deadline !== 'number' || !isFinite(cfg.deadline))
    ) {
      throw new Error('"deadline" must be a number when provided');
    }
    if (cfg.name !== undefined && (typeof cfg.name !== 'string' || cfg.name.length === 0)) {
      throw new Error('"name" must be a non-empty string when provided');
    }
    return cfg as unknown as DraftConfig;
  }

  button.addEventListener('click', async () => {
    const raw = textarea.value.trim();
    if (!raw) {
      return;
    }
    button.setAttribute('disabled', '');
    setStatus('Applying…');
    try {
      const parsed = JSON.parse(raw);
      const config = validateConfig(parsed);
      await applyConfig(tile, config);
      setStatus('Done');
    } catch (e) {
      setStatus(`Error: ${e instanceof Error ? e.message : String(e)}`, true);
      console.warn('Auto-fill failed', e);
    } finally {
      button.removeAttribute('disabled');
    }
  });

  // Mount directly after the 合同注解 row inside the first (header) form,
  // so the JSON panel sits right below the contract notes field rather
  // than at the top of the tile. Falls back to the header form, then the
  // tile frame, if the notes row isn't present yet.
  const headerForm = _$$(tile.anchor, C.Draft.form)[0];
  const notesRow = headerForm !== undefined ? findNotesRow(headerForm) : undefined;
  if (notesRow !== undefined && notesRow.parentElement !== null) {
    notesRow.after(row);
  } else if (headerForm !== undefined) {
    headerForm.appendChild(row);
  } else {
    tile.frame.prepend(row);
  }
}

function onTileReady(tile: PrunTile) {
  subscribe($$(tile.anchor, C.SectionHeader.container), sectionHeader => {
    // Skip section headers that belong to the template-selection modal or
    // any other Overlay — they aren't the header form and re-firing on
    // them would inject duplicate JSON panels.
    if (sectionHeader.closest(`.${C.Overlay.overlay}`) !== null) {
      return;
    }
    // The header form may have been rebuilt by the game — if a previous
    // panel still exists in the DOM, leave it alone. Otherwise (or if the
    // previous panel was orphaned outside the header form) re-mount.
    const existing = tile.anchor.querySelector(`[${MARKER}]`);
    if (existing !== null) {
      if (existing.parentElement !== null) {
        return;
      }
      existing.remove();
    }
    buildPanel(tile);
  });
}

function init() {
  tiles.observe('CONTD', onTileReady);
}

features.add(import.meta.url, init, 'CONTD：粘贴 JSON 一键自动填表。');
