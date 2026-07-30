<script setup lang="ts">
// 换汇页：选定 (源货币 -> 目标货币) 与金额，按钮触发两笔 CMK 合同的顺序创建：
//   1. BUY  CMK @ HRT, currency = 源货币
//   2. SELL CMK @ HRT, currency = 目标货币
// 复用 CONTGEN/new-and-fill 的 newContractDraftAndFill：把 JSON 写到
// 'contgen-output' workspace key，让 contd-auto-fill 在新打开的 CONTD 面板里
// 自动填表并保存。这样走的是与 CONTGEN 完全相同的稳定路径。

import { computed, ref } from 'vue';
import Active from '@src/components/forms/Active.vue';
import Commands from '@src/components/forms/Commands.vue';
import SelectInput from '@src/components/forms/SelectInput.vue';
import NumberInput from '@src/components/forms/NumberInput.vue';
import PrunButton from '@src/components/PrunButton.vue';
import Header from '@src/components/Header.vue';
import { useTileState } from '@src/store/user-data-tiles';
import { newContractDraftAndFill } from '@src/features/XIT/CONTGEN/new-and-fill';
import tiles from '@src/infrastructure/prun-ui/tiles';
import { showBuffer } from '@src/infrastructure/prun-ui/buffers';
import {
  closePrunWindow,
  closeTileWindow,
} from '@src/infrastructure/prun-ui/utils/close-prun-window';
import { sleep } from '@src/utils/sleep';

// 关闭当前所有 CONTD 面板并 force 新开一块干净的 list 面板。
//
// 上一笔 helper 内部把面板切到了 "CONTD CD-XXXX-NNN" 详细视图。该面板
// 既不能直接复用——它的 fullCommand 已带参数，tiles.find('CONTD') 严格匹配
// 不到；也不能用 UI_TILES_CHANGE_COMMAND 切回—activeTiles 里的 fullCommand
// 永远是 activateFrame 时记下的旧值，不会随 command 切换刷新。
//
// 最稳的修法：先 closeTileWindow 全部 CONTD，等 activeTiles reconcile 把
// 它们摘掉，再 showBuffer('CONTD', { force: true }) 新开一块。force 选项
// 会跳过"已有就 focus"的分支走 processWindow 新建路径，新 tile 的
// fullCommand 必然是 'CONTD'。
//
// 这样两笔合同能**并行**走完—每笔都拿到一块独立的 list 面板→点"新建"→
// 等 naturalId→切 detail→填表保存。两块 CONTD 详情面板并排，玩家能同时
// 看到两笔 BUY/SELL 长什么样（这正是"打开两个合同同时填写"的诉求）。
// 关闭所有 CONTD 面板并新开一块干净的 list。
//
// helper 跑完后可能把面板切到 detail 视图。该 tile 在 activeTiles 里
// 是否仍被追踪不确定——但任何情况下，玩家看到的 CONTD 窗口都必须先
// 关闭，不然 showBuffer('CONTD', force: true) 想开新面板时会被 activeTiles
// 视为"复用已存在的"，不会真正新开。
//
// 解决：直接遍历 DOM，把所有 .window 里 header 含 "CONTD" 的都点 x 关
// 掉。DOM 层操作是 user-visible 的最后一层，detail 视图面板一定涵盖。
async function reopenContdListView(): Promise<void> {
  for (const tile of tiles.find('CONTD').filter(t => !t.docked)) {
    closeTileWindow(tile);
  }
  // 关 list 之后，detail 视图（activeTiles 里 fullCommand 已带参数，
  // tiles.find('CONTD') 严格匹配不到）依然会"漏关"。DOM 兜底：
  for (const win of _$$(document, `.${C.Window.window}`)) {
    // TileFrame.cmd 是面板顶角的命令标识（"CONTD" 或 "CONTD CD-XYZ"）。
    if (_$(win, C.TileFrame.cmd)?.textContent?.trim().startsWith('CONTD') ?? false) {
      closePrunWindow(win);
    }
  }
  await sleep(300);
  await showBuffer('CONTD', { force: true });
  await sleep(500);
}

// PrUn 4 种货币：ICA / NCC / AIC / CIS。两侧应严格不同（同一币种互换无意义）。
// 注：用可变数组（不是 `as const` 元组）——SelectInput 的 props 类型是
// `options: Option[]`，传 readonly 数组 / 元组会被 TS 拒，详见 .vue 报错。
const CURRENCIES: Currency[] = ['ICA', 'NCC', 'AIC', 'CIS'];
type Currency = 'ICA' | 'NCC' | 'AIC' | 'CIS';

// 固定的换汇中间商品 + 固定的换汇地点；玩家不能改。
const COMMODITY = 'RAT';
const LOCATION = 'HRT';

// 表单状态。源默认 ICA、目标默认 AIC —— 与 ORG 表单的常见方向一致。
const fromCurrency = useTileState<Currency>('fromCurrency', 'ICA');
const toCurrency = useTileState<Currency>('toCurrency', 'AIC');
const amount = useTileState<number | undefined>('amount', undefined);

// 玩家在 FX 页填的"金额"语义是"换汇单价"：1 件 CMK 的 BUY/SELL 价格。
// 商品数量固定 1，避免单价×数量算出来的总数让玩家困惑。currency 决定
// 是 BUY CMK（用源币付）还是 SELL CMK（换成目标币收）。合同名预设
// "BUY{价格}{源币}" / "SELL{价格}{目标币}"，去掉 .0 / 末尾小数。
function buildSwapJson(template: 'BUY' | 'SELL', currency: Currency): string {
  const unitPrice = amount.value ?? 0;
  // 价格取整数：与玩家输入的"1,000,000"格式一致，避免出现小数尾巴。
  const priceText = String(Math.round(unitPrice));
  const name = `${template}${priceText}${currency}`;
  return JSON.stringify(
    {
      template,
      currency,
      location: LOCATION,
      name,
      items: [{ commodity: COMMODITY, amount: 1, price: unitPrice }],
    },
    null,
    2,
  );
}

// 按钮态机：idle → 创建第一笔 → 创建第二笔 → 完成（或中途失败）。
type Phase = 'idle' | 'first' | 'second' | 'done';
const phase = ref<Phase>('idle');
const error = ref<string | null>(null);
const isWorking = computed(() => phase.value === 'first' || phase.value === 'second');

const canSubmit = computed(() => {
  if (isWorking.value) {
    return false;
  }
  if (fromCurrency.value === toCurrency.value) {
    return false;
  }
  const amt = amount.value;
  return typeof amt === 'number' && Number.isFinite(amt) && amt > 0;
});

const buttonLabel = computed(() => {
  switch (phase.value) {
    case 'first':
      return `创建 BUY ${COMMODITY}…`;
    case 'second':
      return `创建 SELL ${COMMODITY}…`;
    case 'done':
      return '✓ 完成';
    default:
      return '换汇';
  }
});

// 同时禁止：源=目标 / 金额非正 / 工作中。
const validationMessages = computed<string[]>(() => {
  const errs: string[] = [];
  if (fromCurrency.value === toCurrency.value) {
    errs.push('源货币与目标货币必须不同');
  }
  const amt = amount.value;
  if (typeof amt !== 'number' || !Number.isFinite(amt) || amt <= 0) {
    errs.push('金额必须为正数');
  }
  return errs;
});

async function handleSwap() {
  if (!canSubmit.value) {
    return;
  }
  error.value = null;
  // 走两轮独立的"重建 list 面板 → 创建填表"流程：
  //   1. 关闭所有 CONTD 面板 → 新开一块 list → 走 helper（BUY RAT）
  //   2. 关掉第一笔的 detail 面板 → 再开一块 list → 再走 helper（SELL RAT）
  //
  // 为何这么干——之前反复折戟的两个根因：
  //   (a) helper 内部把 list 切到 detail 后，UI 显示已"填好保存"但 activeTiles
  //       里这块 tile 的 fullCommand 已经带 "CD-XXX" 参数。下一轮 helper 内
  //       部 showBuffer('CONTD') 不带 force 会 focus 它，等不到新建 naturalId
  //       必然超时——所以"第二笔失败：naturalId 超时"。
  //   (b) 上一版尝试保留两块 CONTD 面板（BUY detail 与 list 共存），但 helper
  //       最后一步 dispatch UI_TILES_CHANGE_COMMAND 时会把 list 切走，叠加上
  //       activeTiles 的状态残留，列表里只有一块能跑通——所以"只创建了一笔"。
  //
  // 干净的解决方案：每笔合同前都把当前所有 CONTD 关掉再 force 新开一块 list。
  // 等于每次都是"第一次"——helper 看到全 activeTiles 里只有一块干净的 list，
  // 自然能完整跑完。
  await reopenContdListView();
  phase.value = 'first';
  try {
    await newContractDraftAndFill(buildSwapJson('BUY', fromCurrency.value));
  } catch (e) {
    phase.value = 'idle';
    error.value = `第一笔合同创建失败：${e instanceof Error ? e.message : String(e)}`;
    return;
  }
  // 关掉第一笔的 detail 面板，重新走一遍完整流程建第二笔。关闭 + force 重
  // 开的两个 sleep(200) 给了 activeTiles reconcile 的时间。
  await reopenContdListView();
  phase.value = 'second';
  try {
    await newContractDraftAndFill(buildSwapJson('SELL', toCurrency.value));
  } catch (e) {
    phase.value = 'idle';
    error.value = `第二笔合同创建失败：${e instanceof Error ? e.message : String(e)}`;
    return;
  }
  phase.value = 'done';
  setTimeout(() => {
    if (phase.value === 'done') {
      phase.value = 'idle';
    }
  }, 2000);
}
</script>

<template>
  <div :class="$style.root">
    <div :class="$style.titleRow">
      <Header>换汇</Header>
      <span :class="$style.hint">商品 {{ COMMODITY }} · 地点 {{ LOCATION }}</span>
    </div>

    <div :class="$style.form">
      <Active label="源货币">
        <SelectInput v-model="fromCurrency" :options="CURRENCIES" />
      </Active>

      <div :class="$style.arrow">➡</div>

      <Active label="目标货币">
        <SelectInput v-model="toCurrency" :options="CURRENCIES" />
      </Active>

      <Active label="换汇单价" :tooltip="`1 件 ${COMMODITY} 的 BUY / SELL 单价。商品数量固定 1。`">
        <NumberInput v-model="amount" :min="1" :class="$style.amountInput" />
      </Active>

      <div v-if="validationMessages.length > 0" :class="$style.errors">
        <div v-for="msg in validationMessages" :key="msg">⚠ {{ msg }}</div>
      </div>
      <div v-else-if="error" :class="$style.errors">
        <div>⚠ {{ error }}</div>
      </div>
    </div>

    <Commands label="操作">
      <PrunButton :disabled="!canSubmit" primary @click="handleSwap">
        {{ buttonLabel }}
      </PrunButton>
    </Commands>
  </div>
</template>

<style module>
.root {
  display: flex;
  flex-direction: column;
  height: 100%;
  padding: 8px 12px 12px;
  box-sizing: border-box;
  gap: 8px;
}

.titleRow {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.hint {
  font-size: 11px;
  color: rgb(148, 158, 166);
  font-variant-numeric: tabular-nums;
}

.form {
  display: flex;
  flex-direction: column;
  gap: 4px;
  flex: 1;
  min-height: 0;
}

.arrow {
  text-align: center;
  font-size: 18px;
  color: rgb(148, 158, 166);
  margin: -2px 0;
}

.amountInput {
  max-width: 160px;
}

.errors {
  padding: 6px 8px;
  background: rgba(217, 83, 79, 0.15);
  border: 1px solid rgba(217, 83, 79, 0.5);
  border-radius: 2px;
  font-size: 11px;
  color: rgb(229, 115, 115);
}
</style>
