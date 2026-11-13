<script setup lang="ts">
import { isRepairableBuilding } from '@src/core/buildings';
import { sitesStore } from '@src/infrastructure/prun-api/data/sites';
import { storagesStore } from '@src/infrastructure/prun-api/data/storage';
import { showBuffer } from '@src/infrastructure/prun-ui/buffers';
import { clickElement } from '@src/utils/dom';
import { sleep } from '@src/utils/sleep';

// BRA 面板自带的「维护」只认状况阈值、一次修完整个列表，没法按建筑类型分批。
// 这里的做法：面板上方加一条按类型分组的工具条，
//   1) 分组与数量直接来自 sitesStore（口径：可维修类型 = 生产/资源，状况低于 BRA 阈值），
//      和 BRA 自己的「待维护建筑」列表是同一批建筑；
//   2) 点某一类时，开一个**隐藏**的 BBL 缓冲窗，逐栋点游戏原生的「维修」按钮 ——
//      可修/缺料的判定完全交给游戏，插件不复制维修公式；
//   3) 连点两次确认，避免误触。
const props = defineProps<{
  /** BRA 命令参数：可能是 siteId，也可能是星球自然编号（如 VH-331b）。 */
  siteId: string;
  /** 磁贴内容根节点：用来读 BRA 自己的阈值滑块与本地化建筑名。 */
  root: HTMLElement;
}>();

// 必须用 shallowRef：ref() 会把游戏 store 里的 Site 做深层 Proxy，
// 再读它的 getter 时游戏侧会抛 undefined.address（整页白屏）。
const site = shallowRef<PrunApi.Site>();

// 以 BRA 面板上「基地」下拉框的当前值为准：命令参数可能是基地别名（BRA VH-331b）、
// 也可能是个不带基地的参数，游戏会自己选一个，只有下拉框才是真正显示的基地。
function resolveSite() {
  const selected = props.root.querySelector('select')?.value;
  if (selected) {
    const byId = sitesStore.getById(selected);
    if (byId) {
      return byId;
    }
  }
  return sitesStore.getById(props.siteId) ?? sitesStore.getByPlanetNaturalIdOrName(props.siteId);
}

interface TypeGroup {
  ticker: string;
  name: string;
  count: number;
}

const groups = ref<TypeGroup[]>([]);
const missing = ref<{ ticker: string; need: number; have: number }[]>([]);
const armedTicker = ref<string | undefined>(undefined);
const busyTicker = ref<string | undefined>(undefined);
// 二次确认除了记录建筑类型，还要绑定「当前基地」与「当前待维修建筑集合」：调高阈值 /
// 切换基地会让实际要修的栋数变多，若只按类型确认，200ms 刷新延迟内按钮仍显示旧栋数
// 却提交了更多维修。两者任一变化都重置确认（PR #60 审查 #221）。
const armedSiteId = ref<string | undefined>(undefined);
const armedTargetSig = ref<string | undefined>(undefined);
const message = ref<string | undefined>(undefined);

let armTimer: number | undefined;

/** BRA 的「最低建筑状况」滑块，aria-valuenow 是 0.33~1 的小数。 */
function readThreshold() {
  const handle = props.root.querySelector('[role="slider"]');
  const value = Number(handle?.getAttribute('aria-valuenow'));
  return Number.isFinite(value) && value > 0 ? value : 1;
}

/** BRA 列表里的图标 title 是本地化名称（无人机厂），比 reactorName（droneShop）可读。 */
function localizedNames() {
  const names = new Map<string, string>();
  const list = props.root.querySelector(`.${C.BuildingRepairAssistantPanel.buildingList}`);
  if (!list) {
    return names;
  }
  for (const item of list.children) {
    const ticker = item.querySelector('[class*="BuildingIcon__ticker"]')?.textContent?.trim();
    const title = item
      .querySelector<HTMLElement>('[class*="BuildingIcon__container"]')
      ?.title?.trim();
    if (ticker && title && !names.has(ticker)) {
      names.set(ticker, title);
    }
  }
  return names;
}

function siteStock() {
  const stock = new Map<string, number>();
  const current = site.value;
  if (!current) {
    return stock;
  }
  for (const store of storagesStore.all.value ?? []) {
    if (store.addressableId !== current.siteId) {
      continue;
    }
    for (const item of store.items) {
      if (item.type !== 'INVENTORY' || !item.quantity) {
        continue;
      }
      const ticker = item.quantity.material?.ticker;
      if (ticker) {
        stock.set(ticker, (stock.get(ticker) ?? 0) + item.quantity.amount);
      }
    }
  }
  return stock;
}

/** 该基地「待维修建筑」（与 BRA 列表同口径）按类型分组 + 材料缺口。 */
function collect() {
  const current = site.value;
  if (!current) {
    return { groups: [], missing: [] };
  }
  const threshold = readThreshold();
  const names = localizedNames();
  const map = new Map<string, TypeGroup>();
  const need = new Map<string, number>();
  for (const platform of current.platforms) {
    if (!isRepairableBuilding(platform)) {
      // 住房、核心模块这些基础设施不参与维修。
      continue;
    }
    if (typeof platform.condition !== 'number' || platform.condition >= threshold) {
      continue;
    }
    const { reactorTicker, reactorName } = platform.module;
    const group = map.get(reactorTicker);
    if (group) {
      group.count++;
    } else {
      map.set(reactorTicker, {
        ticker: reactorTicker,
        name: names.get(reactorTicker) || reactorName,
        count: 1,
      });
    }
    for (const entry of platform.repairMaterials ?? []) {
      const ticker = entry.material.ticker;
      need.set(ticker, (need.get(ticker) ?? 0) + entry.amount);
    }
  }
  const stock = siteStock();
  const missing: { ticker: string; need: number; have: number }[] = [];
  for (const [ticker, amount] of need) {
    const have = stock.get(ticker) ?? 0;
    if (have < amount) {
      missing.push({ ticker, need: amount, have });
    }
  }
  missing.sort((a, b) => b.need - b.have - (a.need - a.have));
  return {
    groups: [...map.values()].sort((a, b) => {
      if (a.count !== b.count) {
        return b.count - a.count;
      }
      const byName = a.name.localeCompare(b.name);
      return byName !== 0 ? byName : a.ticker.localeCompare(b.ticker);
    }),
    missing,
  };
}

const missingText = computed(() => {
  const items = missing.value.slice(0, 4).map(x => `${x.ticker}×${x.need - x.have}`);
  const more = missing.value.length > 4 ? ` 等 ${missing.value.length} 种` : '';
  return items.join('、') + more;
});

function refresh() {
  site.value = resolveSite();
  const result = collect();
  groups.value = result.groups;
  missing.value = result.missing;
}

let refreshTimer: number | undefined;
function scheduleRefresh() {
  clearTimeout(refreshTimer);
  refreshTimer = window.setTimeout(refresh, 200);
}

function isRepairDisabled(button: Element) {
  return button.classList.contains(C.Button.disabled) || /__disabled/i.test(button.className);
}

/** 等隐藏的 BBL 把建筑列表渲染出来。 */
async function waitForRows(win: Element) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (win.querySelector(`.${C.SectionList.section}`)) {
      return;
    }
    await sleep(200);
  }
}

async function repairType(group: TypeGroup) {
  const current = site.value;
  if (!current) {
    return;
  }
  busyTicker.value = group.ticker;
  message.value = undefined;
  const threshold = readThreshold();
  // 目标建筑按 id 先定下来；真正点击时再按 id 重新查 DOM ——
  // 每修完一栋游戏都会重渲染列表，提前拿到的行/按钮引用会失效。
  const targets = current.platforms
    .filter(
      platform =>
        isRepairableBuilding(platform) &&
        platform.module.reactorTicker === group.ticker &&
        typeof platform.condition === 'number' &&
        platform.condition < threshold,
    )
    .map(platform => platform.id);
  const closed = ref(false);
  let clicked = 0;
  try {
    const win = await showBuffer(`BBL ${current.siteId}`, {
      force: true,
      autoClose: true,
      closeWhen: closed,
    });
    await waitForRows(win);
    for (const id of targets) {
      const row = win.querySelector(`.${C.SectionList.section}[data-prun-id="${id}"]`);
      const button = row?.querySelector(`.${C.SectionList.button} > button`);
      if (!button || isRepairDisabled(button)) {
        continue;
      }
      await clickElement(button as HTMLElement);
      clicked++;
      // 逐栋下发，避免同一帧连发 SITE_SECTION_REPAIR。
      await sleep(220);
    }
  } finally {
    // 关掉隐藏的 BBL。
    closed.value = true;
    busyTicker.value = undefined;
  }
  message.value =
    clicked > 0
      ? `已提交 ${clicked} 栋「${group.name}」的维修`
      : `游戏维修按钮不可用：基地仓库缺维修材料（${missingText.value || '材料不足'}）`;
  refresh();
}

function disarm() {
  armedTicker.value = undefined;
  armedSiteId.value = undefined;
  armedTargetSig.value = undefined;
  clearTimeout(armTimer);
}

// 当前基地 + 当前阈值下，该类型待维修建筑的 id 签名（排序后拼接）。
// 用它和二次确认时记录的签名比对：基地或建筑集合变化即视为需要重新确认。
function targetSignature(group: TypeGroup): string | undefined {
  const current = site.value;
  if (!current) {
    return undefined;
  }
  const threshold = readThreshold();
  const ids = current.platforms
    .filter(
      platform =>
        isRepairableBuilding(platform) &&
        platform.module.reactorTicker === group.ticker &&
        typeof platform.condition === 'number' &&
        platform.condition < threshold,
    )
    .map(platform => platform.id)
    .sort();
  return ids.join(',');
}

async function onClick(group: TypeGroup) {
  if (busyTicker.value !== undefined || group.count === 0) {
    return;
  }
  const sig = targetSignature(group);
  // 二次确认只在「同一基地 + 同一建筑集合」下有效；基地或建筑集合变化（如调高阈值）
  // 一律重新武装，避免提交比用户看到的多得多的维修、并消耗材料（PR #60 审查 #221）。
  if (
    armedTicker.value === group.ticker &&
    armedSiteId.value === site.value?.siteId &&
    armedTargetSig.value === sig
  ) {
    disarm();
    await repairType(group);
    return;
  }
  armedTicker.value = group.ticker;
  armedSiteId.value = site.value?.siteId;
  armedTargetSig.value = sig;
  clearTimeout(armTimer);
  armTimer = window.setTimeout(disarm, 5000);
}

let observer: MutationObserver | undefined;
const barRef = ref<HTMLElement>();

onMounted(() => {
  refresh();
  // 建筑列表与本地化建筑名是异步渲染的，挂载后再补几次刷新把名字补上。
  window.setTimeout(refresh, 400);
  window.setTimeout(refresh, 1500);
  observer = new MutationObserver(records => {
    // 工具条自己的增删改会回灌到观察者里，忽略掉，避免自我刷新的循环。
    const bar = barRef.value;
    if (bar && records.every(record => bar.contains(record.target))) {
      return;
    }
    scheduleRefresh();
  });
  // 阈值滑块用 aria-valuenow 表达，所以这里不限制 attributeFilter。
  observer.observe(props.root, { subtree: true, childList: true, attributes: true });
});

watch(
  () => site.value?.platforms,
  () => scheduleRefresh(),
);

watch(
  () => storagesStore.all.value,
  () => scheduleRefresh(),
);

onBeforeUnmount(() => {
  observer?.disconnect();
  clearTimeout(armTimer);
  clearTimeout(refreshTimer);
});
</script>

<template>
  <div ref="barRef" :class="$style.bar" data-rp-ui="bra-repair-by-type">
    <span :class="$style.label">按类型维修</span>
    <template v-if="groups.length > 0">
      <button
        v-for="group in groups"
        :key="group.ticker"
        type="button"
        :class="[
          C.Button.btn,
          armedTicker === group.ticker || busyTicker === group.ticker
            ? C.Button.danger
            : C.Button.dark,
          $style.chip,
        ]"
        :disabled="busyTicker !== undefined"
        :aria-pressed="armedTicker === group.ticker"
        :title="`${group.ticker} · 共 ${group.count} 栋待维修，逐个点击游戏原生「维修」按钮（再点一次确认）`"
        @click="onClick(group)">
        <template v-if="busyTicker === group.ticker">维修中…</template>
        <template v-else-if="armedTicker === group.ticker">
          确认维修 {{ group.count }} 栋
        </template>
        <template v-else>{{ group.ticker }} ×{{ group.count }}</template>
      </button>
      <span v-if="message" :class="$style.hint">{{ message }}</span>
      <span
        v-else-if="missing.length > 0"
        :class="$style.hint"
        :title="`维修材料必须放在基地自己的仓库里。缺口：${missing
          .map(x => `${x.ticker} 需 ${x.need} / 有 ${x.have}`)
          .join('，')}`">
        仓库缺 {{ missingText }}
      </span>
    </template>
    <span v-else :class="$style.hint">{{
      site ? '本基地没有待维修的建筑' : '未识别到基地，无法按类型维修'
    }}</span>
  </div>
</template>

<style module>
.bar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px;
  padding: 2px 4px 4px;
  font-size: 11px;
}

.label {
  margin-right: 2px;
  white-space: nowrap;
}

.chip {
  font-size: 11px;
}

.hint {
  font-size: 11px;
  opacity: 0.7;
}
</style>
