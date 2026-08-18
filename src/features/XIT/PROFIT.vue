<script setup lang="ts">
import LoadingSpinner from '@src/components/LoadingSpinner.vue';
import PrunLink from '@src/components/PrunLink.vue';
import BaseAlias from '@src/components/BaseAlias.vue';
import MaterialIcon from '@src/components/MaterialIcon.vue';
import BuildingIcon from '@src/components/BuildingIcon.vue';
import IconCell from '@src/features/XIT/PROD/IconCell.vue';
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
  buildingTicker: string;
  recipeName: string;
  inputs: { ticker: string; factor: number }[];
  outputs: { ticker: string; factor: number }[];
  inputCost: number;
  outputValue: number;
  productionFee: number;
  profit: number;
  margin: number;
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

        const productionFee = template.productionFeeFactor?.amount ?? 0;
        const profit = outputValue - inputCost - productionFee;
        const margin = outputValue > 0 ? (profit / outputValue) * 100 : 0;

        if (profit <= 0) {
          continue;
        }

        const buildingTicker =
          site.platforms.find(x => x.module.reactorName === line.type)?.module.reactorTicker ??
          line.type;

        result.push({
          planetName,
          naturalId,
          siteId: site.siteId,
          buildingTicker,
          recipeName: template.name,
          inputs,
          outputs,
          inputCost,
          outputValue,
          productionFee,
          profit,
          margin,
        });
      }
    }
  }

  return result.sort((a, b) => b.margin - a.margin);
});

function formatCurrency(value: number) {
  return value.toFixed(2);
}

function marginClass(margin: number) {
  if (margin > 50) {
    return C.ColoredValue.positive;
  }
  if (margin > 0) {
    return '';
  }
  return C.ColoredValue.negative;
}
</script>

<template>
  <LoadingSpinner v-if="rows === undefined" />
  <table v-else :class="$style.table" cellspacing="0" cellpadding="0">
    <thead>
      <tr>
        <th :class="$style.colPlanet">星球</th>
        <th :class="$style.colBuilding">建筑</th>
        <th>输入</th>
        <th :class="$style.colOutput">输出</th>
        <th>成本</th>
        <th>收入</th>
        <th>利润</th>
        <th :class="$style.colMargin">利润率</th>
        <th :class="$style.colAction">操作</th>
      </tr>
    </thead>
    <tbody>
      <tr v-if="rows.length === 0">
        <td colspan="9" style="text-align: center; opacity: 0.5; padding: 12px">
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
        <IconCell :class="$style.colBuilding">
          <BuildingIcon size="inline-table" :ticker="row.buildingTicker" />
        </IconCell>
        <td :class="$style.iconColumn">
          <div :class="$style.iconRow">
            <MaterialIcon
              v-for="input in row.inputs"
              :key="input.ticker"
              :ticker="input.ticker"
              :amount="input.factor"
              size="small"
              compact />
          </div>
        </td>
        <td :class="[$style.iconColumn, $style.colOutput]">
          <div :class="$style.iconRow">
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
        <td :class="marginClass(row.margin)">{{ formatCurrency(row.profit) }}</td>
        <td :class="[marginClass(row.margin), $style.colMargin]">{{ fixed2(row.margin) }}%</td>
        <td :class="$style.colAction">
          <button
            :class="[C.Button.btn, C.Button.primary, C.Button.inline]"
            @click="showBuffer(`PROD ${row.siteId.substring(0, 8)}`)">
            PROD
          </button>
        </td>
      </tr>
    </tbody>
  </table>
</template>

<style module>
.table {
  width: 100%;
  border-collapse: collapse;
}
.table tr > :not(:first-child) {
  text-align: right;
}
.iconColumn {
  vertical-align: middle;
}
.iconRow {
  display: flex;
  gap: 4px;
  flex-wrap: wrap;
  justify-content: flex-end;
}
.colPlanet {
  white-space: nowrap;
}
.colBuilding {
  width: 40px;
}
.colOutput {
  width: 100px;
}
.colMargin {
  width: 80px;
}
.colAction {
  width: 70px;
}
.table th,
.table td {
  padding: 4px 8px;
  vertical-align: middle;
}
.table th:not(:first-child),
.table td:not(:first-child) {
  text-align: right;
}
</style>
