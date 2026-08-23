<script setup lang="ts">
import PrunButton from '@src/components/PrunButton.vue';
import SectionHeader from '@src/components/SectionHeader.vue';
import Active from '@src/components/forms/Active.vue';
import TextInput from '@src/components/forms/TextInput.vue';
import Commands from '@src/components/forms/Commands.vue';
import SelectInput from '@src/components/forms/SelectInput.vue';
import { uploadJson } from '@src/utils/json-file';

type ImportType = 'TEXT' | 'FILE';

const typeOptions: { label: string; value: ImportType }[] = [
  {
    label: '粘贴 JSON',
    value: 'TEXT',
  },
  {
    label: '上传 JSON',
    value: 'FILE',
  },
];

interface TriggerConfig {
  triggers: UserData.TriggerData[];
  actionPackages: UserData.ActionPackageData[];
}

const { onImport } = defineProps<{ onImport: (config: TriggerConfig) => void }>();

const emit = defineEmits<{ (e: 'close'): void }>();

const type = ref('TEXT' as ImportType);
const text = ref('');
const error = ref(false);

function onImportClick() {
  if (text.value.length === 0) {
    error.value = true;
    return;
  }
  try {
    const json = JSON.parse(text.value);
    if (!validateJson(json)) {
      error.value = true;
      return;
    }
    onImport(json);
    emit('close');
  } catch {
    error.value = true;
  }
}

function onUploadClick() {
  uploadJson(json => {
    if (!validateJson(json)) {
      error.value = true;
      return;
    }
    onImport(json);
    emit('close');
  });
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function validateJson(json: any): json is TriggerConfig {
  return json.version === 1 && Array.isArray(json.triggers) && Array.isArray(json.actionPackages);
}
</script>

<template>
  <div :class="C.DraftConditionEditor.form">
    <SectionHeader>导入触发器配置</SectionHeader>
    <form>
      <Active label="类型">
        <SelectInput v-model="type" :options="typeOptions" />
      </Active>
      <Active v-if="type === 'TEXT'" label="JSON" :error="error">
        <TextInput v-model="text" focus-on-mount />
      </Active>
      <Commands>
        <PrunButton v-if="type === 'FILE'" primary @click="onUploadClick">上传</PrunButton>
        <PrunButton v-if="type === 'TEXT'" primary @click="onImportClick">导入</PrunButton>
      </Commands>
    </form>
  </div>
</template>
