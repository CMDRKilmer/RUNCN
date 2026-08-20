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

// ── 材料搜索：按配方任一输入/输出材料的 ticker 过滤 ──
const materialSearch = ref('');

// 用 ref 而不是 computed，强制每次 materialSearch / rows 变化都生成新数组。
// 之前用 computed 时 v-for 偶尔读取到的是缓存的旧引用（依赖追踪在嵌套
// <div v-else> + v-else-if 链路下脱钩），导致行数与 filteredRows.length
// 不一致。改为 ref + watch 显式触发更新更可靠。
const filteredRows = ref<RecipeProfit[]>([]);

// 给 tbody 加 :key，每次搜索词或数据变化时强制整个 tbody 重建，
// 避免 Vue v-for 在某些边角情况下 patch 出错的 tr 节点残留。
const rowsKey = ref(0);

function matchesSearch(row: RecipeProfit) {
  const q = materialSearch.value.trim().toUpperCase();
  if (q.length === 0) {
    return true;
  }
  const tickers = [...row.inputs, ...row.outputs].map(x => x.ticker);
  return tickers.some(t => t.toUpperCase().includes(q));
}

function recomputeFiltered() {
  const all = rows.value ?? [];
  filteredRows.value = all.filter(matchesSearch);
  rowsKey.value++;
}

watch(materialSearch, () => {
  rowsKey.value++;
});

watch([rows, materialSearch], recomputeFiltered, { immediate: true });

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
  <template v-else>
    <div :class="$style.searchBar">
      <label :class="$style.searchLabel">材料</label>
      <input
        v-model="materialSearch"
        :class="$style.searchInput"
        type="text"
        placeholder="搜索材料代码…" />
    </div>
    <table :class="$style.table" cellspacing="0" cellpadding="0">
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
      <tbody :key="rowsKey">
        <tr v-if="rows.length === 0">
          <td colspan="9" style="text-align: center; opacity: 0.5; padding: 12px">
            暂无配方数据 - 请确保已打开 PROD 面板
          </td>
        </tr>
        <tr v-else-if="materialSearch.trim() !== '' && filteredRows.length === 0">
          <td colspan="9" style="text-align: center; opacity: 0.5; padding: 12px"
            >没有匹配的配方</td
          >
        </tr>
        <tr v-for="row in filteredRows" :key="row.recipeName + row.siteId">
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
.searchBar {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 8px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.08);
}
.searchLabel {
  font-size: 0.85em;
  opacity: 0.7;
}
.searchInput {
  background: #1a2632;
  color: #ccc;
  border: 1px solid #2b485a;
  padding: 2px 6px;
  font-size: 0.85em;
  width: 160px;
}
</style>
