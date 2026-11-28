<script setup lang="ts">
// XIT GOVH「基建建造」页：按 oog 的 infra-calc 口径，从 0 级起算行星项目 +
// 基础设施建筑 + 仓库升级所需的全部物料，联动本地订单簿报价与 XIT CBUY 采购。
// 系数与公式固化在 govh-buildings.ts，运行时零外部请求。

import PrunButton from '@src/components/PrunButton.vue';
import SectionHeader from '@src/components/SectionHeader.vue';
import Active from '@src/components/forms/Active.vue';
import TextInput from '@src/components/forms/TextInput.vue';
import MaterialIcon from '@src/components/MaterialIcon.vue';
import { showBuffer } from '@src/infrastructure/prun-ui/buffers';
import { materialsStore } from '@src/infrastructure/prun-api/data/materials';
import { formatCurrency } from '@src/utils/format';
import { setGovhQuote } from './govh-quote';
import { readPrices, subscribePrices } from './govh-prices';
import {
  BUILDING_MAX_LEVEL,
  PLANETARY_PROJECTS,
  SCALABLE_BUILDINGS,
  WAREHOUSE_CAPACITY_PER_LEVEL,
  WAREHOUSE_MAX_LEVEL,
  computeBuildMaterials,
  levelCost,
} from './govh-buildings';
import { NEED_LABELS, UPKEEP_BUILDINGS, type InfraNeed } from './govh-model';
import { recommendLevels } from './govh-recommend';
import { readWarehouseLevel, readBuiltPlanetProjects } from './govh-dom';

import type { GovhSnapshot } from './govh-dom';

const props = defineProps<{
  defaultPlanet?: string;
  snapshot?: GovhSnapshot;
  governments?: readonly { label: string; value: string }[];
  government?: string;
  governmentPlaceholder?: string;
}>();
const emit = defineEmits<{ 'update:government': [value: string] }>();

const selectedProjects = ref<Set<string>>(new Set());
const levels = ref<Record<string, number>>(
  Object.fromEntries(SCALABLE_BUILDINGS.map(building => [building.code, 0])),
);
const warehouseLevel = ref(0);
// 推荐结果是否仍然是当前目标：点过推荐就带下划线并保持，手动改任何等级或换星球即失效。
// （之前只亮 1.2 秒就恢复，看不出到底按没按过。）
const recommendApplied = ref(false);
// 仓库当前等级来自 WAR 窗口：读不到时为 undefined（表格显示「—」），按 0 参与计算。
const warehouseStart = ref<number | undefined>(undefined);
// 起点：默认「当前等级」——政府已经建好的等级不重复算材料；切成「0 级」就是规划全新星球。
const fromCurrent = ref(true);

const selectedPlanet = computed(() => props.snapshot?.planet ?? props.government ?? '');

const startLevels = computed<Record<string, number>>(() => {
  const source = fromCurrent.value ? (props.snapshot?.levels ?? {}) : {};
  return Object.fromEntries(
    SCALABLE_BUILDINGS.map(building => [
      building.code,
      Math.min(source[building.code] ?? 0, BUILDING_MAX_LEVEL),
    ]),
  );
});

const warehouseStartLevel = computed(() => (fromCurrent.value ? (warehouseStart.value ?? 0) : 0));

// 读到的当前等级直接作为目标下限：打开面板先看到「现状（0 材料）」，
// 把某一项往上调才产生增量材料。
// 换星球时目标整体归位到新星球的起点——否则上一个星球调高的目标会留在这里，
// 按不存在的等级算材料。
let lastPlanet = '';
watch(
  [selectedPlanet, startLevels],
  ([planet, next]) => {
    if (!fromCurrent.value) {
      lastPlanet = planet;
      return;
    }
    const fresh = planet !== lastPlanet;
    lastPlanet = planet;
    if (fresh) {
      recommendApplied.value = false;
    }
    const merged: Record<string, number> = fresh ? {} : { ...levels.value };
    for (const building of SCALABLE_BUILDINGS) {
      const floor = next[building.code] ?? 0;
      const current = merged[building.code] ?? 0;
      merged[building.code] = fresh ? floor : Math.max(current, floor);
    }
    levels.value = merged;
  },
  { immediate: true },
);

// ── 按大类分组（安全 / 健康 / 舒适 / 文化 / 教育）──
// 双需求建筑按「第一个需求」归主类，避免同一座建筑在两组里各出现一次。
function primaryNeed(code: string): InfraNeed | undefined {
  const needs = UPKEEP_BUILDINGS.find(building => building.ticker === code)?.needs;
  return needs === undefined ? undefined : (Object.keys(needs) as InfraNeed[])[0];
}

interface BuildingGroup {
  need: InfraNeed;
  label: string;
  buildings: typeof SCALABLE_BUILDINGS;
}

const buildingGroups: BuildingGroup[] = (Object.keys(NEED_LABELS) as InfraNeed[])
  .map(need => ({
    need,
    label: NEED_LABELS[need],
    buildings: SCALABLE_BUILDINGS.filter(building => primaryNeed(building.code) === need),
  }))
  .filter(group => group.buildings.length > 0);

// 每级提供多少需求点（替代原来那串物料清单，页面更干净）。
function needSummary(code: string): string {
  const needs = UPKEEP_BUILDINGS.find(building => building.ticker === code)?.needs;
  if (needs === undefined) {
    return '';
  }
  return (Object.entries(needs) as [InfraNeed, number][])
    .map(([need, points]) => `${NEED_LABELS[need]} +${points}`)
    .join(' · ');
}

// ── 政府仓库（WAR）等级 ──
// 仓库不在 POPI 的基建列表里，单独开一次 WAR <星球> 读「等级」，读完自动关窗。
const warehouseReading = ref(false);
const warehouseLevels = new Map<string, number>();
let warehouseSeq = 0;

async function loadWarehouseLevel() {
  const planet = selectedPlanet.value.trim();
  warehouseStart.value = undefined;
  if (planet === '') {
    return;
  }
  const cached = warehouseLevels.get(planet.toUpperCase());
  if (cached !== undefined) {
    warehouseStart.value = cached;
    return;
  }
  const seq = ++warehouseSeq;
  warehouseReading.value = true;
  const level = await readWarehouseLevel(planet);
  if (seq !== warehouseSeq) {
    return;
  }
  warehouseReading.value = false;
  if (level === undefined) {
    return;
  }
  warehouseLevels.set(planet.toUpperCase(), level);
  warehouseStart.value = level;
  if (warehouseLevel.value < level) {
    warehouseLevel.value = level;
  }
}

watch(
  selectedPlanet,
  planet => {
    // 两次 hidden 窗口读取必须串行：showBuffer 的队列在窗口关闭动画期间会复用同一个壳，
    // 并发时后一个会拿到前一个正在关闭的窗口，解析必然失败（表现为状态一直「—」）。
    void (async () => {
      await loadWarehouseLevel();
      await loadBuiltProjects(planet.trim());
    })();
  },
  { immediate: true },
);
const destination = ref(props.defaultPlanet ?? '');
// 送货星球跟着顶部选的政府走：星球变了就覆盖；同一星球重读快照（next === prev）不动它，
// 免得把用户手填的值冲掉。
watch(
  () => props.defaultPlanet,
  (next, prev) => {
    if (next && next !== prev) {
      destination.value = next;
    }
  },
);
const priceNonce = ref(0);
const info = ref('');
const disposed = ref(false);

const materials = computed(() =>
  computeBuildMaterials({
    projects: [...selectedProjects.value],
    levels: levels.value,
    startLevels: startLevels.value,
    warehouseLevel: warehouseLevel.value,
    startWarehouseLevel: warehouseStartLevel.value,
  }),
);

const tickers = computed(() => Object.keys(materials.value).sort());

function clampInt(value: number | string, max: number): number {
  const parsed = typeof value === 'number' ? value : Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return 0;
  }
  return Math.min(Math.floor(parsed), max);
}

function normalizeLevels() {
  // 用户手动改过目标等级：推荐结果不再代表当前配置，取消按钮的「已应用」下划线。
  recommendApplied.value = false;
  const next: Record<string, number> = {};
  for (const building of SCALABLE_BUILDINGS) {
    const floor = startLevels.value[building.code] ?? 0;
    next[building.code] = Math.max(
      floor,
      clampInt(levels.value[building.code] ?? 0, BUILDING_MAX_LEVEL),
    );
  }
  levels.value = next;
  warehouseLevel.value = Math.max(
    warehouseStartLevel.value,
    clampInt(warehouseLevel.value, WAREHOUSE_MAX_LEVEL),
  );
}

// ── 行星项目建成状态 ──
// 数据来自 PLI 窗口的「行星项目」区块：那里**只列已建成的项目**，命中即代表已建成。
// 读不到（窗口超时 / 星球无效）时统一显示「—」，不猜。
type BuildStatus = 'built' | 'missing' | 'unknown';

const builtProjects = ref<Set<string> | undefined>(undefined);
let projectsSeq = 0;

async function loadBuiltProjects(planet: string) {
  if (planet === '') {
    builtProjects.value = undefined;
    return;
  }
  const seq = ++projectsSeq;
  const result = await readBuiltPlanetProjects(planet);
  if (seq !== projectsSeq) {
    return;
  }
  builtProjects.value = result;
  // 状态可能比用户点击晚到：把已建成但仍被勾选的项目摘掉，避免清单里留下不需要的物料。
  if (result !== undefined && selectedProjects.value.size > 0) {
    const kept = new Set([...selectedProjects.value].filter(id => !result.has(id)));
    if (kept.size !== selectedProjects.value.size) {
      selectedProjects.value = kept;
    }
  }
}

function projectStatus(id: string): BuildStatus {
  if (builtProjects.value === undefined) {
    return 'unknown';
  }
  return builtProjects.value.has(id) ? 'built' : 'missing';
}

const STATUS_LABELS: Record<BuildStatus, string> = {
  built: '已建成',
  missing: '未建成',
  unknown: '—',
};

function statusLabel(id: string): string {
  return STATUS_LABELS[projectStatus(id)];
}

// ── 行星项目卡片 ──
// 已建成的项目不再计入购物清单（点了也没有材料要买），直接忽略点击。
function toggleProject(id: string) {
  if (projectStatus(id) === 'built') {
    return;
  }
  const next = new Set(selectedProjects.value);
  if (next.has(id)) {
    next.delete(id);
  } else {
    next.add(id);
  }
  selectedProjects.value = next;
}

const prices = computed<Record<string, number | undefined>>(() => {
  void priceNonce.value; // 依赖：手动刷新时强制重算
  const live = readPrices(tickers.value);
  return Object.fromEntries(tickers.value.map(ticker => [ticker, live[ticker]?.price]));
});

const exchanges = computed<Record<string, string>>(() => {
  const live = readPrices(tickers.value);
  return Object.fromEntries(tickers.value.map(ticker => [ticker, live[ticker]?.exchange ?? '—']));
});

interface Row {
  ticker: string;
  amount: number;
  price: number | undefined;
  exchange: string;
  subtotal: number;
  weight: number;
  volume: number;
}

const rows = computed<Row[]>(() => {
  const list: Row[] = [];
  for (const ticker of tickers.value) {
    const amount = materials.value[ticker] ?? 0;
    const price = prices.value[ticker];
    const material = materialsStore.getByTicker(ticker);
    const weight = (material?.weight ?? 0) * amount;
    const volume = (material?.volume ?? 0) * amount;
    list.push({
      ticker,
      amount,
      price,
      exchange: exchanges.value[ticker] ?? '—',
      subtotal: (price ?? 0) * amount,
      weight,
      volume,
    });
  }
  return list.sort((a, b) => {
    const diff = b.subtotal - a.subtotal;
    return diff !== 0 ? diff : a.ticker.localeCompare(b.ticker);
  });
});

const totalCost = computed(() => rows.value.reduce((sum, row) => sum + row.subtotal, 0));
const totalWeight = computed(() => rows.value.reduce((sum, row) => sum + row.weight, 0));
const totalVolume = computed(() => rows.value.reduce((sum, row) => sum + row.volume, 0));
const pricedCount = computed(() => rows.value.filter(row => row.price !== undefined).length);
const isEmpty = computed(() => rows.value.length === 0);

async function refreshPrices() {
  priceNonce.value++;
  info.value = '正在从本地订单簿更新价格（不会连接任何外部网站）…';
  await subscribePrices(tickers.value, () => disposed.value, true);
  if (disposed.value) {
    return;
  }
  info.value = `本地订单簿已更新：${pricedCount.value} / ${tickers.value.length} 种物料有实时买一价`;
}

function openCbuy() {
  if (rows.value.length === 0) {
    info.value = '当前没有需要采购的物料。';
    return;
  }
  setGovhQuote({
    planet: destination.value.trim(),
    target: 1,
    kind: 'build',
    items: rows.value.map(row => ({ ticker: row.ticker, name: row.ticker, amount: row.amount })),
  });
  showBuffer('XIT CBUY GOVH');
}

function resetAll() {
  selectedProjects.value = new Set();
  levels.value = Object.fromEntries(
    SCALABLE_BUILDINGS.map(building => [building.code, startLevels.value[building.code] ?? 0]),
  );
  warehouseLevel.value = warehouseStartLevel.value;
}

// ── 按人口与满足度推荐配置 ──
// 成本口径：这一级所需材料的本地买价合计；缺报价的物料按 1 计价，只用于相对排序。
const recommendNote = ref('');

function stepCost(code: string, from: number, to: number): number {
  const building = SCALABLE_BUILDINGS.find(item => item.code === code);
  if (!building) {
    return 1;
  }
  let total = 0;
  for (const [ticker, base] of Object.entries(building.baseMaterials)) {
    total += levelCost(base, from, to) * (prices.value[ticker] ?? 1);
  }
  return total;
}

function applyRecommend() {
  const snapshot = props.snapshot;
  if (!snapshot) {
    info.value = '先在上方选择政府 / 星球，读到人口数据后才能推荐。';
    return;
  }
  recommendApplied.value = true;
  const result = recommendLevels({
    population: snapshot.population,
    start: startLevels.value,
    fulfillment: snapshot.fulfillment,
    cost: stepCost,
  });
  // 只升不降：已建成的等级是硬下限，推荐结果永远不能把它调低（拆建筑 = 白扔材料）。
  levels.value = Object.fromEntries(
    SCALABLE_BUILDINGS.map(building => [
      building.code,
      Math.max(startLevels.value[building.code] ?? 0, result.levels[building.code] ?? 0),
    ]),
  );
  const parts = (Object.keys(result.needs) as InfraNeed[]).map(need => {
    const item = result.needs[need];
    const total = item.provided + item.added;
    const percent = item.needed > 0 ? Math.min(100, Math.round((total / item.needed) * 100)) : 100;
    return `${NEED_LABELS[need]} ${percent}%`;
  });
  const tail =
    result.unmet.length > 0
      ? `；${result.unmet.map(need => NEED_LABELS[need]).join('、')}顶到 10 级仍不足，需要基地或其他来源`
      : '（送料率不足时按同比例折算）';
  recommendNote.value = `建议后满足度：${parts.join(' · ')}${tail}`;
}

// 物料集合随选择变化：每次变化都为缺报价的物料补订阅（内部按「物料.市场」去重，
// 重复调用不会重开窗口）。
watch(
  tickers,
  next => {
    void subscribePrices(next, () => disposed.value);
  },
  { immediate: true },
);

onUnmounted(() => {
  disposed.value = true;
});
</script>

<template>
  <div :class="$style.root" data-govh-build>
    <div :class="$style.lead">
      默认按「政府当前等级 → 目标等级」算增量；切到「0 级起」就是规划一座全新星球。
      行星项目一次性建造，基础设施建筑与仓库逐级累加，价格来自本地订单簿。
    </div>

    <div :class="$style.topBar">
      <Active label="管理的政府">
        <select
          :value="government"
          :class="$style.governmentSelect"
          data-govh-build-government
          @change="emit('update:government', ($event.target as HTMLSelectElement).value)">
          <option value="" disabled>{{ governmentPlaceholder ?? '选择我管理的政府' }}</option>
          <option v-for="option in governments ?? []" :key="option.value" :value="option.value">
            {{ option.label }}
          </option>
        </select>
      </Active>
      <Active label="起点">
        <div :class="$style.modeGroup">
          <PrunButton
            :primary="fromCurrent"
            :dark="!fromCurrent"
            inline
            data-govh-build-from-current
            @click="fromCurrent = true"
            >当前等级 {{ selectedPlanet }}</PrunButton
          >
          <PrunButton
            :primary="!fromCurrent"
            :dark="fromCurrent"
            inline
            data-govh-build-from-zero
            @click="fromCurrent = false"
            >0 级起</PrunButton
          >
        </div>
      </Active>
    </div>

    <SectionHeader>行星项目</SectionHeader>
    <div :class="$style.projects">
      <button
        v-for="project in PLANETARY_PROJECTS"
        :key="project.id"
        type="button"
        :class="[
          $style.projectCard,
          selectedProjects.has(project.id) && $style.projectActive,
          projectStatus(project.id) === 'built' && $style.projectBuilt,
        ]"
        :disabled="projectStatus(project.id) === 'built'"
        :title="projectStatus(project.id) === 'built' ? '该星球已建成，无需采购' : undefined"
        :data-govh-build-project="project.id"
        @click="toggleProject(project.id)">
        <span :class="$style.projectName">{{ project.name }}</span>
        <span :class="$style.projectMeta">
          <span :class="$style.projectCode">{{ project.code }}</span>
          <span
            :class="[
              $style.projectStatus,
              projectStatus(project.id) === 'built' && $style.statusBuilt,
              projectStatus(project.id) === 'missing' && $style.statusMissing,
            ]"
            :data-govh-build-status="project.id">
            {{ statusLabel(project.id) }}
          </span>
        </span>
      </button>
    </div>

    <div :class="$style.sectionBar">
      <SectionHeader
        >基础设施建筑与仓库（{{ fromCurrent ? '当前等级起' : '0 级起' }}）</SectionHeader
      >
      <PrunButton
        :primary="recommendApplied"
        :dark="!recommendApplied"
        :class="recommendApplied && $style.recommendOn"
        data-govh-build-recommend
        :data-govh-build-recommended="recommendApplied ? '1' : '0'"
        @click="applyRecommend">
        按人口与满足度推荐
      </PrunButton>
    </div>
    <div v-if="recommendNote" :class="$style.recommendNote">{{ recommendNote }}</div>

    <table :class="$style.table">
      <thead>
        <tr>
          <th>建筑</th>
          <th>每级提供</th>
          <th :class="$style.num">当前</th>
          <th :class="$style.num">目标</th>
          <th :class="$style.num">差额</th>
        </tr>
      </thead>
      <tbody>
        <template v-for="group in buildingGroups" :key="group.need">
          <tr :class="$style.groupRow" :data-govh-build-group="group.need">
            <td colspan="5">{{ group.label }}</td>
          </tr>
          <tr v-for="building in group.buildings" :key="building.code">
            <td>{{ building.code }} · {{ building.name }}</td>
            <td :class="$style.hintCell">{{ needSummary(building.code) }}</td>
            <td :class="$style.num">{{ startLevels[building.code] }}</td>
            <td :class="$style.num">
              <input
                v-model.lazy="levels[building.code]"
                type="number"
                min="0"
                :max="BUILDING_MAX_LEVEL"
                :class="$style.levelInput"
                :data-govh-build-level="building.code"
                @change="normalizeLevels" />
            </td>
            <td :class="$style.num">
              {{ Math.max(0, (levels[building.code] ?? 0) - (startLevels[building.code] ?? 0)) }}
            </td>
          </tr>
        </template>

        <tr :class="$style.groupRow"><td colspan="5">仓库</td></tr>
        <tr>
          <td>WAR · 仓库</td>
          <td :class="$style.hintCell">
            可租单元 · 每单元 {{ WAREHOUSE_CAPACITY_PER_LEVEL }} t / m³
            <template v-if="warehouseReading"> · 读取中…</template>
          </td>
          <td :class="$style.num" data-govh-build-warehouse-start>
            {{ fromCurrent ? (warehouseStart ?? '—') : 0 }}
          </td>
          <td :class="$style.num">
            <input
              v-model.lazy="warehouseLevel"
              type="number"
              min="0"
              :max="WAREHOUSE_MAX_LEVEL"
              :class="$style.levelInput"
              data-govh-build-warehouse
              @change="normalizeLevels" />
          </td>
          <td :class="$style.num">{{ Math.max(0, warehouseLevel - warehouseStartLevel) }}</td>
        </tr>
      </tbody>
    </table>

    <SectionHeader>物料清单</SectionHeader>
    <div :class="$style.toolbar">
      <Active label="送货星球">
        <TextInput
          v-model="destination"
          :class="$style.planetInput"
          placeholder="留空则不指定"
          data-govh-build-planet />
      </Active>
      <div :class="$style.actionBar">
        <PrunButton dark @click="refreshPrices">更新价格</PrunButton>
        <PrunButton dark @click="resetAll">清空</PrunButton>
        <PrunButton primary :disabled="isEmpty" data-govh-build-cbuy @click="openCbuy">
          CBUY 比价
        </PrunButton>
      </div>
    </div>

    <div v-if="isEmpty" :class="$style.empty">
      选择行星项目、或把某个建筑 / 仓库的目标等级调到 0 以上，右侧物料清单会自动算出。
    </div>
    <div v-else :class="$style.tableWrap">
      <table :class="$style.table">
        <thead>
          <tr>
            <th>物料</th>
            <th :class="$style.num">数量</th>
            <th :class="$style.num">单价</th>
            <th :class="$style.num">小计</th>
            <th :class="$style.num">重量</th>
            <th :class="$style.num">体积</th>
            <th>市场</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="row in rows" :key="row.ticker" :data-govh-build-row="row.ticker">
            <td :class="$style.materialCol">
              <div :class="$style.materialCell">
                <MaterialIcon :ticker="row.ticker" size="medium" />
              </div>
            </td>
            <td :class="$style.num">{{ row.amount }}</td>
            <td :class="$style.num">
              {{ row.price === undefined ? '—' : formatCurrency(row.price) }}
            </td>
            <td :class="$style.num">{{ formatCurrency(row.subtotal) }}</td>
            <td :class="$style.num">{{ row.weight.toFixed(2) }} t</td>
            <td :class="$style.num">{{ row.volume.toFixed(2) }} m³</td>
            <td>{{ row.exchange }}</td>
          </tr>
        </tbody>
        <tfoot>
          <tr :class="$style.totalRow">
            <td>合计（{{ rows.length }} 种）</td>
            <td :class="$style.num" />
            <td :class="$style.num" />
            <td :class="$style.num" data-govh-build-total>{{ formatCurrency(totalCost) }}</td>
            <td :class="$style.num">{{ totalWeight.toFixed(2) }} t</td>
            <td :class="$style.num">{{ totalVolume.toFixed(2) }} m³</td>
            <td />
          </tr>
        </tfoot>
      </table>
    </div>

    <div :class="$style.note">
      建筑每级成本 = round(基准 × 1.15^(等级−1)) 逐级累加，等级上限 {{ BUILDING_MAX_LEVEL }}；
      仓库按每级倍数 {{ '1/1/1/2/2/3…' }} 累加，上限 {{ WAREHOUSE_MAX_LEVEL }} 级。 价格口径与 BPC /
      CBUY 相同（四个玩家市场的最低有量买价，1:1 不换算汇率）。
    </div>
    <div v-if="info" :class="$style.info">{{ info }}</div>
  </div>
</template>

<style module>
.root {
  display: flex;
  flex-direction: column;
  gap: 0.35rem;
  padding: 0.25rem 0.5rem;
  /* 全页字号统一放大 1 号：其余元素都用 em 相对这里，改一处整页跟着变。 */
  font-size: calc(0.92em + 1px);
}

.lead {
  opacity: 0.75;
}

.topBar {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-end;
  gap: 0.75rem;
}

.governmentSelect {
  min-width: 14em;
}

.modeGroup {
  display: flex;
  gap: 4px;
}

/* 标题行右侧放推荐按钮：SectionHeader 本身是块级标签，包一层 flex 让按钮贴右。 */
.sectionBar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.5rem;
}

.recommendNote {
  font-size: 1em;
  opacity: 0.7;
}

/* 已应用推荐：按钮文字加下划线并保持（参考游戏里 link 类按钮的选中样式）。 */
.recommendOn {
  text-decoration: underline;
  text-underline-offset: 2px;
}

.startInput {
  width: 2.6em;
  text-align: right;
}

.projects {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
  gap: 0.35rem;
}

.projectCard {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 0.35rem 0.45rem;
  border: 1px solid rgba(128, 128, 128, 0.35);
  border-radius: 3px;
  background: transparent;
  color: inherit;
  text-align: left;
  cursor: pointer;
}

.projectActive {
  background-image: linear-gradient(rgba(47, 110, 168, 0.22), rgba(47, 110, 168, 0.22));
  border-color: #2f6ea8;
}

/* 已建成：图标与文字压暗、不能点，避免误以为还要买材料。 */
.projectBuilt {
  opacity: 0.5;
  cursor: default;
}

.projectName {
  font-weight: 600;
}

.projectMeta {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 0.5rem;
  font-size: 0.92em;
  opacity: 0.75;
}

.projectCode {
  opacity: 0.9;
}

.projectStatus {
  border-radius: 2px;
  padding: 0 4px;
  font-size: 0.95em;
}

.statusBuilt {
  background-image: linear-gradient(rgba(90, 169, 230, 0.3), rgba(90, 169, 230, 0.3));
}

.statusMissing {
  opacity: 0.7;
}

.materialCol {
  min-width: 7em;
}

.materialCell {
  display: flex;
  align-items: center;
  gap: 6px;
}

.levelInput {
  width: 3em;
  text-align: right;
}

.toolbar {
  display: flex;
  align-items: flex-end;
  gap: 0.5rem;
  flex-wrap: wrap;
}

/* 按钮组靠右：与「送货星球」同一行，margin-left:auto 把它推到右侧；
   按钮高 19px、输入框连同 label 更高，用 flex-end 让底边对齐。 */
.actionBar {
  display: flex;
  align-items: center;
  gap: 0.4rem;
  margin-left: auto;
}

.planetInput {
  width: 9em;
}

.tableWrap {
  overflow-x: auto;
}

.table {
  width: 100%;
  border-collapse: collapse;
}

.table th,
.table td {
  padding: 1px 6px;
  white-space: nowrap;
  text-align: left;
}

.table .num {
  text-align: right;
  font-variant-numeric: tabular-nums;
}

.table th {
  border-bottom: 1px solid rgba(128, 128, 128, 0.45);
  font-weight: 600;
}

/* 大类分组行：跨列、加淡底，把 14 座建筑切成 5 段。
   底色仍用 background-image（主题引擎只改写 background-color）。 */
.groupRow td {
  padding-top: 6px;
  padding-bottom: 2px;
  font-weight: 600;
  background-image: linear-gradient(rgba(128, 128, 128, 0.16), rgba(128, 128, 128, 0.16));
}

.hintCell {
  font-size: 1em;
  opacity: 0.65;
}

.totalRow td {
  border-top: 1px solid rgba(128, 128, 128, 0.45);
  font-weight: 600;
}

.empty {
  opacity: 0.7;
  padding: 0.35rem 0;
}

.note {
  font-size: 0.92em;
  opacity: 0.6;
}

.info {
  font-size: 0.92em;
  opacity: 0.75;
}
</style>
