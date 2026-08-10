<script setup lang="ts">
import PrunButton from '@src/components/PrunButton.vue';
import SectionHeader from '@src/components/SectionHeader.vue';
import Active from '@src/components/forms/Active.vue';
import Commands from '@src/components/forms/Commands.vue';
import TextInput from '@src/components/forms/TextInput.vue';
import { materialsStore } from '@src/infrastructure/prun-api/data/materials';
import { sleep } from '@src/utils/sleep';
import { generatePurchaseDraft } from './contd-automation';
import {
  normalizePurchaseDraftName,
  parsePurchaseDraftImport,
  PurchaseDraftImport,
  PurchaseDraftPlan,
} from './purchase-draft-utils';

const { tile } = defineProps<{ tile: PrunTile }>();
const emit = defineEmits<{ close: [] }>();

const importText = ref('');
const imported = ref<PurchaseDraftImport>();
const draftName = ref('');
const location = ref('');
const recipient = ref('');
const deadline = ref('3');
const statusMessage = ref('');
const statusError = ref(false);

const rows = computed(() =>
  (imported.value?.items ?? []).map(item => ({
    item,
    material: materialsStore.getByTicker(item.ticker),
    total: item.amount * item.price,
  })),
);

const totalUnits = computed(() => rows.value.reduce((sum, row) => sum + row.item.amount, 0));
const totalCost = computed(() => rows.value.reduce((sum, row) => sum + row.total, 0));
const canGenerate = computed(
  () => importText.value.trim().length > 0 && location.value.trim().length > 0,
);

function parseImportText() {
  if (!importText.value.trim()) {
    setStatus('请先粘贴 ACT JSON。', true);
    return;
  }

  try {
    const next = parsePurchaseDraftImport(JSON.parse(importText.value));
    imported.value = next;
    if (!draftName.value.trim()) {
      draftName.value = normalizePurchaseDraftName(next.name);
    }
    setStatus(`已识别 ${next.items.length} 种物品，单价将全部设置为 1。`);
  } catch (error) {
    imported.value = undefined;
    const message = error instanceof Error ? error.message : 'JSON 解析失败。';
    setStatus(message, true);
  }
}

async function onGenerateClick() {
  parseImportText();
  if (!imported.value) {
    return;
  }

  if (!location.value.trim()) {
    setStatus('请填写合同目标位置。', true);
    return;
  }

  const deadlineValue = Number(deadline.value);
  const deadlineDays = Number.isNaN(deadlineValue) ? 3 : deadlineValue;

  const plan: PurchaseDraftPlan = {
    ...imported.value,
    name: normalizePurchaseDraftName(draftName.value || imported.value.name),
    location: location.value.trim(),
    recipient: recipient.value.trim() || undefined,
    deadline: Math.max(1, Math.ceil(deadlineDays)),
  };

  emit('close');
  await sleep(0);

  try {
    await generatePurchaseDraft(tile, plan);
    window.alert(`已生成采购合同草案：${plan.items.length} 种物品，总价 ${totalCost.value}。`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    window.alert(`采购合同草案生成失败：${message}`);
  }
}

function setStatus(message: string, isError = false) {
  statusMessage.value = message;
  statusError.value = isError;
}
</script>

<template>
  <div :class="C.DraftConditionEditor.form">
    <SectionHeader>生成采购合同草案</SectionHeader>
    <form>
      <Active label="ACT JSON">
        <textarea
          v-model="importText"
          :class="$style.textarea"
          spellcheck="false"
          placeholder='粘贴 XIT ACT JSON，例如包含 "actions"、"groups" 和 "materials" 的采购包。' />
      </Active>

      <Active label="草案名称">
        <TextInput v-model="draftName" />
      </Active>

      <Active label="目标位置" tooltip="CONTD 采购商品模板中的“位置”。">
        <TextInput v-model="location" />
      </Active>

      <Active label="限期">
        <TextInput v-model="deadline" />
      </Active>

      <Active label="接收方" tooltip="可留空，生成后也可以在草案里手动填写。">
        <TextInput v-model="recipient" />
      </Active>

      <Active v-if="statusMessage" label="状态">
        <span :class="statusError ? $style.statusError : $style.statusOk">{{ statusMessage }}</span>
      </Active>

      <Active v-if="rows.length > 0" label="汇总">
        <span
          >{{ rows.length }} 种 / {{ totalUnits.toLocaleString() }} 件 / {{ totalCost }} AIC</span
        >
      </Active>

      <div v-if="rows.length > 0" :class="$style.preview">
        <table>
          <thead>
            <tr>
              <th>商品</th>
              <th>数量</th>
              <th>单价</th>
              <th>总计</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="row in rows" :key="row.item.ticker">
              <td>
                <strong>{{ row.item.ticker }}</strong>
                <span>{{ row.material?.name ?? '未知物品' }}</span>
              </td>
              <td>{{ row.item.amount.toLocaleString() }}</td>
              <td>{{ row.item.price }}</td>
              <td>{{ row.total.toLocaleString() }}</td>
            </tr>
          </tbody>
        </table>
      </div>

      <Commands>
        <PrunButton primary @click="parseImportText">识别 JSON</PrunButton>
        <PrunButton primary :disabled="!canGenerate" @click="onGenerateClick">生成草案</PrunButton>
        <PrunButton dark @click="emit('close')">取消</PrunButton>
      </Commands>
    </form>
  </div>
</template>

<style module>
.textarea {
  box-sizing: border-box;
  width: 100%;
  min-height: 112px;
  padding: 6px 8px;
  resize: vertical;
  border: 1px solid rgb(61, 74, 84);
  background: rgb(26, 33, 38);
  color: rgb(226, 230, 233);
  font: inherit;
  outline: none;
}

.textarea:focus {
  border-color: rgb(255, 176, 0);
  box-shadow: inset 0 0 0 1px rgb(255, 176, 0);
}

.preview {
  max-height: 220px;
  overflow: auto;
}

.preview table {
  width: 100%;
  table-layout: fixed;
}

.preview th,
.preview td {
  padding: 2px 4px;
  text-align: right;
}

.preview th:first-child,
.preview td:first-child {
  text-align: left;
}

.preview strong,
.preview span {
  display: block;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.preview span {
  color: rgb(167, 176, 183);
}

.statusOk {
  color: rgb(129, 199, 132);
}

.statusError {
  color: rgb(229, 115, 115);
}
</style>
