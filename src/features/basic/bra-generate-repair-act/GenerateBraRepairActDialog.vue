<script setup lang="ts">
import PrunButton from '@src/components/PrunButton.vue';
import SectionHeader from '@src/components/SectionHeader.vue';
import Active from '@src/components/forms/Active.vue';
import RadioItem from '@src/components/forms/RadioItem.vue';
import ExchangeSelector from '@src/components/forms/ExchangeSelector.vue';
import SelectInput from '@src/components/forms/SelectInput.vue';
import Commands from '@src/components/forms/Commands.vue';
import { sitesStore } from '@src/infrastructure/prun-api/data/sites';
import { storagesStore } from '@src/infrastructure/prun-api/data/storage';
import { userData } from '@src/store/user-data';
import { configurableValue } from '@src/features/XIT/ACT/shared-types';
import { showBuffer } from '@src/infrastructure/prun-ui/buffers';
import { persistedRef } from '@src/utils/persisted-ref';
import { getWarehouseName } from '@src/features/XIT/CART/cart-utils';
import {
  deductNeeds,
  getBaseStoreInventory,
  getExchangeWarehouseInventory,
} from '@src/features/XIT/CART/cbuy-inventory';

const { planetNaturalId, presetBill } = defineProps<{
  planetNaturalId?: string;
  // REPD 预设账单：XIT REPD 已按「勾选的建筑类型 + 抵达偏移」算好的完整维修
  // 材料（未扣任何库存）。传了这个参数就完全接管材料来源，不再读 BRA 的
  // repairMaterials / 时间偏移，也不再受下面两个持久化开关影响，
  // 从而保证与「比价 → XIT CBUY → 生成 ACT」给出完全相同的数量。
  presetBill?: { ticker: string; amount: number }[];
}>();

const presetMode = presetBill !== undefined;

// 浮层里能返回上一页（撤销覆盖），否则只能生成或退出整个磁贴。
const emit = defineEmits<{ close: [] }>();

const site = computed(() => sitesStore.getByPlanetNaturalId(planetNaturalId));

const exchangeStationMap: Record<string, string> = {
  AI1: 'Antares Station',
  CI1: 'Benten Station',
  IC1: 'Hortus Station',
  NC1: 'Moria Station',
  CI2: 'Arclight Station',
  NC2: 'Hubur Station',
};

const exchanges = Object.keys(exchangeStationMap);
const exchange = persistedRef('genact-bra-exchange', exchanges[0]);
const useBaseInv = persistedRef('genact-bra-use-inv', true);
const timeOffset = persistedRef<'now' | '24' | '48'>('genact-bra-time-offset', 'now');
const openSfc = persistedRef('genact-bra-sfc', false);
const repairExec = persistedRef('genact-bra-exec', true);

// 仓库名统一从游戏推送的站点数据推导，与 MTRA 的 origin 完全一致
// （原先用交易所 -> 站点名的硬编码表，遇到表里没有的交易所会拼出 undefined Warehouse）。
const warehouseName = computed(() => getWarehouseName(exchange.value));
const packageName = 'JIANZHUWEIXIU';

const repairMaterialsKey = computed<'repairMaterials' | 'repairMaterials24' | 'repairMaterials48'>(
  () =>
    timeOffset.value === '24'
      ? 'repairMaterials24'
      : timeOffset.value === '48'
        ? 'repairMaterials48'
        : 'repairMaterials',
);

function onGenerateClick() {
  const currentSite = site.value;
  if (!currentSite) {
    return;
  }

  if (presetMode) {
    generateFromPreset(currentSite.siteId);
    return;
  }

  const baseInventory: Record<string, number> = {};
  if (useBaseInv.value) {
    const baseStore = storagesStore.all.value?.find(
      x => x.addressableId === currentSite.siteId && x.type === 'STORE',
    );
    if (baseStore) {
      for (const item of baseStore.items) {
        if (item.quantity) {
          baseInventory[item.quantity.material.ticker] = item.quantity.amount;
        }
      }
    }
  }

  const materials: Record<string, number> = {};
  for (const platform of currentSite.platforms) {
    const repairMaterials = platform[repairMaterialsKey.value] ?? [];
    for (const { material, amount } of repairMaterials) {
      materials[material.ticker] = (materials[material.ticker] ?? 0) + amount;
    }
  }

  if (useBaseInv.value) {
    for (const ticker of Object.keys(materials)) {
      const inBase = baseInventory[ticker] ?? 0;
      const need = Math.max(0, materials[ticker] - inBase);
      if (need > 0) {
        materials[ticker] = need;
      } else {
        delete materials[ticker];
      }
    }
  }

  const groupName = 'Repair';
  const name = packageName;

  const pkg: UserData.ActionPackageData = {
    global: { name },
    groups: [
      {
        type: 'Manual',
        name: groupName,
        materials,
      },
    ],
    actions: [
      {
        type: 'CX Buy',
        name: 'CX Buy',
        group: groupName,
        exchange: exchange.value,
        buyPartial: false,
        allowUnfilled: false,
        useCXInv: true,
      },
      {
        type: 'MTRA',
        name: 'Transfer to Base',
        group: groupName,
        origin: warehouseName.value,
        dest: configurableValue,
      },
      ...(repairExec.value
        ? [
            {
              type: 'BRA Repair' as const,
              name: 'Repair',
              base: planetNaturalId ?? '',
              threshold: userData.settings.repair.threshold,
            },
          ]
        : []),
      ...(openSfc.value
        ? [
            {
              type: 'OPEN SFC' as const,
              name: 'Open Flight Controls',
              destination: planetNaturalId ?? '',
              shipSourceAction: 'Transfer to Base',
            },
          ]
        : []),
    ],
  };

  const existing = userData.actionPackages.find(x => x.global.name === name);
  if (existing) {
    const index = userData.actionPackages.indexOf(existing);
    userData.actionPackages[index] = pkg;
  } else {
    userData.actionPackages.push(pkg);
  }

  showBuffer(`XIT ACT_${name}`);
}

// XIT REPD 入口：材料完全来自 REPD 的账单（按勾选类型 + 抵达偏移算好，未扣库存），
// 抵扣口径与「比价 → XIT CBUY」逐位一致：
//   1. 先扣被维修基地 STORE —— 原地消耗，既不用买也不用运；
//   2. 再扣所选交易所仓库 —— 不用买，但要随采购一起运到基地。
// 因为采购量已预先扣过交易所仓库，CX Buy 必须关掉 useCXInv，否则 ACT 执行时
// 会二次扣减（这是之前 CBUY 与 FLEET 预览数量对不上的同源问题）。
// 包名与 CBUY 生成的 `REPD <编码> Buy` 分开，不互相覆盖。
function generateFromPreset(siteId: string) {
  // 单一交易所场景：所有物料都从所选交易所仓库抵扣并就地买 / 转，与 XIT CBUY 单市场
  // 模式同一口径（PR #60 审查 #220 的 deductNeeds 新签名）。
  const exchangeCode = exchange.value;
  const deductions = deductNeeds(
    (presetBill ?? []).map(x => ({ ticker: x.ticker, name: x.ticker, amount: x.amount })),
    getBaseStoreInventory(siteId),
    { [exchangeCode]: getExchangeWarehouseInventory(exchangeCode) },
    () => exchangeCode,
  );

  const buy: Record<string, number> = {};
  const transfer: Record<string, number> = {};
  for (const d of deductions) {
    if (d.transfer <= 0) {
      continue;
    }
    transfer[d.ticker] = d.transfer;
    if (d.net > 0) {
      buy[d.ticker] = d.net;
    }
  }

  const buyGroup = 'Repair';
  const transferGroup = 'Repair_TRANSFER';
  const groups: UserData.MaterialGroupData[] = [];
  const actions: UserData.ActionData[] = [];

  if (Object.keys(buy).length > 0) {
    groups.push({ type: 'Manual', name: buyGroup, materials: buy });
    actions.push({
      type: 'CX Buy',
      name: 'CX Buy',
      group: buyGroup,
      exchange: exchange.value,
      buyPartial: false,
      allowUnfilled: false,
      useCXInv: false,
    });
  }
  if (Object.keys(transfer).length > 0) {
    groups.push({ type: 'Manual', name: transferGroup, materials: transfer });
    actions.push({
      type: 'MTRA',
      name: 'Transfer to Base',
      group: transferGroup,
      origin: getWarehouseName(exchange.value),
      dest: configurableValue,
    });
  }
  if (repairExec.value) {
    actions.push({
      type: 'BRA Repair',
      name: 'Repair',
      base: planetNaturalId ?? '',
      threshold: userData.settings.repair.threshold,
    });
  }
  if (openSfc.value) {
    actions.push({
      type: 'OPEN SFC',
      name: 'Open Flight Controls',
      destination: planetNaturalId ?? '',
      shipSourceAction: 'Transfer to Base',
    });
  }

  const name = `REPD_${planetNaturalId ?? 'Base'}_Repair`;
  const pkg: UserData.ActionPackageData = { global: { name }, groups, actions };
  const existing = userData.actionPackages.findIndex(x => x.global.name === name);
  if (existing >= 0) {
    userData.actionPackages[existing] = pkg;
  } else {
    userData.actionPackages.push(pkg);
  }

  showBuffer(`XIT ACT_${name}`);
}
</script>

<template>
  <div v-if="!site" :class="C.DraftConditionEditor.form">
    <SectionHeader>生成维修 ACT 包</SectionHeader>
    <div :class="$style.notice">未找到星球基地数据。</div>
    <Commands>
      <PrunButton dark @click="emit('close')">返回</PrunButton>
    </Commands>
  </div>
  <div v-else :class="C.DraftConditionEditor.form">
    <SectionHeader>生成维修 ACT 包</SectionHeader>
    <form>
      <Active label="星球">
        <span>{{ planetNaturalId }}</span>
      </Active>

      <Active label="交易所">
        <ExchangeSelector v-model="exchange" :options="exchanges" />
      </Active>
      <Active label="仓库">
        <span>{{ warehouseName }}</span>
      </Active>
      <Active v-if="presetMode" label="材料来源">
        <span>XIT REPD 当前勾选的建筑类型与抵达偏移</span>
      </Active>
      <Active v-else label="扣除基地库存" tooltip="扣除基地仓库中已有的材料后再计算采购量。">
        <RadioItem v-model="useBaseInv">扣除基地库存</RadioItem>
      </Active>
      <Active
        v-if="presetMode"
        label="库存抵扣"
        tooltip="与「比价」完全一致：先扣被维修基地仓库，再扣所选交易所仓库。">
        <span>基地仓库 + 交易所仓库</span>
      </Active>
      <Active v-else label="时间偏移" tooltip="对应 BRA 面板上的「现在」「+24h」「+48h」预览。">
        <SelectInput
          v-model="timeOffset"
          :options="[
            { label: '现在', value: 'now' },
            { label: '+24h', value: '24' },
            { label: '+48h', value: '48' },
          ]" />
      </Active>
      <Active label="打开航行控制" tooltip="转移完成后自动打开 SFC 并输入目的地。">
        <RadioItem v-model="openSfc">打开航行控制</RadioItem>
      </Active>
      <Active
        label="自动提交维修"
        tooltip="材料转移完成后自动勾选状况低于阈值的建筑并提交维修（追加 BRA Repair 操作）。">
        <RadioItem v-model="repairExec">自动提交维修</RadioItem>
      </Active>
      <Commands>
        <PrunButton primary @click="onGenerateClick">生成</PrunButton>
        <PrunButton dark @click="emit('close')">返回</PrunButton>
      </Commands>
    </form>
  </div>
</template>

<style module>
.notice {
  padding: 8px 4px;
  color: rgb(217, 83, 79);
}
</style>
