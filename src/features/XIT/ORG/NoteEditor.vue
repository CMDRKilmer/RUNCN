<script setup lang="ts">
import { ref } from 'vue';
import type { TaskNote } from '@src/infrastructure/org-api/types';
import * as notesApi from '@src/infrastructure/org-api/notes';
import { HttpError } from '@src/infrastructure/org-api/client';
import PrunButton from '@src/components/PrunButton.vue';

const props = defineProps<{ taskId: string; notes: TaskNote[] }>();
const emit = defineEmits<{ (e: 'changed'): void }>();

const newContent = ref('');
const error = ref('');
const loading = ref(false);

async function onAdd() {
  if (!newContent.value.trim() || loading.value) {
    return;
  }
  loading.value = true;
  error.value = '';
  try {
    await notesApi.createNote(props.taskId, newContent.value.trim());
    newContent.value = '';
    emit('changed');
  } catch (err) {
    error.value = err instanceof HttpError ? err.message : String(err);
  } finally {
    loading.value = false;
  }
}
</script>

<template>
  <div :class="[C.fonts.fontRegular, $style.container]">
    <ul :class="$style.notes">
      <li v-for="note in notes" :key="note.id" :class="$style.note">
        <div :class="$style.meta">
          <strong>{{ note.authorUsername }}</strong>
          <span>{{ new Date(note.createdAt).toLocaleString() }}</span>
        </div>
        <div :class="$style.content">{{ note.content }}</div>
      </li>
      <li v-if="notes.length === 0" :class="$style.empty">暂无备注</li>
    </ul>

    <div :class="$style.add">
      <textarea v-model="newContent" placeholder="添加备注（仅任务参与方可见）" rows="3" />
      <PrunButton primary inline :disabled="!newContent.trim() || loading" @click="onAdd">
        {{ loading ? '提交中...' : '添加' }}
      </PrunButton>
    </div>
    <div v-if="error" :class="$style.error">{{ error }}</div>
  </div>
</template>

<style module>
.container {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.notes {
  list-style: none;
  padding: 0;
  margin: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.note {
  border-left: 2px solid var(--panel-border);
  padding: 4px 8px;
  background: var(--panel-background-alt);
}
.meta {
  display: flex;
  justify-content: space-between;
  font-size: 11px;
  color: var(--text-muted);
}
.content {
  font-size: 12px;
  margin-top: 2px;
  white-space: pre-wrap;
}
.empty {
  color: var(--text-muted);
  font-size: 12px;
  padding: 4px 0;
}
.add {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.add textarea {
  padding: 6px 8px;
  border: 1px solid var(--panel-border);
  background: var(--input-background);
  color: var(--text);
  resize: vertical;
  font-family: inherit;
}
.error {
  color: var(--text-negative);
  font-size: 12px;
}
</style>
