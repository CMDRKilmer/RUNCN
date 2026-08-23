// Auto-fills a contract draft from a JSON config pasted into a textarea.
// Adapted from the PrUn Operator user script (https://prop.auroras.xyz/prun-operator.user.js).

import { changeInputValue, changeSelectIndex, clickElement, focusElement } from '@src/utils/dom';
import { sleep } from '@src/utils/sleep';
import { materialsStore } from '@src/infrastructure/prun-api/data/materials';
import { getI18nValue } from '@src/infrastructure/prun-ui/i18n';
import { getTileState } from '@src/store/user-data-tiles';
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

// Per-panel id for the injected textarea. The label's `for` must
// point at a real element id so the browser associates them — the
// DevTools accessibility check flags unassociated form fields. A
// counter keeps ids unique across panel rebuilds and tiles.
let nextPanelInputId = 0;

// Preserves the JSON across React-driven panel rebuilds, keyed by the
// tile command (e.g. "CONTD CD-NRHS-7461"). A fresh draft's header
// re-renders several times as server data arrives, replacing the
// panel — a pasted config would vanish and the "填写" click would
// silently do nothing on an empty textarea. Cache entries are dropped
// once the fill completes ("Done"); per-draft entries that are never
// filled are few and harmless.
const panelJsonCache = new Map<string, string>();

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

// Polls `predicate` every 16ms until it turns true or the deadline
// elapses. Returns whether it succeeded. Used for listbox-selection
// commits, which land within a few frames of the click — the 50ms
// waitFor poll would waste most of a frame per row.
async function waitForCommit(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (predicate()) {
      return true;
    }
    if (Date.now() >= deadline) {
      return false;
    }
    await sleep(16);
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

// The listbox lives in a React-Autosuggest / Autowhatever portal under
// document.body, not inside the input's row. Find it by the
// aria-controls attribute on the combobox wrapper, falling back to
// the first open listbox in the document. Returns null when the
// input has no open listbox (e.g. after a selection committed and
// the portal unmounted).
function findListbox(input: HTMLInputElement): HTMLElement | null {
  const combobox = input.closest('[role="combobox"]') as HTMLElement | null;
  const controlsId = combobox?.getAttribute('aria-controls') ?? input.getAttribute('aria-controls');
  if (controlsId) {
    return document.getElementById(controlsId) as HTMLElement | null;
  }
  return document.querySelector('ul[role="listbox"]') as HTMLElement | null;
}

async function selectListboxItem(input: HTMLInputElement, expectedText: string) {
  // Snapshot the typed value so we can detect when the suggestion
  // click / Enter replaces it with the committed display text.
  const typedValue = input.value;
  const listbox = findListbox(input);
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
  // The commit predicate: the listbox portal unmounts on close, or
  // the input value is replaced by the committed suggestion.
  const commitPredicate = () => {
    const value = input.value;
    // A transient empty value means the commit is still in flight.
    return value !== '' && (value !== typedValue || findListbox(input) === null);
  };
  // The click normally commits within a few frames — only run the
  // keyboard fallback if it didn't. Re-focusing unconditionally
  // reopens the listbox and re-commits the first suggestion on every
  // row, which is what the old fixed-sleep version did.
  let committed = await waitForCommit(commitPredicate, 300);
  if (!committed) {
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
    committed = await waitForCommit(commitPredicate, 3000);
  }
  if (!committed) {
    // Throw rather than silently filling the row with an uncommitted
    // search term.
    throw new Error(`Timed out waiting for selection of "${expectedText}" to commit`);
  }
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
function isContractNotesLabel(label: Element): boolean {
  const text = label.textContent?.trim() ?? '';
  return text === '合同注解' || text === getI18nValue('Contract.notes', 'Contract Notes');
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

async function applyConfig(tile: PrunTile, config: DraftConfig): Promise<void> {
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
    // The $ gate below blocks until the modal mounts — no fixed
    // sleep needed here.
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

  // 4. Fill each row. Amount and price writes are plain controlled
  // inputs — run all rows in parallel and let React batch the
  // re-renders. Material selection is different: react-autosuggest
  // only keeps the focused input's listbox open, and focusing row B
  // blurs row A and closes A's listbox — two concurrent material
  // selections would steal each other's listboxes, so materials are
  // filled one row at a time. A verification pass below repairs any
  // row whose parallel write landed on a node React swapped under a
  // concurrent re-render — races surface as a retry, never as a
  // silently wrong contract.
  const currentForm = (): HTMLFormElement | null =>
    _$(tsContainer, 'form') as HTMLFormElement | null;
  const rowInput = (i: number, suffix: string): HTMLInputElement | null =>
    currentForm() === null ? null : findRowInput(currentForm()!, i, suffix);
  const rowMaterialInput = (i: number): HTMLInputElement | null => {
    const form = currentForm();
    if (form === null) {
      return null;
    }
    // The material input has no `name` attribute — the name is on its
    // parent wrapper div. Locate via the row's `material` or `cargo`
    // label (BUY/SELL use `.material`, SHIP uses `.cargo`) and pick
    // the MaterialSelector input inside the label's container row.
    const materialLabel = findRowLabel(form, i, 'material') ?? findRowLabel(form, i, 'cargo');
    if (materialLabel === null) {
      return null;
    }
    return (materialLabel.parentElement!.querySelector(`input.${C.MaterialSelector.input}`) ??
      materialLabel.parentElement!.querySelector('input')) as HTMLInputElement | null;
  };

  const fillAmountAndPrice = async (i: number, item: DraftItem) => {
    await waitFor(() => rowInput(i, 'amount') !== null, `row #${i} amount input to render`);
    changeInputValue(
      notNullish(rowInput(i, 'amount'), `Amount input for item ${i} not found`),
      String(item.amount),
    );
    await sleep(50);
    // Per-row price only exists in BUY/SELL (each row has its own
    // pricePerUnit). SHIP has a single global `price` field outside
    // the shipments array — handled separately for the first row
    // only. Per-row price falls back to top-level `config.price`
    // when the item itself omits it — validateConfig guarantees one
    // of the two is present for BUY/SELL.
    const rowPrice = item.price ?? config.price;
    const priceInput = rowInput(i, 'pricePerUnit');
    if (priceInput !== null && rowPrice !== undefined) {
      changeInputValue(priceInput, String(rowPrice));
      await sleep(50);
    } else if (i === 0 && config.template === 'SHIP') {
      // SHIP template: write the single contract price to the global
      // `price` input. `config.price` is the top-level price for SHIP;
      // it is required by validateConfig when template === 'SHIP'.
      const globalPrice = currentForm()?.querySelector(
        'input[name="price"]',
      ) as HTMLInputElement | null;
      if (globalPrice !== null) {
        changeInputValue(globalPrice, String(config.price));
        await sleep(50);
      }
    }
  };

  const fillMaterial = async (i: number, commodity: string) => {
    const materialInput = notNullish(rowMaterialInput(i), `Material input for item ${i} not found`);
    focusElement(materialInput);
    await sleep(50);
    const resolved = resolveMaterial(commodity);
    const searchText = resolved?.ticker ?? commodity;
    changeInputValue(materialInput, searchText);
    // Wait for the listbox to actually populate with results before
    // trying to pick — older code assumed 150ms was enough and silently
    // hit a stale DOM under slow loads.
    await selectListboxItem(materialInput, resolved?.name ?? commodity);
  };

  // Wave 1: amounts + prices, all rows in parallel. Errors are
  // swallowed — a write lost to a concurrent re-render is detected
  // and repaired by the verification pass below.
  await Promise.all(
    config.items.map((item, i) => fillAmountAndPrice(i, item).catch(() => undefined)),
  );

  // Wave 2: materials, one row at a time — the listbox-focus
  // constraint serializes them anyway. Each fillMaterial either
  // commits (selectListboxItem throws otherwise), so no verification
  // is needed — a failed selection aborts loudly. The post-select
  // settle sleep is dropped: the next row's focus sleep (and the
  // address fill's own focus sleep) absorb the commit render.
  for (let i = 0; i < config.items.length; i++) {
    const item = notNullish(config.items[i], `Item ${i} missing in config`);
    await fillMaterial(i, item.commodity);
  }

  // 4b. Verify every row against the config and repair stragglers.
  for (let i = 0; i < config.items.length; i++) {
    const item = notNullish(config.items[i], `Item ${i} missing in config`);
    const amount = rowInput(i, 'amount');
    if (amount !== null && Number(amount.value) !== item.amount) {
      await fillAmountAndPrice(i, item);
      if (Number(rowInput(i, 'amount')?.value) !== item.amount) {
        throw new Error(`Row ${i}: amount could not be filled (expected ${item.amount})`);
      }
    }
    const rowPrice = item.price ?? config.price;
    const priceInput = rowInput(i, 'pricePerUnit');
    if (priceInput !== null && rowPrice !== undefined && Number(priceInput.value) !== rowPrice) {
      changeInputValue(priceInput, String(rowPrice));
      await sleep(50);
      if (Number(rowInput(i, 'pricePerUnit')?.value) !== rowPrice) {
        throw new Error(`Row ${i}: price could not be filled (expected ${rowPrice})`);
      }
    }
  }
  if (config.template === 'SHIP') {
    const globalPrice = currentForm()?.querySelector(
      'input[name="price"]',
    ) as HTMLInputElement | null;
    if (globalPrice !== null && Number(globalPrice.value) !== config.price) {
      changeInputValue(globalPrice, String(config.price));
      await sleep(50);
      const globalCheck = currentForm()?.querySelector(
        'input[name="price"]',
      ) as HTMLInputElement | null;
      if (globalCheck === null || Number(globalCheck.value) !== config.price) {
        throw new Error(`Price could not be filled (expected ${config.price})`);
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
    // backed by PrUn's server search. We focus, set the value, and
    // wait for a listbox item matching our needle to appear — that
    // is the real "search results are in" signal. The bb9720ce
    // working version used a fixed 500ms sleep, which raced slow
    // servers into clicking stale suggestions. Fast searches now
    // proceed as fast as the server allows; a matchless search fails
    // loudly instead of silently picking a wrong location.
    input.focus();
    await sleep(50);
    const expanded = expandLocationAlias(raw).trim();
    changeInputValue(input, expanded);
    const needle = expanded.toUpperCase();
    await waitFor(
      () => {
        const box = findListbox(input);
        return (
          box !== null &&
          Array.from(box.querySelectorAll('li')).some(li =>
            (li.textContent ?? '').toUpperCase().includes(needle),
          )
        );
      },
      `search results for "${expanded}"`,
      5000,
    );
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
  // Re-resolve the container fresh: the node captured at the top of
  // the fill may have been replaced by an intermediate re-render,
  // and dispatching events on a detached node never reaches React's
  // root listener — the apply click would be silently dropped.
  const modal = _$(tile.anchor, C.TemplateSelection.container);
  const applyForm = notNullish(
    modal === undefined ? null : (_$(modal, 'form') as HTMLFormElement | null),
    'Modal <form> missing when looking for Apply button',
  );
  const applyButton = notNullish(
    _$$(applyForm, 'button').find(b => /apply template|应用模板/i.test(b.textContent ?? '')),
    'Apply Template button not found',
  );
  await clickElement(applyButton);
  // The modal unmounts once PrUn's PATCH round-trips. Check the
  // CURRENT container (not the captured node — the apply re-render
  // replaces it, so a stale node reports "closed" before the PATCH
  // lands and the 保存 click below would race it, losing the draft).
  await waitFor(
    () => _$(tile.anchor, C.TemplateSelection.container) === undefined,
    'template modal to close after applying',
    8000,
  );

  // Applying the template IS the save: PrUn PATCHes the draft on
  // apply, so the conditions land on the server with no extra save
  // click. Clicking the conditions-form 保存 afterwards would
  // re-submit the draft's stale object and overwrite what apply just
  // saved (the "form shows 7 rows but the contract saved 21"
  // symptom) — so there is deliberately no save step here.
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

function buildPanel(tile: PrunTile) {
  // Build a native FormComponent row: label on the left, input column on
  // the right. This mirrors the 合同注解 / 周期重复 rows above so the
  // panel blends in with the surrounding CONTD header.
  const row = document.createElement('div');
  row.className = `${C.FormComponent.containerPassive} ${C.forms.passive} ${C.forms.formComponent}`;
  row.setAttribute(MARKER, 'true');

  const inputId = `rprun-contd-json-${nextPanelInputId++}`;
  const label = document.createElement('label');
  label.className = `${C.FormComponent.label} ${C.fonts.fontRegular} ${C.type.typeRegular}`;
  label.htmlFor = inputId;
  label.textContent = 'JSON 配置';
  row.appendChild(label);

  const inputWrap = document.createElement('div');
  inputWrap.className = `${C.FormComponent.input} ${C.forms.input} ${$style.input}`;

  const textarea = document.createElement('textarea');
  textarea.id = inputId;
  textarea.className = $style.textarea;
  textarea.placeholder = 'Enter contract configuration as JSON';
  textarea.spellcheck = false;
  inputWrap.appendChild(textarea);

  // Keep the panel's textarea value in sync with the cache so a React
  // rebuild of the header (which replaces this panel wholesale) can
  // restore what the user typed / CONTGEN wrote.
  const jsonCacheKey = tile.command;
  textarea.value = panelJsonCache.get(jsonCacheKey) ?? '';
  textarea.addEventListener('input', () => {
    panelJsonCache.set(jsonCacheKey, textarea.value);
  });

  // Consume pending CONTGEN output. CONTGEN's "Send to CONTD" button
  // writes the generated JSON to this workspace key; we read it once
  // on panel mount and pre-fill the textarea, then clear the key so
  // a stale value doesn't refill on every re-mount. The value also
  // goes into the panel cache so a mid-fill rebuild doesn't lose it.
  const pendingContgen = getTileState<{ json?: string }>('contgen-output');
  let autoFilledFromContgen = false;
  if (typeof pendingContgen.json === 'string' && pendingContgen.json.length > 0) {
    textarea.value = pendingContgen.json;
    panelJsonCache.set(jsonCacheKey, pendingContgen.json);
    delete pendingContgen.json;
    // CONTGEN-driven mounts should not require the user to press the
    // "填写" button manually. The user just hit "新建合同并填充" /
    // "发送到 CONTD" in CONTGEN — the next thing they expect to see
    // is the form auto-filling. Defer the click past the current
    // task so React/PrUn have a chance to settle the DOM around
    // the panel before applyConfig walks it; the button reference
    // is captured here so we don't depend on a later querySelector.
    autoFilledFromContgen = true;
  }

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
      // Loud instead of silent: an empty textarea here used to mean a
      // mid-fill panel rebuild wiped the config, and silently ignoring
      // the click left the user with no feedback at all.
      setStatus('JSON is empty', true);
      return;
    }
    button.setAttribute('disabled', '');
    setStatus('Applying…');
    try {
      const parsed = JSON.parse(raw);
      const config = validateConfig(parsed);
      // Applying the template PATCHes the draft — the conditions are
      // saved as part of the apply itself, with no separate save
      // click. When the template modal is gone, the fill is done.
      await applyConfig(tile, config);
      setStatus('Done');
      // The fill consumed the config — a later rebuild of this draft's
      // panel should start fresh, not resurrect a stale JSON.
      panelJsonCache.delete(jsonCacheKey);
    } catch (e) {
      setStatus(`Error: ${e instanceof Error ? e.message : String(e)}`, true);
    } finally {
      button.removeAttribute('disabled');
    }
  });

  // Mount the panel right after the 合同注解 (Contract Notes) row of
  // the header form, matching the original placement. React re-renders
  // the header on server pushes, which destroys injected DOM inside
  // it; onTileReady re-mounts the panel when that happens, and the
  // textarea content survives via panelJsonCache.
  const headerForm = _$(tile.anchor, C.Draft.form);
  const notesRow = headerForm !== undefined ? findNotesRow(headerForm) : undefined;
  if (notesRow !== undefined && notesRow.parentElement !== null) {
    notesRow.after(row);
  } else if (headerForm !== undefined) {
    headerForm.appendChild(row);
  } else {
    tile.frame.prepend(row);
  }

  // Auto-click "填写" when CONTGEN wrote the JSON for us. The click is
  // routed through clickElement so it fires pointerdown+mousedown
  // first — same as a real user press, which PrUn's React handlers
  // expect. Deferring it lets React's hydration / panel layout settle
  // before applyConfig starts walking the form.
  //
  // We must NOT capture the button and click it once: a fresh draft's
  // header re-renders several times as server data arrives, replacing
  // the panel (and its button) — a click on the old, detached node
  // is silently dropped and the fill never happens, leaving an empty
  // status bar with no fill and no save. Instead we poll the live
  // DOM for the current button and click it, using `disabled` (set by
  // the click handler) as the "already running/done" signal so a
  // rebuild between poll and click doesn't double-fire.
  if (autoFilledFromContgen) {
    setStatus('Auto-filling…');
    void (async () => {
      const deadline = Date.now() + 8000;
      for (;;) {
        const liveButton = tile.anchor
          .querySelector(`[${MARKER}]`)
          ?.querySelector<HTMLButtonElement>('button');
        if (liveButton !== null && liveButton !== undefined && liveButton.isConnected) {
          if (liveButton.disabled) {
            return;
          }
          await clickElement(liveButton);
          await sleep(300);
          if (liveButton.disabled) {
            return;
          }
        }
        if (Date.now() >= deadline) {
          return;
        }
        await sleep(100);
      }
    })();
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
    // The panel lives inside the header form, which React rebuilds on
    // server pushes — the injected DOM is destroyed with it. When that
    // happens (existing !== null but detached), drop the stale node and
    // re-mount; otherwise just mount once.
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
