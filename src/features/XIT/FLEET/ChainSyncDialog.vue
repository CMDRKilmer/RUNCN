<script setup lang="ts">
// 环线云端同步对比对话框（按船/配置）：
// 展示环线配置与各活跃船在本地/云端的快照概要，由用户逐项选择覆盖方向。
import PrunButton from '@src/components/PrunButton.vue';
import SectionHeader from '@src/components/SectionHeader.vue';
import { shipsStore } from '@src/infrastructure/prun-api/data/ships';
import { CONFIG_KEY, type SyncComparison } from '@src/features/XIT/FLEET/chain-sync';
import type { ChainSyncDoc } from '@src/infrastructure/org-api/chain-sync';

const props = defineProps<{
  comparison: SyncComparison;
  onApply: (target: string, direction: 'pull' | 'push') => void;
}>();

const emit = defineEmits<{ (e: 'close'): void }>();

function formatTime(ms: number): string {
  return new Date(ms).toLocaleString();
}

function apply(target: string, direction: 'pull' | 'push') {
  props.onApply(target, direction);
  emit('close');
}

// 本地活跃船 ∪ 云端船（去重排序）。
const shipIds = computed(() => {
  const ids = new Set<string>();
  for (const id of props.comparison.localShips.keys()) {
    ids.add(id);
  }
  for (const id of props.comparison.remoteShips.keys()) {
    ids.add(id);
  }
  return [...ids].sort();
});

// 船名：优先当前实际船名（ship.name）；其次快照记录里的船名；最后回退 shipId。
function shipLabel(shipId: string): string {
  const ship = shipsStore.getById(shipId);
  if (ship) {
    return ship.name || ship.registration;
  }
  const local = props.comparison.localShips.get(shipId);
  const remote = props.comparison.remoteShips.get(shipId);
  return local?.chainRuns[shipId]?.shipName ?? remote?.chainRuns[shipId]?.shipName ?? shipId;
}

function runCount(doc: ChainSyncDoc | undefined): number {
  return doc === undefined ? 0 : Object.keys(doc.chainRuns).length;
}

function stopCount(doc: ChainSyncDoc | undefined): number {
  if (doc === undefined) {
    return 0;
  }
  const run = Object.values(doc.chainRuns)[0];
  return run?.stops.length ?? 0;
}
</script>

<template>
  <div :class="C.DraftConditionEditor.form">
    <SectionHeader>环线云端同步</SectionHeader>

    <div :class="$style.block">
      <div :class="$style.blockTitle">环线配置</div>
      <div :class="$style.row">
        <div :class="$style.side">
          <div :class="$style.colHead">本地</div>
          <div>分组：{{ comparison.localConfig.config?.chainGroup || '—' }}</div>
          <div>时间：{{ formatTime(comparison.localConfig.updatedAt) }}</div>
          <PrunButton primary :class="$style.sideBtn" @click="apply(CONFIG_KEY, 'push')"
            >上传</PrunButton
          >
        </div>
        <div :class="$style.side">
          <div :class="$style.colHead">云端</div>
          <template v-if="comparison.remoteConfig">
            <div>分组：{{ comparison.remoteConfig.config?.chainGroup || '—' }}</div>
            <div>时间：{{ formatTime(comparison.remoteConfig.updatedAt) }}</div>
          </template>
          <div v-else :class="$style.empty">无数据</div>
          <PrunButton
            v-if="comparison.remoteConfig"
            dark
            :class="$style.sideBtn"
            @click="apply(CONFIG_KEY, 'pull')">
            下载
          </PrunButton>
        </div>
      </div>
    </div>

    <div v-if="shipIds.length > 0" :class="$style.block">
      <div :class="$style.blockTitle">船只环线</div>
      <div v-for="shipId in shipIds" :key="shipId" :class="$style.shipRow">
        <div :class="$style.shipName">{{ shipLabel(shipId) }}</div>
        <div :class="$style.side">
          <div :class="$style.colHead">本地</div>
          <template v-if="comparison.localShips.get(shipId)">
            <div>时间：{{ formatTime(comparison.localShips.get(shipId)!.updatedAt) }}</div>
            <div>
              站点：{{ stopCount(comparison.localShips.get(shipId)) }} · 运行：{{
                runCount(comparison.localShips.get(shipId))
              }}
              · 包：{{ comparison.localShips.get(shipId)!.actionPackages.length }} · 触发器：{{
                comparison.localShips.get(shipId)!.triggers.length
              }}
            </div>
          </template>
          <div v-else :class="$style.empty">无</div>
          <!-- 始终可用：本地无该船记录时上传会以「空快照」清空云端该船。 -->
          <PrunButton primary :class="$style.sideBtn" @click="apply(shipId, 'push')"
            >上传</PrunButton
          >
        </div>
        <div :class="$style.side">
          <div :class="$style.colHead">云端</div>
          <template v-if="comparison.remoteShips.get(shipId)">
            <div>时间：{{ formatTime(comparison.remoteShips.get(shipId)!.updatedAt) }}</div>
            <div>
              站点：{{ stopCount(comparison.remoteShips.get(shipId)) }} · 运行：{{
                runCount(comparison.remoteShips.get(shipId))
              }}
              · 包：{{ comparison.remoteShips.get(shipId)!.actionPackages.length }} · 触发器：{{
                comparison.remoteShips.get(shipId)!.triggers.length
              }}
            </div>
          </template>
          <div v-else :class="$style.empty">无数据</div>
          <PrunButton
            v-if="comparison.remoteShips.get(shipId)"
            dark
            :class="$style.sideBtn"
            @click="apply(shipId, 'pull')">
            下载
          </PrunButton>
        </div>
      </div>
    </div>
  </div>
</template>

<style module>
.block {
  margin-bottom: 0.75rem;
}

.blockTitle {
  color: #8a9aa8;
  font-size: 12px;
  margin-bottom: 4px;
}

.row {
  display: flex;
  gap: 12px;
  align-items: flex-start;
}

.shipRow {
  display: flex;
  gap: 12px;
  align-items: flex-start;
  padding: 6px 0;
  border-bottom: 1px solid #1c2f3d;
}

.shipName {
  min-width: 8em;
  font-weight: 600;
}

.side {
  flex: 1;
  min-width: 0;
  font-size: 12px;
}

.colHead {
  color: #8a9aa8;
  font-size: 12px;
  margin-bottom: 2px;
}

.sideBtn {
  margin-top: 4px;
  align-self: flex-start;
}

.empty {
  color: #8a9aa8;
  font-size: 12px;
}

.actions {
  display: flex;
  flex-direction: column;
  gap: 4px;
  align-items: stretch;
}
</style>
