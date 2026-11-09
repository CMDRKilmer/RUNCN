import { materialCategoriesStore } from '@src/infrastructure/prun-api/data/material-categories';

interface CategorySummary {
  weight: number;
  volume: number;
}

export function getInventorySummary(stores: PrunApi.Store[]) {
  const shipments: CategorySummary = { weight: 0, volume: 0 };
  const categories = new Map<PrunApi.MaterialCategory, CategorySummary>();

  for (const store of stores) {
    for (const item of store.items) {
      if (item.type === 'SHIPMENT') {
        shipments.weight += item.weight;
        shipments.volume += item.volume;
        continue;
      }

      const material = item.quantity?.material;
      if (!material) {
        continue;
      }

      const category = materialCategoriesStore.getById(material.category);
      if (!category) {
        continue;
      }

      let categorySummary = categories.get(category);
      if (!categorySummary) {
        categorySummary = { weight: 0, volume: 0 };
        categories.set(category, categorySummary);
      }

      categorySummary.weight += item.weight;
      categorySummary.volume += item.volume;
    }
  }

  return { shipments, categories };
}
