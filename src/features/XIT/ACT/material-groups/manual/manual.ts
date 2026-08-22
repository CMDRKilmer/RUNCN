import { act } from '@src/features/XIT/ACT/act-registry';
import { fixed0 } from '@src/utils/format';
import Edit from '@src/features/XIT/ACT/material-groups/manual/Edit.vue';
import { deepToRaw } from '@src/utils/deep-to-raw';

act.addMaterialGroup({
  type: 'Manual',
  description: data => {
    const materials = data.materials;
    if (!materials || Object.keys(materials).length == 0) {
      return '--';
    }

    return Object.keys(materials)
      .map(ticker => `${fixed0(materials[ticker])} ${ticker}`)
      .join(', ');
  },
  editComponent: Edit,
  generateMaterialBill: async ({ data, log }) => {
    if (!data.materials || Object.keys(data.materials).length == 0) {
      // 空组是合法状态（生成的操作包中本侧无货可移），返回空账单而非失败。
      log.warning('材料组为空。');
      return {};
    }
    return structuredClone(deepToRaw(data.materials));
  },
});
