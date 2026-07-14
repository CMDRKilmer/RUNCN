<script setup lang="ts">
import ContractLink from '@src/features/XIT/CONTC/ContractLink.vue';
import { timestampEachSecond } from '@src/utils/dayjs';
import dayjs from 'dayjs';
import ConditionText from '@src/features/XIT/CONTC/ConditionText.vue';

const { condition, contract, deadline } = defineProps<{
  condition: PrunApi.ContractCondition;
  contract: PrunApi.Contract;
  deadline: number;
}>();

const DAY_MS = 24 * 60 * 60 * 1000;

const eta = computed(() => {
  if (!isFinite(deadline)) {
    return '∞';
  }
  if (deadline <= timestampEachSecond.value) {
    return '-';
  }
  let duration = dayjs.duration({ milliseconds: deadline - timestampEachSecond.value });
  const days = Math.floor(duration.asDays());
  duration = duration.subtract(days, 'days');
  const hours = Math.floor(duration.asHours());
  if (days > 0) {
    return `${days}d ${hours}h`;
  }
  duration = duration.subtract(hours, 'hours');
  const minutes = Math.floor(duration.asMinutes());
  if (hours > 0) {
    return `${hours}h ${minutes}m`;
  }
  duration = duration.subtract(minutes, 'minutes');
  const seconds = Math.floor(duration.asSeconds());
  if (minutes > 0) {
    return `${minutes}m ${seconds}s`;
  }
  return `${seconds}s`;
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
  if (!isFinite(deadline)) return '';
  const remaining = deadline - timestampEachSecond.value;
  if (remaining < DAY_MS) return 'color: #d9534f';
  if (remaining < DAY_MS * 3) return 'color: #f0ad4e';
  return '';
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
