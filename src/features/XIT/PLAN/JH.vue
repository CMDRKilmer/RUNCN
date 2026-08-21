<script setup lang="ts">
import ActionBar from '@src/components/ActionBar.vue';
import PrunButton from '@src/components/PrunButton.vue';
import { showBuffer } from '@src/infrastructure/prun-ui/buffers';
import { showConfirmationOverlay, showTileOverlay } from '@src/infrastructure/prun-ui/tile-overlay';
import { userData } from '@src/store/user-data';
import { getTileState } from '@src/store/user-data-tiles';
import removeArrayElement from '@src/utils/remove-array-element';
import { ddmmyyyy, hhmm } from '@src/utils/format';
import GenerateConstructionActDialog from '@src/features/XIT/PLAN/GenerateConstructionActDialog.vue';

const plans = computed(() => userData.basePlans);

function onNewClick() {
  // 清空工作区 tileState，打开空白 BPLAN。
  const ws = getTileState('bplan-workspace');
  for (const key of Object.keys(ws)) {
    delete (ws as Record<string, unknown>)[key];
  }
  showBuffer('XIT BPLAN');
}

function onOpenClick(plan: UserData.BasePlan) {
  // 将计划数据写入工作区 tileState，打开 BPLAN。
  const ws = getTileState('bplan-workspace') as Record<string, unknown>;
  for (const key of Object.keys(ws)) {
    delete ws[key];
  }
  ws.planet = plan.planet;
  ws.permits = plan.permits;
  ws.exchange = plan.exchange;
  ws.buildings = plan.buildings;
  ws.experts = plan.experts;
  ws.cogcIndustry = plan.cogcIndustry;
  ws.customInputPrices = plan.customInputPrices;
  ws.customOutputPrices = plan.customOutputPrices;
  ws.customWfPrices = plan.customWfPrices;
  ws.jhPlanId = plan.id;
  showBuffer('XIT BPLAN');
}

function onDeleteClick(ev: Event, plan: UserData.BasePlan) {
  showConfirmationOverlay(ev, () => removeArrayElement(userData.basePlans, plan), {
    message: `确定要删除计划 "${plan.name}" 吗？`,
    confirmLabel: '删除',
  });
}

function onGenerateActClick(ev: Event, plan: UserData.BasePlan) {
  showTileOverlay(ev, GenerateConstructionActDialog, { plan });
}

function formatDate(ts: number) {
  return `${ddmmyyyy(ts)} ${hhmm(ts)}`;
}
</script>

<template>
  <ActionBar>
    <PrunButton primary @click="onNewClick">新建计划</PrunButton>
  </ActionBar>
  <table>
    <thead>
      <tr>
        <th>名称</th>
        <th>星球</th>
        <th>保存时间</th>
        <th>打开</th>
        <th>购材</th>
        <th>删除</th>
      </tr>
    </thead>
    <tbody v-if="plans.length === 0">
      <tr>
        <td colspan="6">暂无计划，点「新建计划」开始规划。</td>
      </tr>
    </tbody>
    <tbody v-else>
      <tr v-for="plan in plans" :key="plan.id">
        <td>{{ plan.name }}</td>
        <td>{{ plan.planet || '—' }}</td>
        <td>{{ formatDate(plan.savedAt) }}</td>
        <td>
          <PrunButton primary @click="onOpenClick(plan)">打开</PrunButton>
        </td>
        <td>
          <PrunButton dark inline @click="onGenerateActClick($event, plan)">购材 ACT</PrunButton>
        </td>
        <td>
          <PrunButton dark inline @click="onDeleteClick($event, plan)">删除</PrunButton>
        </td>
      </tr>
    </tbody>
  </table>
</template>
