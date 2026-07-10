<script setup lang="ts">
import { ref, watch } from 'vue';
import PrunButton from '@src/components/PrunButton.vue';
import RadioItem from '@src/components/forms/RadioItem.vue';

// 合同状态定义
const STATUS_FILTERS = [
  { key: 'DRAFT', label: '草案', statusClass: C.ContractStatus.neutral },
  { key: 'OPEN', label: '公开', statusClass: C.ContractStatus.neutral },
  { key: 'REJECTED', label: '已拒绝', statusClass: C.ContractStatus.bad },
  { key: 'DEADLINE_EXCEEDED', label: '已超期', statusClass: C.ContractStatus.bad },
  { key: 'BREACHED', label: '已违约', statusClass: C.ContractStatus.bad },
  { key: 'CANCELLED', label: '已取消', statusClass: C.ContractStatus.bad },
  { key: 'TERMINATED', label: '已终止', statusClass: C.ContractStatus.bad },
  { key: 'SIGNED', label: '已签约', statusClass: C.ContractStatus.partial },
  { key: 'PARTIALLY_FULFILLED', label: '部分完成', statusClass: C.ContractStatus.partial },
  { key: 'FULFILLED', label: '已完成', statusClass: C.ContractStatus.good },
] as const;

const props = defineProps<{
  modelValue: Set<string>;
  showFilters?: boolean;
}>();

const emit = defineEmits<{
  'update:modelValue': [value: Set<string>];
  'update:showFilters': [value: boolean];
}>();

const showFilters = ref<boolean>((props.showFilters ?? true) as boolean);

watch(
  () => props.showFilters ?? true,
  value => {
    showFilters.value = value;
  },
);

function toggleShowFilters() {
  showFilters.value = !showFilters.value;
  emit('update:showFilters', showFilters.value);
}

function setFilter(key: string, value: boolean) {
  const newSet = new Set(props.modelValue);
  if (value) {
    newSet.add(key);
  } else {
    newSet.delete(key);
  }
  emit('update:modelValue', newSet);
}

function selectAll() {
  emit('update:modelValue', new Set(STATUS_FILTERS.map(f => f.key)));
}

function selectNone() {
  emit('update:modelValue', new Set());
}
</script>

<template>
  <div :class="$style.container">
    <div :class="$style.filterBar">
      <PrunButton dark inline @click="selectAll">全部</PrunButton>
      <PrunButton dark inline @click="selectNone">无</PrunButton>
      <PrunButton dark inline @click="toggleShowFilters">
        {{ showFilters ? '隐藏过滤器' : '显示过滤器' }}
      </PrunButton>
    </div>
    <div v-if="showFilters" :class="C.ContractsListTable.filter">
      <RadioItem
        v-for="f in STATUS_FILTERS"
        :key="f.key"
        horizontal
        :model-value="modelValue.has(f.key)"
        @update:model-value="value => setFilter(f.key, value)">
        <span :class="f.statusClass">{{ f.label }}</span>
      </RadioItem>
    </div>
  </div>
</template>

<style module>
.container {
  width: 100%;
  display: flex;
  flex-direction: column;
  isolation: isolate;
  user-select: auto;
  position: relative;
}

.filterBar {
  display: flex;
  align-items: center;
  border-bottom: 1px solid rgba(255, 255, 255, 0.08);
}
</style>
