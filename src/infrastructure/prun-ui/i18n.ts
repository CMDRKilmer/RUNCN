import { materialsStore } from '@src/infrastructure/prun-api/data/materials';

interface Entry {
  type: number;
  value: string;
}

export let PrunI18N: Record<string, Entry[] | undefined> = {};

const materialsByName = new Map<string, PrunApi.Material>();

export function loadPrunI18N() {
  PrunI18N = window['PrUn_i18n'];
  for (const material of materialsStore.all.value!) {
    const name = getMaterialName(material);
    if (name) {
      materialsByName.set(name, material);
    }
  }
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
