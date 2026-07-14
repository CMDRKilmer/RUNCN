// Auto-fills a contract draft from a JSON config pasted into a textarea.
// Adapted from the PrUn Operator user script (https://prop.auroras.xyz/prun-operator.user.js).

import { changeInputValue, changeSelectIndex, clickElement, focusElement } from '@src/util';
import { sleep } from '@src/utils/sleep';
import { materialsStore } from '@src/infrastructure/prun-api/data/materials';
import css from '@src/utils/css-utils.module.css';
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
  location: string;
  // Optional. Falls back to the template's default (typically 3 days) when
  // omitted.
  deadline?: number;
}

const MARKER = 'data-rprun-auto-fill';
const EXAMPLE =
  '{"template":"BUY","currency":"NCC","items":[{"amount":100,"commodity":"Iron Ore","price":10}],"location":"QQ-001b","deadline":7}';

// Hard-coded location aliases. When the user passes one of these tickers
// (case-insensitive) we expand them to a more specific naturalId so the
// game's autocomplete lands on the intended place. Anything else is passed
// through verbatim.
const LOCATION_ALIASES: Record<string, string> = {
  HRT: 'Hortus Station',
  ANT: 'Antares Station',
  BEN: 'Benten Station',
  MOR: 'Moria Station',
};

function expandLocationAlias(input: string): string {
  return LOCATION_ALIASES[input.trim().toUpperCase()] ?? input;
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

function notNullish<T>(value: T | null | undefined, message: string): T {
  if (value === null || value === undefined) {
    throw new Error(message);
  }
  return value;
}

function setSelectValue(select: HTMLSelectElement, value: string) {
  const index = Array.from(select.options).findIndex(o => o.value === value);
  assert(index >= 0, `Option "${value}" not found in select`);
  changeSelectIndex(select, index);
}

function resolveMaterialText(input: string): string {
  // Tickers win — they're stable and unambiguous.
  const ticker = input.trim().toUpperCase();
  if (ticker.length === 3) {
    const material = materialsStore.getByTicker(ticker);
    if (material) {
      return material.ticker;
    }
  }
  // Otherwise pass through (the game's autocomplete will fuzzy-match the name).
  return input;
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
    throw new Error('Material listbox not found after typing commodity');
  }
  // Wait for at least one list item to populate.
  const deadline = Date.now() + 3000;
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
  const target =
    candidates.find(li => (li.textContent ?? '').toUpperCase().includes(needle)) ?? candidates[0];
  assert(target !== undefined, `No list item matched "${expectedText}" in material listbox`);
  target.scrollIntoView();
  // 1. Native HTMLElement.click() — synthesizes a trusted click that
  //    react-autosuggest's onClick handler picks up reliably.
  (target as HTMLLIElement).click();
  await sleep(150);
  // 2. Fallback: drive selection via keyboard on the input. Re-focus first
  //    because clicking the <li> may have blurred the input.
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

  // 1. Pick template.
  const templateSelect = notNullish(
    _$(tsContainer, C.TemplateSelection.templateTypeSelect) as HTMLElement | null,
    'Template select container not found in modal',
  ).querySelector('select') as HTMLSelectElement | null;
  if (!templateSelect) {
    throw new Error('Template <select> not found in modal');
  }
  setSelectValue(templateSelect, config.template);
  await sleep(200);

  // After picking a template, the form below re-renders with the matching
  // inputs. Find the form again from the template container.
  const modalForm = notNullish(
    _$(tsContainer, 'form') as HTMLFormElement | null,
    'Modal <form> not found',
  );

  // 2. Pick currency.
  const currency = modalForm.querySelector('select[name="currency"]') as HTMLSelectElement | null;
  if (!currency) {
    throw new Error('Currency select not found');
  }
  setSelectValue(currency, config.currency);
  await sleep(50);

  // 3. Top up commodity rows.
  const addButton = notNullish(
    _$$(modalForm, 'button').find(b => /add commodity|添加商品/i.test(b.textContent ?? '')),
    'Add Commodity button not found',
  );
  for (let i = 1; i < config.items.length; i++) {
    await clickElement(addButton);
    await sleep(50);
  }

  // 4. Fill each row.
  for (let i = 0; i < config.items.length; i++) {
    const item = notNullish(config.items[i], `Item ${i} missing in config`);

    const amountInput = notNullish(
      modalForm.querySelector(`input[name="trades[${i}].amount"]`) as HTMLInputElement | null,
      `Amount input for item ${i} not found`,
    );
    changeInputValue(amountInput, String(item.amount));
    await sleep(50);

    // The MaterialSelector input is the first <input> inside the row whose
    // container has C.MaterialSelector.container. It's easier to grab the
    // input by its sibling label.
    const label = notNullish(
      modalForm.querySelector(`label[for="trades[${i}].material"]`),
      `Material label for item ${i} not found`,
    );
    const row = label.parentElement!;
    const materialInput = notNullish(
      _$(row, 'input') as HTMLInputElement | null,
      `Material input for item ${i} not found`,
    );
    focusElement(materialInput);
    await sleep(50);
    changeInputValue(materialInput, resolveMaterialText(item.commodity));
    await sleep(150);
    await selectListboxItem(materialInput, item.commodity);
    await sleep(50);

    const priceInput = notNullish(
      modalForm.querySelector(`input[name="trades[${i}].pricePerUnit"]`) as HTMLInputElement | null,
      `Price input for item ${i} not found`,
    );
    changeInputValue(priceInput, String(item.price));
    await sleep(50);
  }

  // 5. Location.
  const locationInput = notNullish(
    modalForm.querySelector(`input.${C.AddressSelector.input}`) as HTMLInputElement | null,
    'Location input not found',
  );
  focusElement(locationInput);
  await sleep(50);
  const expandedLocation = expandLocationAlias(config.location);
  changeInputValue(locationInput, expandedLocation);
  await sleep(500);
  await selectListboxItem(locationInput, expandedLocation);

  // 5b. Optional deadline (days). Leave the template default if omitted.
  if (config.deadline !== undefined) {
    const deadlineInput = modalForm.querySelector(
      'input[name="deadline"]',
    ) as HTMLInputElement | null;
    if (deadlineInput) {
      focusElement(deadlineInput);
      await sleep(50);
      changeInputValue(deadlineInput, String(config.deadline));
      await sleep(50);
    }
  }

  // 6. Apply template → modal closes, conditions form refreshes.
  const applyButton = notNullish(
    _$$(modalForm, 'button').find(b => /apply template|应用模板/i.test(b.textContent ?? '')),
    'Apply Template button not found',
  );
  await clickElement(applyButton);
  await sleep(300);

  // 7. The conditions form now has a "保存" button. Click it.
  const conditionsForm = await findConditionsForm(tile);
  const saveButton = notNullish(
    _$$(conditionsForm, 'button').find(b => /^save$|^保存$/i.test(b.textContent ?? '')),
    'Save button not found in conditions form',
  );
  await clickElement(saveButton);
}

function buildPanel(tile: PrunTile) {
  const panel = document.createElement('div');
  panel.className = $style.panel;
  panel.setAttribute(MARKER, 'true');

  const textarea = document.createElement('textarea');
  textarea.className = $style.textarea;
  textarea.placeholder = 'Enter contract configuration as JSON';
  textarea.spellcheck = false;
  panel.appendChild(textarea);

  const controls = document.createElement('div');
  controls.className = $style.controls;

  const button = document.createElement('button');
  button.type = 'button';
  button.className = `${C.Button.btn} ${$style.button}`;
  button.textContent = 'Auto Set';
  controls.appendChild(button);

  const status = document.createElement('span');
  status.className = css.hidden;
  controls.appendChild(status);

  const hint = document.createElement('div');
  hint.className = $style.example;
  hint.textContent = `Example: ${EXAMPLE}`;

  panel.appendChild(controls);
  panel.appendChild(hint);

  function setStatus(text: string, isError = false) {
    status.textContent = text;
    status.classList.toggle(css.hidden, text.length === 0);
    status.classList.toggle($style.error, isError);
  }

  button.addEventListener('click', async () => {
    const raw = textarea.value.trim();
    if (!raw) {
      return;
    }
    button.setAttribute('disabled', '');
    setStatus('Applying…');
    try {
      const config = JSON.parse(raw) as DraftConfig;
      await applyConfig(tile, config);
      setStatus('Done');
    } catch (e) {
      setStatus(`Error: ${e instanceof Error ? e.message : String(e)}`, true);
      console.warn('Auto-fill failed', e);
    } finally {
      button.removeAttribute('disabled');
    }
  });

  // Mount the panel at the top of the tile frame so it stays put even when
  // the in-form DOM is rebuilt by the game.
  tile.frame.prepend(panel);
}

function onTileReady(tile: PrunTile) {
  if (tile.frame.querySelector(`[${MARKER}]`) !== null) {
    return;
  }
  // Use the section header presence as a "draft form is ready" signal —
  // the panel is built exactly once per tile.
  subscribe($$(tile.anchor, C.SectionHeader.container), () => {
    if (tile.frame.querySelector(`[${MARKER}]`) === null) {
      buildPanel(tile);
    }
  });
}

function init() {
  tiles.observe('CONTD', onTileReady);
}

features.add(import.meta.url, init, 'CONTD：粘贴 JSON 一键自动填表。');
