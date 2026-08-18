<script setup lang="ts">
import LoadingSpinner from '@src/components/LoadingSpinner.vue';
import PrunLink from '@src/components/PrunLink.vue';
import BaseAlias from '@src/components/BaseAlias.vue';
import MaterialIcon from '@src/components/MaterialIcon.vue';
import { showBuffer } from '@src/infrastructure/prun-ui/buffers';
import { sitesStore } from '@src/infrastructure/prun-api/data/sites';
import { productionStore } from '@src/infrastructure/prun-api/data/production';
import {
  getEntityNameFromAddress,
  getEntityNaturalIdFromAddress,
} from '@src/infrastructure/prun-api/data/addresses';
import { getPrice } from '@src/infrastructure/fio/cx';
import { fixed2 } from '@src/utils/format';

interface RecipeProfit {
  planetName: string;
  naturalId: string;
  siteId: string;
  buildingType: string;
  recipeName: string;
  inputs: { ticker: string; factor: number }[];
  outputs: { ticker: string; factor: number }[];
  inputCost: number;
  outputValue: number;
  profit: number;
  roi: number;
}

const rows = computed<RecipeProfit[] | undefined>(() => {
  const sites = sitesStore.all.value;
  if (!sites) {
    return undefined;
  }

  const result: RecipeProfit[] = [];
  const seen = new Set<string>();

  for (const site of sites) {
    const lines = productionStore.getBySiteId(site.siteId);
    if (!lines) {
      continue;
    }

    const planetName = getEntityNameFromAddress(site.address) ?? '';
    const naturalId = getEntityNaturalIdFromAddress(site.address) ?? '';

    for (const line of lines) {
      for (const template of line.productionTemplates) {
        const key = `${template.id}:${site.siteId}`;
        if (seen.has(key)) {
          continue;
        }
        seen.add(key);

        const inputs = template.inputFactors.map(x => ({
          ticker: x.material.ticker,
          factor: x.factor,
        }));
        const outputs = template.outputFactors.map(x => ({
          ticker: x.material.ticker,
          factor: x.factor,
        }));

        let inputCost = 0;
        let hasPrices = true;
        for (const input of inputs) {
          const price = getPrice(input.ticker);
          if (price === undefined) {
            hasPrices = false;
            break;
          }
          inputCost += price * input.factor;
        }
        if (!hasPrices) {
          continue;
        }

        let outputValue = 0;
        for (const output of outputs) {
          const price = getPrice(output.ticker);
          if (price === undefined) {
            hasPrices = false;
            break;
          }
          outputValue += price * output.factor;
        }
        if (!hasPrices) {
          continue;
        }

        const profit = outputValue - inputCost;
        const roi = inputCost > 0 ? (profit / inputCost) * 100 : 0;

        result.push({
          planetName,
          naturalId,
          siteId: site.siteId,
          buildingType: line.type,
          recipeName: template.name,
          inputs,
          outputs,
          inputCost,
          outputValue,
          profit,
          roi,
        });
      }
    }
  }

  return result.sort((a, b) => b.roi - a.roi);
});

function formatCurrency(value: number) {
  return value.toFixed(2);
}

function roiClass(roi: number) {
  if (roi > 50) {
    return C.ColoredValue.positive;
  }
  if (roi > 0) {
    return '';
  }
  return C.ColoredValue.negative;
}
</script>

<template>
  <LoadingSpinner v-if="rows === undefined" />
  <table v-else :style="{ width: '100%' }">
    <thead>
      <tr>
        <th>星球</th>
        <th>建筑</th>
        <th>配方</th>
        <th>输入</th>
        <th>输出</th>
        <th>成本</th>
        <th>收入</th>
        <th>利润</th>
        <th>利润率</th>
        <th>操作</th>
      </tr>
    </thead>
    <tbody>
      <tr v-if="rows.length === 0">
        <td colspan="10" style="text-align: center; opacity: 0.5; padding: 12px">
          暂无配方数据 - 请确保已打开 PROD 面板
        </td>
      </tr>
      <tr v-for="row in rows" :key="row.recipeName + row.siteId">
        <td>
          <PrunLink inline :command="`PLI ${row.naturalId}`">
            {{ row.planetName }}
            <BaseAlias :natural-id="row.naturalId" />
          </PrunLink>
        </td>
        <td>{{ row.buildingType }}</td>
        <td>{{ row.recipeName }}</td>
        <td>
          <div :style="{ display: 'flex', gap: '4px', flexWrap: 'wrap' }">
            <MaterialIcon
              v-for="input in row.inputs"
              :key="input.ticker"
              :ticker="input.ticker"
              :amount="input.factor"
              size="small"
              compact />
          </div>
        </td>
        <td>
          <div :style="{ display: 'flex', gap: '4px', flexWrap: 'wrap' }">
            <MaterialIcon
              v-for="output in row.outputs"
              :key="output.ticker"
              :ticker="output.ticker"
              :amount="output.factor"
              size="small"
              compact />
          </div>
        </td>
        <td>{{ formatCurrency(row.inputCost) }}</td>
        <td>{{ formatCurrency(row.outputValue) }}</td>
        <td :class="roiClass(row.roi)">{{ formatCurrency(row.profit) }}</td>
        <td :class="roiClass(row.roi)">{{ fixed2(row.roi) }}%</td>
        <td>
          <button
            :class="[C.Button.btn, C.Button.primary, C.Button.inline]"
            @click="showBuffer(`PROD ${row.siteId}`)">
            PROD
          </button>
        </td>
      </tr>
    </tbody>
  </table>
</template>

<style scoped>
table {
  table-layout: auto;
}
tr > :not(:first-child) {
  text-align: right;
}
</style>
