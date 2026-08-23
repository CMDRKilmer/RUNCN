<script setup lang="ts">
import ContractLink from '@src/features/XIT/CONTC/ContractLink.vue';
import { timestampEachSecond } from '@src/utils/dayjs';
import { deadlineColor, formatCountdown } from '@src/utils/format';
import ConditionText from '@src/features/XIT/CONTC/ConditionText.vue';

const { condition, contract, deadline } = defineProps<{
  condition: PrunApi.ContractCondition;
  contract: PrunApi.Contract;
  deadline: number;
}>();

const eta = computed(() => {
  if (!isFinite(deadline)) {
    return '∞';
  }
  if (deadline <= timestampEachSecond.value) {
    return '-';
  }
  return formatCountdown(deadline - timestampEachSecond.value);
});

// 统计此条件阻塞了多少后续条件，以及被多少未满足条件阻塞
const dependencyInfo = computed(() => {
  const blocked = contract.conditions.filter(c => c.dependencies.includes(condition.id)).length;
  const blocking = condition.dependencies.filter(depId => {
    const dep = contract.conditions.find(c => c.id === depId);
    return dep && dep.status !== 'FULFILLED';
  }).length;
  return { blocked, blocking };
});

const deadlineStyle = computed(() => {
  if (!isFinite(deadline)) {
    return '';
  }
  return deadlineColor(deadline - timestampEachSecond.value);
});
</script>

<template>
  <tr>
    <td>
      <ContractLink :contract="contract" />
      <span
        v-if="dependencyInfo.blocked > 0"
        style="font-size: 10px; color: #f0ad4e; margin-left: 4px">
        ⟶{{ dependencyInfo.blocked }}
      </span>
      <span
        v-if="dependencyInfo.blocking > 0"
        style="font-size: 10px; color: #d9534f; margin-left: 4px">
        ⟵{{ dependencyInfo.blocking }}
      </span>
    </td>
    <td :style="deadlineStyle">
      {{ eta }}
    </td>
    <td>
      <ConditionText :condition="condition" />
    </td>
  </tr>
</template>
