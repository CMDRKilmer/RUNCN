import { changeInputValue, changeSelectIndex, clickElement, focusElement } from '@src/util';
import { sleep } from '@src/utils/sleep';
import { PurchaseDraftPlan } from './purchase-draft-utils';

const SHORT_TIMEOUT = 1500;
const LONG_TIMEOUT = 5000;

const CREATE_DRAFT = [/新建/, /create/i, /new/i];
const SELECT_TEMPLATE = [/选择模板/, /select template/i];
const PURCHASE_TEMPLATE = [/购买商品/, /采购商品/, /commodity purchase/i, /purchase/i];
const ADD_COMMODITY = [/添加商品/, /add commodity/i, /add material/i, /add item/i];
const APPLY_TEMPLATE = [/应用模板/, /apply template/i];
const SAVE_DRAFT = [/保存/, /save/i];
const NAME_LABEL = [/^名称$/, /^name$/i];
const RECIPIENT_LABEL = [/^接收方$/, /^recipient$/i, /^counterparty$/i];
const QUANTITY_LABEL = [/^数量$/, /^quantity$/i, /^amount$/i];
const MATERIAL_LABEL = [/^商品$/, /^材料$/i, /^commodity$/i, /^material$/i];
const PRICE_LABEL = [/^单价$/, /^price$/i, /^unit price$/i];
const LOCATION_LABEL = [/^位置$/, /^location$/i, /^address$/i];
const DEADLINE_LABEL = [/^限期$/, /^deadline$/i];

export async function generatePurchaseDraft(tile: PrunTile, plan: PurchaseDraftPlan) {
  if (!tile.anchor.isConnected) {
    throw new Error('CONTD 窗口已关闭。');
  }

  await ensureDraftEditor(tile);
  await fillInputByLabel(tile.anchor, NAME_LABEL, plan.name ?? '采购合同草案', false);
  if (plan.recipient) {
    await fillSelectorByLabel(tile.anchor, RECIPIENT_LABEL, plan.recipient, false);
  }

  await openTemplateSelection(tile.anchor);
  await selectPurchaseTemplate(tile.anchor);

  if (plan.location) {
    await fillSelectorByLabel(tile.anchor, LOCATION_LABEL, plan.location, false);
  }
  await fillInputByLabel(tile.anchor, DEADLINE_LABEL, String(plan.deadline), false);

  for (const item of plan.items) {
    await fillInputByLabel(tile.anchor, QUANTITY_LABEL, String(item.amount), true);
    await fillSelectorByLabel(tile.anchor, MATERIAL_LABEL, item.ticker, true);
    await fillInputByLabel(tile.anchor, PRICE_LABEL, String(item.price), true);
    await clickButton(tile.anchor, ADD_COMMODITY, `没有找到“添加商品”按钮（${item.ticker}）。`);
    await sleep(150);
  }

  await clickButton(tile.anchor, APPLY_TEMPLATE, '没有找到“应用模板”按钮。');
  await sleep(350);

  const saveButton = findButton(tile.anchor, SAVE_DRAFT);
  if (saveButton) {
    await clickElement(saveButton);
  }
}

async function ensureDraftEditor(tile: PrunTile) {
  if (hasDraftEditor(tile.anchor)) {
    return;
  }

  await clickButton(tile.anchor, CREATE_DRAFT, '没有找到 CONTD 的“新建”按钮。');
  await waitFor(
    () => hasDraftEditor(tile.anchor),
    LONG_TIMEOUT,
    '新建草案后没有进入草案编辑窗口。',
  );
}

function hasDraftEditor(root: HTMLElement) {
  return (
    !!_$(root, C.Draft.form) ||
    !!_$(root, C.Draft.conditions) ||
    !!findButton(root, SELECT_TEMPLATE)
  );
}

async function openTemplateSelection(root: HTMLElement) {
  if (_$(root, C.TemplateSelection.container)) {
    return;
  }

  await clickButton(root, SELECT_TEMPLATE, '没有找到“选择模板”按钮。');
  await waitFor(
    () => _$(root, C.TemplateSelection.container),
    LONG_TIMEOUT,
    '点击“选择模板”后没有出现模板选择区域。',
  );
}

async function selectPurchaseTemplate(root: HTMLElement) {
  const container = await waitFor(
    () => _$(root, C.TemplateSelection.container) as HTMLElement | undefined,
    SHORT_TIMEOUT,
    '没有找到模板选择区域。',
  );

  const select =
    (_$(container, C.TemplateSelection.templateTypeSelect) as HTMLSelectElement | undefined) ??
    (container.querySelector('select') as HTMLSelectElement | null);

  if (select) {
    const optionIndex = Array.from(select.options).findIndex(option =>
      matchesAny(option.textContent, PURCHASE_TEMPLATE),
    );
    if (optionIndex < 0) {
      throw new Error('没有找到“购买商品/采购商品”模板。');
    }
    changeSelectIndex(select, optionIndex);
    await sleep(250);
    return;
  }

  const templateButton = findClickableByText(container, PURCHASE_TEMPLATE);
  if (!templateButton) {
    throw new Error('没有找到“购买商品/采购商品”模板。');
  }
  await clickElement(templateButton);
  await sleep(250);
}

async function fillInputByLabel(
  root: HTMLElement,
  labels: RegExp[],
  value: string,
  required: boolean,
) {
  const input = findFieldByLabel<HTMLInputElement>(root, labels, ['input']);
  if (!input) {
    if (required) {
      throw new Error(`没有找到字段：${labels[0].source}`);
    }
    return;
  }

  changeInputValue(input, value);
  await sleep(50);
}

async function fillSelectorByLabel(
  root: HTMLElement,
  labels: RegExp[],
  value: string,
  required: boolean,
) {
  const input = findFieldByLabel<HTMLInputElement>(root, labels, ['input']);
  if (!input) {
    if (required) {
      throw new Error(`没有找到字段：${labels[0].source}`);
    }
    return;
  }

  input.focus();
  focusElement(input);
  changeInputValue(input, value);
  await sleep(150);

  const suggestions = getVisibleElements(root, C.MaterialSelector.suggestionEntry).concat(
    getVisibleElements(root, C.UserSelector.suggestionEntry),
    getVisibleElements(root, C.AddressSelector.suggestion),
  );
  const suggestion = suggestions.find(entry => {
    const text = normalizeText(entry.textContent);
    const normalizedValue = normalizeText(value);
    return text === normalizedValue || text.startsWith(normalizedValue) || text.includes(value);
  });

  if (suggestion) {
    await clickElement(suggestion);
    await sleep(100);
  }
}

async function clickButton(root: HTMLElement, matchers: RegExp[], error: string) {
  const button = await waitFor(() => findButton(root, matchers), SHORT_TIMEOUT, error);
  await clickElement(button);
}

function findButton(root: HTMLElement, matchers: RegExp[]) {
  return getVisibleElements(root, C.Button.btn).find(button =>
    matchesAny(button.textContent, matchers),
  );
}

function findClickableByText(root: HTMLElement, matchers: RegExp[]) {
  return getVisibleElements(root, '*').find(element => matchesAny(element.textContent, matchers));
}

function findFieldByLabel<T extends HTMLElement>(
  root: HTMLElement,
  labels: RegExp[],
  selectors: string[],
) {
  const components = Array.from(
    root.getElementsByClassName(C.forms.formComponent),
  ) as HTMLElement[];
  for (const component of components) {
    const label = component.querySelector('label');
    if (!matchesAny(label?.textContent, labels)) {
      continue;
    }

    for (const selector of selectors) {
      const field = component.querySelector(selector);
      if (field instanceof HTMLElement && isVisible(field)) {
        return field as T;
      }
    }
  }

  return undefined;
}

async function waitFor<T>(
  getter: () => T | null | undefined | false,
  timeout: number,
  message: string,
) {
  const startedAt = Date.now();
  do {
    const value = getter();
    if (value !== undefined && value !== null && value !== false) {
      return value;
    }
    await sleep(100);
  } while (Date.now() - startedAt < timeout);

  throw new Error(message);
}

function getVisibleElements(root: HTMLElement, classNameOrSelector: string) {
  const elements =
    classNameOrSelector === '*'
      ? Array.from(root.querySelectorAll<HTMLElement>('*'))
      : (_$$(root, classNameOrSelector) as HTMLElement[]);
  return elements.filter(isVisible);
}

function matchesAny(text: string | null | undefined, matchers: RegExp[]) {
  const normalized = normalizeText(text);
  return matchers.some(matcher => matcher.test(normalized));
}

function normalizeText(text: string | null | undefined) {
  return (text ?? '').replace(/\s+/g, ' ').trim();
}

function isVisible(element: HTMLElement) {
  return element.offsetWidth > 0 || element.offsetHeight > 0 || element.getClientRects().length > 0;
}
