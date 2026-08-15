<script setup lang="ts">
// 编辑单个别名的弹窗。
// 显示当前别名（可清空），点击保存后调用 onSave 回调，
// 由父组件负责持久化到 userData.baseAliases。

import PrunButton from '@src/components/PrunButton.vue';
import SectionHeader from '@src/components/SectionHeader.vue';
import Active from '@src/components/forms/Active.vue';
import TextInput from '@src/components/forms/TextInput.vue';
import Commands from '@src/components/forms/Commands.vue';

const { currentAlias, targetLabel, onSave, onClear } = defineProps<{
  currentAlias: string;
  targetLabel: string;
  onSave: (alias: string) => void;
  onClear: () => void;
}>();

const emit = defineEmits<{ (e: 'close'): void }>();

const alias = ref(currentAlias);

function onSaveClick() {
  const trimmed = alias.value.trim();
  if (trimmed.length === 0) {
    onClear();
  } else {
    onSave(trimmed);
  }
  emit('close');
}

function onClearClick() {
  alias.value = '';
}
</script>

<template>
  <div :class="C.DraftConditionEditor.form">
    <SectionHeader>基地别名</SectionHeader>
    <form>
      <Active label="目标基地">
        <span>{{ targetLabel }}</span>
      </Active>
      <Active label="别名" tooltip="可在 SFC 目的地输入框中用此别名搜索该基地。">
        <TextInput v-model="alias" :focus-on-mount="true" />
      </Active>
      <Commands>
        <PrunButton @click="onClearClick">清空</PrunButton>
        <PrunButton primary @click="onSaveClick">保存</PrunButton>
      </Commands>
    </form>
  </div>
</template>
