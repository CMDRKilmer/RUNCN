<script setup lang="ts">
import PrunButton from '@src/components/PrunButton.vue';
import type { DispatchBaseConfig, DispatchShip } from '@src/features/XIT/FLEET/utils';
import { shipConditionLevel } from '@src/utils/ship-condition';

const { ships, baseConfigs } = defineProps<{
  ships: DispatchShip[];
  baseConfigs: Record<string, DispatchBaseConfig>;
}>();

const assignedShipIds = computed(() => {
  const ids = new Set<string>();
  for (const config of Object.values(baseConfigs)) {
    if (config.ship) {
      ids.add(config.ship);
    }
  }
  return ids;
});

const unassigned = computed(() =>
  ships.filter(x => !assignedShipIds.value.has(x.ship.id)).sort(byShipLabel),
);
const assigned = computed(() =>
  ships.filter(x => assignedShipIds.value.has(x.ship.id)).sort(byShipLabel),
);

function shipLabel(entry: DispatchShip) {
  return entry.ship.name ?? entry.ship.registration;
}

function byShipLabel(a: DispatchShip, b: DispatchShip) {
  return shipLabel(a).localeCompare(shipLabel(b));
}

// 船名胶囊按维修阈值变色（R50）：与 XIT FLT 的船况告警同一套判定。
function conditionLevel(entry: DispatchShip) {
  return shipConditionLevel(entry.ship.condition);
}

function onDragStart(event: DragEvent, shipId: string) {
  event.dataTransfer?.setData('text/plain', shipId);
  if (event.dataTransfer) {
    event.dataTransfer.effectAllowed = 'copyMove';
  }
  const button = (event.currentTarget as HTMLElement).querySelector('button');
  if (button && event.dataTransfer) {
    event.dataTransfer.setDragImage(button, button.offsetWidth / 2, button.offsetHeight / 2);
  }
}
</script>

<template>
  <div :class="$style.pool">
    <table :class="$style.table">
      <thead>
        <tr>
          <th>船只</th>
        </tr>
      </thead>
      <tbody>
        <tr v-if="unassigned.length > 0" :class="$style.labelRow">
          <td :class="$style.labelCell">未分配</td>
        </tr>
        <tr v-for="entry in unassigned" :key="entry.ship.id" :class="$style.shipRow">
          <td :class="$style.shipCell">
            <div
              :class="$style.shipWrap"
              draggable="true"
              @dragstart="onDragStart($event, entry.ship.id)">
              <PrunButton
                primary
                :class="[
                  $style.shipButton,
                  {
                    [$style.warnShip]: conditionLevel(entry) === 'warn',
                    [$style.dangerShip]: conditionLevel(entry) === 'danger',
                  },
                ]">
                <span :class="$style.shipName">{{ shipLabel(entry) }}</span>
              </PrunButton>
            </div>
          </td>
        </tr>
        <tr v-if="assigned.length > 0" :class="$style.labelRow">
          <td :class="$style.labelCell">已分配</td>
        </tr>
        <tr v-for="entry in assigned" :key="entry.ship.id" :class="$style.shipRow">
          <td :class="$style.shipCell">
            <div
              :class="$style.shipWrap"
              draggable="true"
              @dragstart="onDragStart($event, entry.ship.id)">
              <PrunButton
                primary
                :class="[
                  $style.shipButton,
                  {
                    [$style.warnShip]: conditionLevel(entry) === 'warn',
                    [$style.dangerShip]: conditionLevel(entry) === 'danger',
                  },
                ]">
                <span :class="$style.shipName">{{ shipLabel(entry) }}</span>
              </PrunButton>
            </div>
          </td>
        </tr>
      </tbody>
    </table>
  </div>
</template>

<style module>
.pool {
  --poolMaxWidth: 110px;
  width: max-content;
  min-width: 10ch;
  max-width: var(--poolMaxWidth);
  flex: 0 0 auto;
  border-left: 1px solid #2b485a;
  box-sizing: border-box;
}

.table {
  border-collapse: collapse;
  width: 100%;
}

.table thead tr {
  border-bottom: 1px solid #2b485a;
  box-sizing: border-box;
}

.table thead th {
  text-align: center;
}

.shipRow {
  height: 24px;
  box-sizing: border-box;
  border-bottom: 1px solid #2b485a;
}

.shipCell {
  padding: 3px 2px;
  height: 24px;
  box-sizing: border-box;
}

.shipWrap {
  width: 100%;
  height: 100%;
  cursor: grab;
}

.shipButton {
  width: 100%;
  height: 100%;
  min-width: 0;
  overflow: hidden;
  padding: 0 4px;
  font-size: 11px;
  pointer-events: none;
  vertical-align: middle;
  box-sizing: border-box;
}

/* 维修阈值告警（R50）：与 XIT FLT 船况告警同一口径——0.80~0.83 临近维修、
   低于 0.80 维修临界。这里不能只换字色：胶囊本身是实心主按钮色块，陶瓷白 / 星海的
   主按钮底很深，琥珀字压上去只有 1.5~2:1，反而比不改更难读。所以整块换色——
   底色取该主题的告警强调色，字色取该主题的画布色（浅色主题是近白的字压深橙，
   深色主题是近黑的字压亮橙），两端都 ≥4.5:1，且与右侧「执行」等主按钮区分开。
   兜底值同时服务原样主题（不注入 token 时 var() 走 fallback）。 */
.shipButton.warnShip {
  color: var(--rp-skin-bg, #f2f5f7) !important;
  background-color: var(--rp-skin-warning, #c2410c) !important;
  border-color: var(--rp-skin-warning, #c2410c) !important;
}

.shipButton.dangerShip {
  color: var(--rp-skin-bg, #f2f5f7) !important;
  background-color: var(--rp-skin-danger, #9c3b3b) !important;
  border-color: var(--rp-skin-danger, #9c3b3b) !important;
}

/* 主题下要压过引擎的主按钮规则（`html[data-rp-theme] :is([class*='Button__primary'])`
   是 (0,3,1) + !important），单个组件类压不住，沿用 R49 的三重属性选择器写法。 */
:global(html[data-rp-theme][data-rp-theme][data-rp-theme]) .shipButton.warnShip {
  color: var(--rp-skin-bg, #f2f5f7) !important;
  background-color: var(--rp-skin-warning, #c2410c) !important;
  border-color: var(--rp-skin-warning, #c2410c) !important;
}

:global(html[data-rp-theme][data-rp-theme][data-rp-theme]) .shipButton.dangerShip {
  color: var(--rp-skin-bg, #f2f5f7) !important;
  background-color: var(--rp-skin-danger, #9c3b3b) !important;
  border-color: var(--rp-skin-danger, #9c3b3b) !important;
}

/* 类名不能带 `Label__` 子串：token 主题（陶瓷白多彩 / 星海霓虹）的组件映射表里有
   `[class*='Label__'] { color: var(--rp-cc-text-secondary) }`，会连 CSS Module 生成的
   `rp-ShipPool__shipLabel___<hash>` 一起命中——船名因此被改成次级文字色（陶瓷白下是
   rgb(65,74,68) 压在主按钮深青绿底上，几乎读不出，见 R49）。改名后文字继承按钮自身的
   主按钮文字色，各主题自动跟随。 */
.shipName {
  display: block;
  width: 100%;
  max-width: calc(var(--poolMaxWidth) - 13px);
  text-align: center;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.labelRow {
  height: 24px;
  box-sizing: border-box;
  border-bottom: 1px solid #2b485a;
}

.labelCell {
  font-size: 11px;
  color: #888;
  text-align: center;
  padding: 0 4px;
  height: 24px;
  vertical-align: middle;
  box-sizing: border-box;
}
</style>
