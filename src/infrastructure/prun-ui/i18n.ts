import { materialsStore } from '@src/infrastructure/prun-api/data/materials';
import { materialCategoriesStore } from '@src/infrastructure/prun-api/data/material-categories';
import { watch } from 'vue';

interface Entry {
  type: number;
  value: string;
}

export let PrunI18N: Record<string, Entry[] | undefined> = {};

const materialsByName = new Map<string, PrunApi.Material>();

// 按 category id 缓存本地化结果。`material.category` 存的是 id（如 `consumablesBasic`）。
const categoryNameById = new Map<string, string>();

export function loadPrunI18N() {
  PrunI18N = window['PrUn_i18n'];
  for (const material of materialsStore.all.value!) {
    const name = getMaterialName(material);
    if (name) {
      materialsByName.set(name, material);
    }
  }
  rebuildCategoryLocalization();
  // categories 可能晚于 i18n 到达，监听 store 变化重建缓存
  watch(
    () => materialCategoriesStore.all.value,
    () => rebuildCategoryLocalization(),
    { immediate: true },
  );
}

// 当 categories store 加载完成或更新时重建 id → 本地化名称 映射。
export function rebuildCategoryLocalization() {
  categoryNameById.clear();
  const categories = materialCategoriesStore.all.value;
  if (!categories) {
    return;
  }
  for (const category of categories) {
    const localized = lookupMaterialCategoryI18n(category);
    if (localized) {
      categoryNameById.set(category.id, localized);
    }
  }
}

function lookupMaterialCategoryI18n(category: { id: string; name: string }) {
  // 把 CamelCase 拆开：consumablesBasic -> consumables basic
  const spaced = category.name.replace(/([a-z])([A-Z])/g, '$1 $2');
  const stripped = spaced
    .toLowerCase()
    .replaceAll(' ', '')
    .replaceAll('-', '')
    .replaceAll('(', '')
    .replaceAll(')', '');
  const variants = new Set<string>();
  // 1. id 原样（某些版本用 id 当 key，例如 `MaterialCategory.consumablesBasic`）
  variants.add(category.id);
  // 2. id 小写
  variants.add(category.id.toLowerCase());
  // 3. 全小写无分隔（基于 name）。例如 `consumablesbasic`
  variants.add(stripped);
  // 4. 全小写带空格。例如 `consumables basic`
  variants.add(spaced.toLowerCase());
  // 5. name 原样（区分大小写）
  variants.add(category.name);
  // 6. name 全小写
  variants.add(category.name.toLowerCase());

  for (const key of variants) {
    const value = PrunI18N[`MaterialCategory.${key}`]?.[0]?.value;
    if (value) {
      return value;
    }
  }
  return undefined;
}

export function getI18nValue(key: string): string | undefined;
export function getI18nValue(key: string, defaultValue: string): string;
export function getI18nValue(key: string, defaultValue?: string): string | undefined {
  return PrunI18N[key]?.[0]?.value ?? defaultValue;
}

export function setI18nValue(key: string, value: string): void {
  PrunI18N[key] = [{ type: 0, value }];
}

export function getMaterialName(material?: PrunApi.Material | null) {
  return material ? getI18nValue(`Material.${material?.name}.name`) : undefined;
}

export function getMaterialByName(name?: string | null) {
  return name ? materialsByName.get(name) : undefined;
}

// 通过类别 id 取本地化名称。若没有缓存（例如 categories store 加载晚于 i18n），回退到 name。
export function getMaterialCategoryName(name?: string | null): string | undefined;
export function getMaterialCategoryName(
  id?: string | null,
  name?: string | null,
): string | undefined;
export function getMaterialCategoryName(a?: string | null, b?: string | null): string | undefined {
  if (!a) {
    return undefined;
  }
  // 单参数：可能是 id 也可能是 name
  const cached = categoryNameById.get(a);
  if (cached) {
    return cached;
  }
  // 没命中缓存——做一次兜底查询
  const id = b === undefined ? a : a;
  const name = b === undefined ? undefined : b;
  const fallback = lookupMaterialCategoryI18n({ id, name: name ?? id });
  return fallback;
}
