<script setup lang="ts">
import PrunButton from '@src/components/PrunButton.vue';
import SectionHeader from '@src/components/SectionHeader.vue';
import Active from '@src/components/forms/Active.vue';
import Commands from '@src/components/forms/Commands.vue';
import SelectInput from '@src/components/forms/SelectInput.vue';
import { shipsStore } from '@src/infrastructure/prun-api/data/ships';
import { storagesStore } from '@src/infrastructure/prun-api/data/storage';
import { materialsStore } from '@src/infrastructure/prun-api/data/materials';
import { atSameLocation, serializeStorage, storageSort } from '@src/features/XIT/ACT/actions/utils';
import { showBuffer } from '@src/infrastructure/prun-ui/buffers';
import { changeInputValue, clickElement, focusElement } from '@src/util';
import { sleep } from '@src/utils/sleep';

const { onDone, registration, silent } = defineProps<{
  onDone?: () => void;
  registration?: string;
  silent?: boolean;
  tile: PrunTile;
}>();

interface TransferPlan {
  ticker: 'SF' | 'FF';
  label: string;
  amount: number;
  needed: number;
  from: PrunApi.Store;
  to: PrunApi.Store;
}

interface TransferBuffer {
  tile: HTMLElement;
  frame: HTMLElement;
  anchor: HTMLElement;
}

interface PreparedTransfer {
  buffer: TransferBuffer;
  plan: TransferPlan;
  transferButton: HTMLElement;
}

const MTRA_TIMEOUT = 1700;
const MTRA_COMMAND_RETRIES = 3;
const MTRA_RETRY_DELAY = 150;
const MTRA_TIMEOUT_ERROR = 'MTRA_TIMEOUT';
const MTRA_NO_SUGGESTIONS_ERROR = 'MTRA_NO_SUGGESTIONS';
const MTRA_SWITCH_TIMEOUT_ERROR = 'MTRA_SWITCH_TIMEOUT';

const ship = computed(() => shipsStore.getByRegistration(registration));
const shipStore = computed(() => {
  if (!ship.value) {
    return undefined;
  }
  return storagesStore.getById(ship.value.idShipStore);
});
const stlStore = computed(() => {
  const id = ship.value?.stlFuelStoreId ?? ship.value?.idStlFuelStore;
  return id ? storagesStore.getById(id) : undefined;
});
const ftlStore = computed(() => {
  const id = ship.value?.ftlFuelStoreId ?? ship.value?.idFtlFuelStore;
  return id ? storagesStore.getById(id) : undefined;
});

const sfMaterial = computed(() => materialsStore.getByTicker('SF'));
const ffMaterial = computed(() => materialsStore.getByTicker('FF'));

function calcRefuelAmount(
  store: PrunApi.Store | undefined,
  material: PrunApi.Material | undefined,
) {
  if (!store || !material) {
    return 0;
  }
  const freeVolume = store.volumeCapacity - store.volumeLoad;
  return Math.max(0, Math.round(freeVolume / material.volume));
}

const sfNeeded = computed(() => calcRefuelAmount(stlStore.value, sfMaterial.value));
const ffNeeded = computed(() => calcRefuelAmount(ftlStore.value, ffMaterial.value));

const originStores = computed(() => {
  const currentStore = shipStore.value ?? stlStore.value ?? ftlStore.value;
  const stores = storagesStore.nonFuelStores.value ?? [];
  if (!currentStore) {
    return [];
  }
  return stores
    .filter(
      store =>
        (store.type === 'STORE' || store.type === 'WAREHOUSE_STORE') &&
        atSameLocation(store, currentStore),
    )
    .sort(storageSort);
});

const origin = ref<string | undefined>(undefined);

watchEffect(() => {
  const stores = originStores.value;
  const originVal = origin.value;
  if (!stores.some(store => serializeStorage(store) === originVal)) {
    const firstStore = stores[0];
    origin.value = firstStore !== undefined ? serializeStorage(firstStore) : undefined;
  }
});

const originOptions = computed(() =>
  originStores.value.map(store => ({
    label: serializeStorage(store),
    value: serializeStorage(store),
  })),
);

const selectedOrigin = computed(() =>
  originStores.value.find(store => serializeStorage(store) === origin.value),
);

function getAvailableAmount(store: PrunApi.Store | undefined, ticker: string) {
  return store?.items.find(x => x.quantity?.material.ticker === ticker)?.quantity?.amount ?? 0;
}

const sfAvailable = computed(() => getAvailableAmount(selectedOrigin.value, 'SF'));
const ffAvailable = computed(() => getAvailableAmount(selectedOrigin.value, 'FF'));
const needsAnyFuel = computed(() => sfNeeded.value > 0 || ffNeeded.value > 0);
const hasTransferableFuel = computed(
  () =>
    (sfNeeded.value > 0 && sfAvailable.value > 0) || (ffNeeded.value > 0 && ffAvailable.value > 0),
);
const isFlying = computed(() => !!ship.value?.flightId);
const canRefuel = computed(
  () =>
    !!ship.value &&
    selectedOrigin.value !== undefined &&
    !isFlying.value &&
    needsAnyFuel.value &&
    hasTransferableFuel.value,
);

const executionStatus = ref('');
const isExecuting = ref(false);
const logMessages = ref<string[]>([]);
const hasError = ref(false);
let autoStarted = false;

function appendLog(message: string) {
  logMessages.value.push(message);
}

function finishSilentRun() {
  if (silent) {
    onDone?.();
  }
}

function buildTransferPlans(originStore: PrunApi.Store) {
  const plans: TransferPlan[] = [];
  if (sfNeeded.value > 0 && stlStore.value) {
    plans.push({
      ticker: 'SF',
      label: '低光速燃料',
      needed: sfNeeded.value,
      amount: Math.min(sfNeeded.value, getAvailableAmount(originStore, 'SF')),
      from: originStore,
      to: stlStore.value,
    });
  }
  if (ffNeeded.value > 0 && ftlStore.value) {
    plans.push({
      ticker: 'FF',
      label: '超光速燃料',
      needed: ffNeeded.value,
      amount: Math.min(ffNeeded.value, getAvailableAmount(originStore, 'FF')),
      from: originStore,
      to: ftlStore.value,
    });
  }
  return plans.filter(plan => plan.amount > 0);
}

function getMtraCommand(plan: TransferPlan) {
  return `MTRA from-${plan.from.id.substring(0, 8)} to-${plan.to.id.substring(0, 8)}`;
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('打开转移界面超时。')), ms);
    promise.then(
      value => {
        clearTimeout(timer);
        resolve(value);
      },
      error => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

async function readTransferBuffer(tileElement: HTMLElement): Promise<TransferBuffer> {
  const frame = (await $(tileElement, C.TileFrame.frame)) as HTMLElement;
  const anchor = (await $(tileElement, C.TileFrame.anchor)) as HTMLElement;
  return { tile: tileElement, frame, anchor };
}

async function openTransferBuffer(command: string, closeWhen: Ref<boolean>) {
  const window = await showBuffer(command, {
    force: true,
    autoSubmit: true,
    autoClose: true,
    closeWhen,
  });
  if (window === undefined) {
    throw new Error(`无法打开 ${command}`);
  }
  const tileElement = (await $(window, C.Tile.tile)) as HTMLElement;
  await waitForTransferCommand(tileElement, command);
  return await readTransferBuffer(tileElement);
}

async function waitForTransferCommand(tileElement: HTMLElement, command: string) {
  for (let attempt = 0; attempt < 30; attempt++) {
    const currentCommand = _$(tileElement, C.TileFrame.cmd)?.textContent?.trim();
    if (currentCommand?.toUpperCase() === command.toUpperCase()) {
      await sleep(125);
      return;
    }
    await sleep(50);
  }
  throw new Error(MTRA_SWITCH_TIMEOUT_ERROR);
}

async function setupMtraBuffer(anchor: HTMLElement, ticker: string) {
  await clickElement(anchor);
  window.getSelection()?.removeAllRanges();

  const container = await withTimeout($(anchor, C.MaterialSelector.container), MTRA_TIMEOUT);
  const input = (await withTimeout($(container, 'input'), MTRA_TIMEOUT)) as HTMLInputElement;
  const suggestionsContainer = await withTimeout(
    $(container, C.MaterialSelector.suggestionsContainer),
    MTRA_TIMEOUT,
  );

  let suggestionsList: Element | undefined;
  for (let attempt = 0; attempt < 15; attempt++) {
    await clickElement(input);
    focusElement(input);
    input.focus();
    changeInputValue(input, ticker);
    window.getSelection()?.removeAllRanges();
    await sleep(150);
    suggestionsList = _$(container, C.MaterialSelector.suggestionsList);
    if (suggestionsList) {
      break;
    }
  }

  if (!suggestionsList) {
    throw new Error(`无法加载 ${ticker} 的可选材料。`);
  }

  return { suggestionsContainer, suggestionsList };
}

async function setupTransferWithRetry(buffer: TransferBuffer, ticker: TransferPlan['ticker']) {
  let lastError: unknown;
  for (let retry = 0; retry < MTRA_COMMAND_RETRIES; retry++) {
    try {
      return await setupMtraBuffer(buffer.anchor, ticker);
    } catch (error: unknown) {
      lastError = error;
      if (retry === MTRA_COMMAND_RETRIES - 1) {
        throw error;
      }
      appendLog(`${ticker} buffer setup retry ${retry + 1}/${MTRA_COMMAND_RETRIES}`);
      await sleep(MTRA_RETRY_DELAY);
    }
  }

  const message = lastError instanceof Error ? lastError.message : MTRA_TIMEOUT_ERROR;
  throw new Error(message || MTRA_NO_SUGGESTIONS_ERROR);
}

async function waitActionProgress(overlay: HTMLElement) {
  if (!overlay.classList.contains(C.ActionFeedback.progress)) {
    return;
  }
  await new Promise<void>(resolve => {
    const observer = new MutationObserver(() => {
      if (!overlay.classList.contains(C.ActionFeedback.progress)) {
        observer.disconnect();
        resolve();
      }
    });
    observer.observe(overlay, { attributes: true });
  });
}

async function waitTransferFeedback(frame: HTMLElement) {
  const overlay = (await $(frame, C.ActionFeedback.overlay)) as HTMLElement;
  await waitActionProgress(overlay);

  if (overlay.classList.contains(C.ActionConfirmationOverlay.container)) {
    const confirm = _$$(overlay, C.Button.btn)[1] as HTMLElement | undefined;
    if (!confirm) {
      throw new Error('确认转移时缺少确认按钮。');
    }
    await clickElement(confirm);
    await waitActionProgress(overlay);
  }

  if (overlay.classList.contains(C.ActionFeedback.success)) {
    await clickElement(overlay);
    return;
  }

  if (overlay.classList.contains(C.ActionFeedback.error)) {
    const message = _$(overlay, C.ActionFeedback.message)?.textContent?.trim();
    const dismiss = _$(overlay, C.ActionFeedback.dismiss)?.textContent?.trim();
    throw new Error(
      dismiss ? message?.replace(dismiss, '').trim() || '转移失败。' : message || '转移失败。',
    );
  }

  throw new Error('收到未知的转移反馈。');
}

async function prepareTransfer(
  buffer: TransferBuffer,
  plan: TransferPlan,
): Promise<PreparedTransfer> {
  const { suggestionsContainer, suggestionsList } = await setupTransferWithRetry(
    buffer,
    plan.ticker,
  );

  suggestionsContainer.style.display = 'none';
  const match = _$$(suggestionsList, C.MaterialSelector.suggestionEntry).find(
    entry => _$(entry, C.ColoredIcon.label)?.textContent === plan.ticker,
  );
  if (!match) {
    suggestionsContainer.style.display = '';
    throw new Error(`在材料选择器中找不到 ${plan.ticker}。`);
  }

  await clickElement(match as HTMLElement);
  suggestionsContainer.style.display = '';

  const sliderNumbers = _$$(buffer.anchor, 'rc-slider-mark-text').map(x =>
    Number(x.textContent ?? 0),
  );
  const maxAmount = Math.max(...sliderNumbers);
  if (!Number.isFinite(maxAmount) || maxAmount <= 0) {
    throw new Error(`${plan.ticker} 当前无法转移。`);
  }

  const amount = Math.min(plan.amount, maxAmount);
  if (amount < plan.needed) {
    appendLog(`${plan.ticker} 仅可转移 ${amount}/${plan.needed}`);
  }

  const allInputs = _$$(buffer.anchor, 'input');
  const amountInput = allInputs[1] as HTMLInputElement | undefined;
  if (!amountInput) {
    throw new Error('找不到转移数量输入框。');
  }

  changeInputValue(amountInput, amount.toString());
  window.getSelection()?.removeAllRanges();

  const transferButton = (await $(buffer.anchor, C.Button.btn)) as HTMLElement;
  return { buffer, plan, transferButton };
}

async function submitPreparedTransfer(prepared: PreparedTransfer) {
  await clickElement(prepared.transferButton);
  await waitTransferFeedback(prepared.buffer.frame);
}

async function prepareTransferPlan(plan: TransferPlan, closeWhen: Ref<boolean>) {
  const buffer = await openTransferBuffer(getMtraCommand(plan), closeWhen);
  return await prepareTransfer(buffer, plan);
}

async function runRefuel() {
  if (!selectedOrigin.value || isExecuting.value) {
    return;
  }
  const plans = buildTransferPlans(selectedOrigin.value);
  if (plans.length === 0) {
    executionStatus.value = needsAnyFuel.value
      ? '无法加油（来源库存不足）。'
      : '油箱已满，无需加油。';
    return;
  }

  logMessages.value = [];
  hasError.value = false;
  isExecuting.value = true;
  executionStatus.value = '正在执行加油...';
  const closeWhen = ref(false);
  let nextPreparedTransfer: Promise<PreparedTransfer> | undefined;

  try {
    for (const plan of plans) {
      if (plan.amount < plan.needed) {
        appendLog(`${plan.label} 库存不足，将尝试部分转移。`);
      }
    }

    nextPreparedTransfer = prepareTransferPlan(plans[0], closeWhen);
    for (let i = 0; i < plans.length; i++) {
      const preparedTransfer = await nextPreparedTransfer;
      const plan = preparedTransfer.plan;

      if (i < plans.length - 1) {
        nextPreparedTransfer = prepareTransferPlan(plans[i + 1], closeWhen);
      }
      executionStatus.value =
        plans.length === 1
          ? `正在加注${plan.label}...`
          : `正在加注${plan.label} (${i + 1}/${plans.length})...`;
      appendLog(`开始转移 ${plan.ticker} ${plan.amount}`);

      await submitPreparedTransfer(preparedTransfer);
      appendLog(`${plan.ticker} 转移完成`);
      await sleep(50);
    }

    executionStatus.value = '加油完成！';
  } catch (error: unknown) {
    void nextPreparedTransfer?.catch(() => undefined);
    hasError.value = true;
    const message = error instanceof Error ? error.message : '加油失败。';
    executionStatus.value = message;
    appendLog(message);
  } finally {
    closeWhen.value = true;
    isExecuting.value = false;
    finishSilentRun();
  }
}

onMounted(() => {
  if (!ship.value) {
    executionStatus.value = '未找到飞船数据。';
    return;
  }
  if (isFlying.value) {
    executionStatus.value = '飞船正在飞行中，无法加油。';
    return;
  }
  if (!needsAnyFuel.value) {
    executionStatus.value = '油箱已满，无需加油。';
    return;
  }
  if (!selectedOrigin.value) {
    executionStatus.value = '附近没有可用的燃料来源。';
    return;
  }
  if (!hasTransferableFuel.value) {
    executionStatus.value = '无法加油（来源库存不足）。';
    return;
  }
  autoStarted = true;
  runRefuel();
});

onMounted(() => {
  if (!silent) {
    return;
  }
  queueMicrotask(() => {
    if (!isExecuting.value) {
      finishSilentRun();
    }
  });
});

watch(origin, () => {
  if (autoStarted) {
    executionStatus.value = '';
  }
});
</script>

<template>
  <div v-if="!silent" :class="C.DraftConditionEditor.form">
    <SectionHeader>一键加油</SectionHeader>
    <form>
      <Active label="飞船">
        <span>{{ ship?.registration ?? registration ?? '--' }}</span>
      </Active>
      <Active label="来源">
        <SelectInput v-model="origin" :options="originOptions" />
      </Active>
      <Active label="SF">
        <span>{{ sfAvailable }}/{{ sfNeeded }}</span>
      </Active>
      <Active label="FF">
        <span>{{ ffAvailable }}/{{ ffNeeded }}</span>
      </Active>
      <Active v-if="executionStatus" label="状态">
        <span>{{ executionStatus }}</span>
      </Active>
      <div v-if="logMessages.length > 0" :class="$style.logBox">
        <div v-for="(message, index) in logMessages" :key="index">{{ message }}</div>
      </div>
      <Commands>
        <PrunButton primary :disabled="!canRefuel || isExecuting" @click="runRefuel"
          >执行加油</PrunButton
        >
      </Commands>
    </form>
  </div>
</template>

<style module>
.logBox {
  margin: 6px 4px 0;
  padding: 6px;
  max-height: 120px;
  overflow-y: auto;
  background: #1f2629;
  border: 1px solid #2b485a;
  line-height: 1.35;
  white-space: pre-wrap;
}
</style>
