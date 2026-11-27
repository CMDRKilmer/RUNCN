<script setup lang="ts">
import SectionHeader from '@src/components/SectionHeader.vue';
import PrunButton from '@src/components/PrunButton.vue';
import TextInput from '@src/components/forms/TextInput.vue';
import NumberInput from '@src/components/forms/NumberInput.vue';
import { blueprintsStore } from '@src/infrastructure/prun-api/data/blueprints';
import { shipsStore } from '@src/infrastructure/prun-api/data/ships';
import { storagesStore } from '@src/infrastructure/prun-api/data/storage';
import { getEntityNaturalIdFromAddress } from '@src/infrastructure/prun-api/data/addresses';
import { gameNow } from '@src/infrastructure/fio/orbit';
import { downloadFile } from '@src/utils/dom';
import type {
  FlightBlueprint,
  FlightRequest,
  FormulaSegment,
} from '@src/infrastructure/fio/flight-formula';
import { calculateFormulaOptions, type FormulaOptions } from './formula-options';
import { loadFormulaInputs } from './formula-inputs';
import { ensureGatewayConnections } from './gateway-loader';
import { FUEL_EXCHANGES, ensureFuelPrices, fuelPrices as fuelPriceState } from './fuel-prices';
import $style from './FTC.module.css';

const emit = defineEmits<{ blueprint: [naturalId: string] }>();
const mode = ref('blueprint');
const blueprintId = ref('');
const registration = ref('');
const from = ref('');
const to = ref('');
const payload = ref<number | undefined>(0);
const condition = ref<number | undefined>(1);
const stlFuel = ref<number>();
const ftlFuel = ref<number>();
const fuel = ref<number | undefined>(0.2);
const reactor = ref<number | undefined>(0.5);
const landing = ref(true);
const useGateways = ref(false);
const preference = ref<'LEAST_JUMPS' | 'SHORTEST_FTL'>('LEAST_JUMPS');
const departure = ref('');
const missionId = ref('');
// 燃料单价：始终取 FIO 四市场均价（不提供手填）。
const stlAverageText = computed(() => averageText(fuelPriceState.value.stl));
const ftlAverageText = computed(() => averageText(fuelPriceState.value.ftl));
const timeValue = ref<number | undefined>(0);
const busy = ref(false);
const message = ref('');
const result = shallowRef<FormulaOptions>();
const selected = ref(0);
// 结果里的反应堆（FTL）档位：对比表按选中的反应堆分组，默认跟推荐方案一致。
const reactorFilter = ref<number>();
const blueprints = computed(() => blueprintsStore.all.value ?? []);
const ships = computed(() =>
  (shipsStore.all.value ?? []).filter(x => x.flightId === null && x.address !== null),
);
const ship = computed(() => ships.value.find(x => x.registration === registration.value));
const blueprint = computed(() =>
  blueprints.value.find(
    x =>
      x.naturalId === (mode.value === 'ship' ? ship.value?.blueprintNaturalId : blueprintId.value),
  ),
);
const current = computed(() => result.value?.options[selected.value]);
// 结果里出现过的反应堆档位（自然跃迁航线才有多个；系内/纯网关只有一个）。
const reactorChoices = computed(() =>
  [...new Set((result.value?.options ?? []).map(x => x.reactor))].sort((a, b) => a - b),
);
// 对比表只列同一反应堆的燃料档；切反应堆即查看该 FTL 档的燃料曲线。
const sameReactor = computed(() => {
  const reactorValue = reactorFilter.value ?? result.value?.best.reactor;
  return result.value?.options.filter(x => x.reactor === reactorValue) ?? [];
});
const routeLabel = computed(() =>
  current.value?.route.length === 0
    ? '系内直达'
    : current.value?.route
        .map(x => `${x.from} ${x.gate === undefined ? '→' : '⇢'} ${x.to}`)
        .join(' / '),
);
const phaseLabels: Record<FormulaSegment['type'], string> = {
  TAKE_OFF: '起飞',
  LANDING: '着陆',
  TRANSIT: '转移',
  DEPARTURE: '离港',
  APPROACH: '进近',
  CHARGE: '充能',
  JUMP: '自然跃迁',
  LOCK: '网关锁定',
  JUMP_GATEWAY: '网关跃迁',
  DECAY: '衰减',
};

watch(
  blueprints,
  values => {
    if (blueprintId.value === '' && values.length > 0) {
      blueprintId.value = values[0].naturalId;
    }
  },
  { immediate: true },
);
watch(
  blueprint,
  value => {
    emit('blueprint', value?.naturalId ?? '');
    if (mode.value === 'blueprint' && value !== undefined) {
      stlFuel.value = value.performance.stlFuelCapacity;
      ftlFuel.value = value.performance.ftlFuelCapacity;
      reactor.value = Math.max(0.5, value.performance.minReactorUsage);
    }
  },
  { immediate: true },
);
watch([mode, registration], () => {
  if (mode.value === 'ship') {
    readShip();
  } else if (blueprint.value !== undefined) {
    stlFuel.value = blueprint.value.performance.stlFuelCapacity;
    ftlFuel.value = blueprint.value.performance.ftlFuelCapacity;
  }
});
watch(
  [
    mode,
    blueprintId,
    registration,
    blueprint,
    from,
    to,
    payload,
    condition,
    stlFuel,
    ftlFuel,
    fuel,
    reactor,
    landing,
    useGateways,
    preference,
    departure,
    missionId,
    timeValue,
  ],
  () => {
    result.value = undefined;
    message.value = '';
  },
);

function readShip() {
  const s = ship.value;
  if (s === undefined) {
    return;
  }
  const stl = storagesStore.getById(s.stlFuelStoreId ?? s.idStlFuelStore);
  const ftl = storagesStore.getById(s.ftlFuelStoreId ?? s.idFtlFuelStore);
  const cargo = storagesStore.getById(s.idShipStore);
  const quantity = (store: PrunApi.Store | undefined) =>
    store?.items
      .filter(x => x.type === 'INVENTORY')
      .reduce((sum, x) => sum + (x.quantity?.amount ?? 0), 0);
  stlFuel.value = quantity(stl);
  ftlFuel.value = quantity(ftl);
  payload.value = cargo?.weightLoad;
  condition.value = s.condition;
  from.value = getEntityNaturalIdFromAddress(s.address ?? undefined) ?? '';
}

function required(value: number | undefined, label: string) {
  if (value === undefined || !Number.isFinite(value)) {
    throw new Error(`请填写${label}`);
  }
  return value;
}

// 单价展示：有报价时「均价（参与市场）」，否则显示取数状态。
function averageText(price: { average?: number; markets: { code: string }[] }) {
  if (price.average === undefined) {
    return fuelPriceState.value.loading ? '读取中…' : '未取到报价';
  }
  const value = price.average.toLocaleString(undefined, { maximumFractionDigits: 2 });
  const codes = price.markets.map(x => x.code).join('/');
  return `${value}（${codes}）`;
}

onMounted(() => {
  // 打开面板即从 FIO 读取四市场均价（失败时保持「未计价」，不阻塞计算）。
  void ensureFuelPrices();
});

function rereadFuelPrices() {
  void ensureFuelPrices(true);
}

async function calculate(optimize: boolean) {
  if (busy.value) {
    return;
  }
  result.value = undefined;
  message.value = '';
  busy.value = true;
  try {
    const bp = blueprint.value;
    if (bp === undefined) {
      throw new Error('请选择蓝图，蓝图列表为空时请先打开 BLU');
    }
    if (from.value.trim() === '' || to.value.trim() === '') {
      throw new Error('请填写起点和终点');
    }
    const request: FlightRequest = {
      origin: '',
      destination: '',
      missionId: missionId.value.trim() || undefined,
      landing: landing.value,
      payload: required(payload.value, '载重'),
      condition: required(condition.value, '船况'),
      stlFuel: required(stlFuel.value, 'STL 出发余油'),
      ftlFuel: required(ftlFuel.value, 'FTL 出发余油'),
      fuelUsageFactor: required(fuel.value, 'STL 档位'),
      reactorUsageFactor: required(reactor.value, '反应堆档位'),
      preferences: { useGateways: useGateways.value, ftlPreference: preference.value },
    };
    // 单价始终取 FIO 四市场均价（拿不到就留空 → 成本列显示「未计价」）。
    await ensureFuelPrices();
    const prices = {
      stl: fuelPriceState.value.stl.average,
      ftl: fuelPriceState.value.ftl.average,
      time: required(timeValue.value, '时间价值'),
    };
    const requestedTime = departure.value === '' ? undefined : new Date(departure.value).getTime();
    if (requestedTime !== undefined && !Number.isFinite(requestedTime)) {
      throw new Error('出发时间无效');
    }
    message.value = '正在读取航线与轨道数据…';
    const gatewaysReady = !request.preferences.useGateways || (await ensureGatewayConnections());
    const loaded = await loadFormulaInputs(from.value, to.value, request.preferences.useGateways);
    if (!gatewaysReady && loaded.origin.split('|')[0] !== loaded.destination.split('|')[0]) {
      throw new Error('未能读取网关连接，请稍后重试。');
    }
    request.origin = loaded.origin;
    request.destination = loaded.destination;
    const output = calculateFormulaOptions(
      request,
      bp as unknown as FlightBlueprint,
      loaded.input,
      requestedTime ?? gameNow(),
      prices,
      optimize,
    );
    result.value = output;
    selected.value = output.options.indexOf(output.best);
    reactorFilter.value = output.best.reactor;
    message.value = '';
  } catch (error) {
    message.value = error instanceof Error ? error.message : String(error);
  } finally {
    busy.value = false;
  }
}

function duration(seconds: number) {
  const n = Math.floor(seconds);
  return `${Math.floor(n / 3600)}时${Math.floor((n % 3600) / 60)}分${n % 60}秒`;
}
function money(value?: number) {
  return value === undefined
    ? '未计价'
    : value.toLocaleString(undefined, { maximumFractionDigits: 2 });
}
function exportResult() {
  if (result.value !== undefined) {
    downloadFile(result.value, 'prun-ftc-formula-result.json', true);
  }
}
</script>

<template>
  <SectionHeader>飞行计算器（新公式）</SectionHeader>
  <fieldset :class="$style.calculatorFields" :disabled="busy">
    <div :class="$style.scanFields">
      <label :class="$style.field"
        ><span>计算来源</span
        ><select v-model="mode" :class="$style.select"
          ><option value="blueprint">蓝图</option
          ><option value="ship">停靠飞船</option></select
        ></label
      >
      <label v-if="mode === 'blueprint'" :class="$style.field"
        ><span>蓝图</span
        ><select v-model="blueprintId" :class="$style.select"
          ><option value="" disabled>先打开 BLU 加载蓝图</option
          ><option v-for="b in blueprints" :key="b.id" :value="b.naturalId"
            >{{ b.name || b.naturalId }}（{{ b.naturalId }}）</option
          ></select
        ></label
      >
      <label v-else :class="$style.field"
        ><span>飞船</span
        ><select v-model="registration" :class="$style.select"
          ><option value="" disabled>选择停靠飞船</option
          ><option v-for="s in ships" :key="s.id" :value="s.registration"
            >{{ s.registration }} {{ s.name }}</option
          ></select
        ></label
      >
    </div>
    <div v-if="blueprint" :class="$style.hint"
      >整备质量 {{ blueprint.performance.operatingEmptyMass }} t ｜ STL 罐
      {{ blueprint.performance.stlFuelCapacity }} u ｜ FTL 罐
      {{ blueprint.performance.ftlFuelCapacity }} u</div
    >
    <PrunButton v-if="mode === 'ship'" neutral @click="readShip">重读当前载重与油量</PrunButton>
    <div :class="$style.scanFields">
      <label :class="$style.field"
        ><span>起点（行星／空间站）</span><TextInput v-model="from" placeholder="如 VH-241a 或 BEN"
      /></label>
      <label :class="$style.field"
        ><span>终点（行星／空间站）</span><TextInput v-model="to" placeholder="如 VH-241b 或 ANT"
      /></label>
      <label :class="$style.field"
        ><span>载重（t，不含燃料）</span><NumberInput v-model="payload" optional
      /></label>
      <label :class="$style.field"
        ><span>船况（0–1）</span><NumberInput v-model="condition" optional
      /></label>
      <label :class="$style.field"
        ><span>STL 出发余油（u）</span><NumberInput v-model="stlFuel" optional
      /></label>
      <label :class="$style.field"
        ><span>FTL 出发余油（u）</span><NumberInput v-model="ftlFuel" optional
      /></label>
      <label :class="$style.field"
        ><span>STL 档位（0.05–1）</span><NumberInput v-model="fuel" optional
      /></label>
      <label :class="$style.field"
        ><span
          >反应堆（FTL）档位（{{
            blueprint?.performance.minReactorUsage?.toFixed(4) ?? '蓝图下限'
          }}–1）</span
        ><NumberInput v-model="reactor" optional
      /></label>
      <label :class="$style.field"
        ><span>出发时刻（留空为当前游戏时刻）</span
        ><input v-model="departure" type="datetime-local" step="1"
      /></label>
      <label :class="$style.field"
        ><span>跃迁偏好</span
        ><select v-model="preference" :class="$style.select"
          ><option value="LEAST_JUMPS">最少跳数</option
          ><option value="SHORTEST_FTL">最短 FTL</option></select
        ></label
      >
      <label :class="$style.field"
        ><span>时间价值（₳/小时，0 则只按平衡点）</span><NumberInput v-model="timeValue" optional
      /></label>
    </div>
    <div :class="$style.actions"
      ><label><input v-model="landing" type="checkbox" /> 终点着陆</label
      ><label><input v-model="useGateways" type="checkbox" /> 允许网关</label
      ><PrunButton neutral :disabled="fuelPriceState.loading" @click="rereadFuelPrices">{{
        fuelPriceState.loading ? '读取中…' : '重读 FIO 均价'
      }}</PrunButton></div
    >
    <div :class="$style.hint"
      >燃料单价自动取 FIO 的 {{ FUEL_EXCHANGES.join('／') }} 均价（1:1 不换汇，无需手填）：STL
      {{ stlAverageText }} ｜ FTL {{ ftlAverageText
      }}<template v-if="fuelPriceState.error"
        >；最近一次读取失败（{{ fuelPriceState.error }}）</template
      >。取不到报价时成本列显示「未计价」。</div
    >
    <details :class="$style.costDetails"
      ><summary>成本与精确复算</summary>
      <div :class="$style.scanFields">
        <label :class="$style.field"
          ><span>任务 UUID（可选，用于复算已知着陆任务）</span><TextInput v-model="missionId"
        /></label>
      </div>
    </details>
    <div :class="$style.actions"
      ><PrunButton primary :disabled="busy || !blueprint" @click="calculate(false)"
        >计算当前档位</PrunButton
      ><PrunButton primary :disabled="busy || !blueprint" @click="calculate(true)"
        >寻找平衡方案</PrunButton
      ></div
    >
    <div :class="$style.hint"
      >平衡方案扫描全部 STL 档位，有自然跃迁时同时扫描反应堆（FTL）档。燃料按 FIO
      四市场均价计价；设了时间价值（&gt;0）时按燃料＋时间成本选优，否则取燃料与时间的平衡点。网关通行费另计。</div
    >
  </fieldset>
  <div v-if="message" :class="busy ? $style.hint : $style.error">{{ message }}</div>
  <template v-if="result && current">
    <SectionHeader>{{
      !current.feasible
        ? '油量不足（预测）'
        : current !== result.best
          ? '所选档位预测'
          : result.options.length === 1
            ? '当前档位预测'
            : result.costBased
              ? '成本最优方案'
              : '燃料与时间平衡方案'
    }}</SectionHeader>
    <div :class="$style.hint"
      >出发 {{ new Date(result.timeMs).toLocaleString() }} ｜ {{ routeLabel }}</div
    >
    <div v-for="warning in current.warnings" :key="warning" :class="$style.warning">{{
      warning
    }}</div>
    <div v-if="!current.feasible" :class="$style.error"
      >余油不足，STL 缺 {{ current.stlShortage }} u，FTL 缺
      {{ current.ftlShortage }} u。调整出发余油后重新计算。</div
    >
    <table :class="$style.table"
      ><thead
        ><tr
          ><th>STL 档位</th><th>反应堆（FTL）档</th><th>预计用时</th><th>STL / FTL 耗油</th
          ><th>STL / FTL 余油</th><th>燃料＋时间成本</th></tr
        ></thead
      ><tbody
        ><tr
          ><td>{{ current.fuel }}</td
          ><td>{{ current.reactorRelevant ? current.reactor.toFixed(4) : '不适用' }}</td
          ><td>{{ duration(current.seconds) }}</td
          ><td>{{ current.stlFuel }} / {{ current.ftlFuel }}</td
          ><td>{{ current.stlRemaining }} / {{ current.ftlRemaining }}</td
          ><td>{{ money(current.totalCost) }}</td></tr
        ></tbody
      ></table
    >
    <div :class="$style.hint"
      >预计到达
      {{
        new Date(current.arrivalTimeMs).toLocaleString()
      }}。结果供规划参考，飞行前按原生计划确认。</div
    >
    <details v-if="result.options.length > 1" :class="$style.diagnostic"
      ><summary>档位对比（点击查看分段）</summary
      ><label v-if="reactorChoices.length > 1" :class="$style.field"
        ><span>反应堆（FTL）档位</span
        ><select v-model.number="reactorFilter" :class="$style.select"
          ><option v-for="r in reactorChoices" :key="r" :value="r"
            >{{ r.toFixed(4) }}{{ r === result.best.reactor ? '（推荐）' : '' }}</option
          ></select
        ></label
      ><table :class="$style.table"
        ><thead
          ><tr
            ><th>STL 档位</th><th>用时</th><th>STL / FTL 耗油</th><th>成本</th><th>状态</th></tr
          ></thead
        ><tbody
          ><tr
            v-for="option in sameReactor"
            :key="option.fuel"
            :class="[$style.row, option === current ? $style.best : undefined]"
            @click="selected = result.options.indexOf(option)"
            ><td>{{ option.fuel }}</td
            ><td>{{ duration(option.seconds) }}</td
            ><td>{{ option.stlFuel }} / {{ option.ftlFuel }}</td
            ><td>{{ money(option.totalCost) }}</td
            ><td>{{
              !option.feasible ? '余油不足' : option === result.best ? '推荐' : '可用'
            }}</td></tr
          ></tbody
        ></table
      ></details
    >
    <details open :class="$style.diagnostic"
      ><summary>航线分段（公式预测）</summary
      ><table :class="$style.planTable"
        ><thead
          ><tr><th>阶段</th><th>用时</th><th>STL</th><th>FTL</th></tr></thead
        ><tbody
          ><tr v-for="(segment, i) in current.segments" :key="i"
            ><td>{{ phaseLabels[segment.type] }}</td
            ><td>{{ duration(segment.seconds) }}</td
            ><td>{{ segment.stlFuel }}</td
            ><td>{{ segment.ftlFuel }}</td></tr
          ></tbody
        ></table
      ></details
    >
    <PrunButton neutral @click="exportResult">导出计算结果</PrunButton>
  </template>
</template>
