<script setup lang="ts">
import { storagesStore } from '@src/infrastructure/prun-api/data/storage';
import {
  getMaterialCategoryCssClass,
  translateCategory,
} from '@src/infrastructure/prun-ui/item-tracker';
import { getInventorySummary } from '@src/core/inventory-summary';
import Tooltip from '@src/components/Tooltip.vue';
import { fixed02 } from '@src/utils/format';
import { showBuffer } from '@src/infrastructure/prun-ui/buffers';
import { getInboundShipStores } from '@src/core/burn';
import type { StorageAlarmLevel } from '@src/core/storage-analysis';
import { sumBy } from '@src/utils/sum-by';

const props = defineProps<{
  storeId: string;
  onClickCmd: string;
  naturalId?: string;
  alarmLevel?: StorageAlarmLevel;
  alarmReason?: string;
}>();

const $style = useCssModule();

interface Segment {
  name: string;
  class: string;
  borderClasses?: string[];
  width: string;
  title: string;
}

const inboundStores = computed<PrunApi.Store[]>(() => getInboundShipStores(props.naturalId));

const invBar = computed(() => {
  const primary = storagesStore.getById(props.storeId);
  if (!primary) {
    return { segments: [] as Segment[], miniMode: false };
  }

  const all = [primary, ...inboundStores.value];

  const wCap = primary.weightCapacity;
  const vCap = primary.volumeCapacity;
  const wLoad = sumBy(all, s => s.weightLoad);
  const vLoad = sumBy(all, s => s.volumeLoad);

  const weightRatio = wLoad / wCap;
  const volumeRatio = vLoad / vCap;
  const maxRatio = Math.max(weightRatio, volumeRatio);
  const useVolume = volumeRatio > weightRatio;

  const isMiniMode = maxRatio <= 0.05 && maxRatio > 0;
  const activeLoad = useVolume ? vLoad : wLoad;
  const activeCapacity = useVolume ? vCap : wCap;
  let divisor = isMiniMode ? activeLoad : activeCapacity;
  if (divisor === 0) {
    divisor = 1;
  }

  const formatTitle = (name: string, weight: number, volume: number) => {
    const load = useVolume ? fixed02(volume) + 'm³' : fixed02(weight) + 't';
    return `${name}: ${load}`;
  };

  const segments: Segment[] = [];
  const summary = getInventorySummary(all);

  const categories = [...summary.categories.keys()].sort((a, b) => a.name.localeCompare(b.name));
  for (const category of categories) {
    const categorySummary = summary.categories.get(category)!;
    const value = useVolume ? categorySummary.volume : categorySummary.weight;
    segments.push({
      name: category.name,
      class: getMaterialCategoryCssClass(category),
      width: `${(value * 100) / divisor}%`,
      title: formatTitle(
        translateCategory(category.name),
        categorySummary.weight,
        categorySummary.volume,
      ),
    });
  }

  if (summary.shipments.weight > 0 || summary.shipments.volume > 0) {
    const value = useVolume ? summary.shipments.volume : summary.shipments.weight;
    segments.push({
      name: 'shipments',
      class: 'rp-category-none',
      width: `${(value * 100) / divisor}%`,
      title: formatTitle(
        translateCategory('shipments'),
        summary.shipments.weight,
        summary.shipments.volume,
      ),
    });
  }

  if (!isMiniMode) {
    enhanceSegmentVisibility(segments, maxRatio);
  }

  return { segments, miniMode: isMiniMode };
});

function enhanceSegmentVisibility(segments: Segment[], loadRatio: number) {
  if (segments.length === 0) {
    return;
  }

  const lowContrastCategories = new Set(['elements', 'metals', 'shipments', 'unit prefabs']);
  const isAlmostFull = loadRatio > 0.98;

  if (segments.length === 1 && isAlmostFull) {
    return;
  }

  for (let i = 1; i < segments.length; i++) {
    const current = segments[i];
    const previous = segments[i - 1];
    if (lowContrastCategories.has(current.name) && lowContrastCategories.has(previous.name)) {
      current.borderClasses = [$style.borderLeft];
    }
  }

  if (!isAlmostFull) {
    const last = segments[segments.length - 1];
    last.borderClasses ??= [];
    last.borderClasses.push($style.borderRight);
  }
}

const miniBarClass = computed(() => ({
  [$style.miniBar]: invBar.value.miniMode,
}));

const isAnimating = ref(false);
let animationTimeout: ReturnType<typeof setTimeout> | null = null;

watch(
  () => invBar.value.segments,
  () => {
    if (animationTimeout) {
      clearTimeout(animationTimeout);
    }
    isAnimating.value = true;
    animationTimeout = setTimeout(() => {
      isAnimating.value = false;
    }, 1000);
  },
  { deep: true },
);

// 货物条轨道改为纯色：原先的斜条纹 + inline 深灰变量在浅色主题下会变成
// 黑白相间的斜纹方框（样式表色被改写、inline 变量不会）。主题下由
// theme.ts 的 .rp-cargo-track 接管成皮肤的中浅纯色。
onUnmounted(() => {
  if (animationTimeout !== null) {
    clearTimeout(animationTimeout);
  }
});
const alarmClass = computed(() => ({
  [$style.isAlarmRed]: props.alarmLevel === 'red',
}));
</script>

<template>
  <div
    :class="[
      C.ProgressBar.progress,
      'rp-cargo-track',
      $style.container,
      { [$style.isUpdating]: isAnimating },
    ]"
    @click="showBuffer(onClickCmd)">
    <Tooltip
      v-if="alarmReason"
      no-icon
      position="top"
      :tooltip="alarmReason"
      :class="$style.alarmTooltip" />
    <div v-if="alarmLevel === 'red'" :class="[$style.alarmOverlay, alarmClass]" />
    <div :class="[$style.bar, miniBarClass]">
      <Tooltip
        v-for="segment in invBar.segments"
        :key="segment.name"
        no-icon
        position="top"
        :tooltip="segment.title"
        :class="[segment.class, segment.borderClasses, $style.segment]"
        :style="{ width: segment.width }" />
    </div>
  </div>
</template>

<style module>
.container {
  position: relative;
  margin: 0;
  padding: 0;
  cursor: pointer;
  display: flex;
  min-width: 30px;
  width: 100%;
  min-height: 13px;
  height: 13px;
  align-items: flex-end;
  justify-content: flex-start;
  /* 纯色轨道，见 FleetCargoBar.vue 同名说明。 */
  background-color: #2a2a2a;
}

/* 数据刷新时用极轻的透明度脉冲代替原来的斜纹滚动，保持纯色观感。 */
.isUpdating {
  animation: inv-pulse 0.5s linear infinite;
}

@keyframes inv-pulse {
  0%,
  100% {
    opacity: 1;
  }
  50% {
    opacity: 0.78;
  }
}

.bar {
  width: 100%;
  height: 100%;
  display: flex;
}

/* Cover the whole container so hovering anywhere over the bar (including
   between segments) still triggers the alarm tooltip. */
.alarmTooltip {
  position: absolute;
  inset: 0;
  display: block !important;
}

/* Override Tooltip's display: inline-block so segments keep their
   width share inside the flex bar. !important is required because both
   rules are single-class selectors and Tooltip's <style> may load after
   ours. */
.segment {
  display: block !important;
  height: 100%;
  padding: 0;
}

.alarmOverlay {
  position: absolute;
  pointer-events: none;
  z-index: 2;
}

.isAlarmRed {
  inset: 0;
  background-image: repeating-linear-gradient(
    45deg,
    transparent 0,
    transparent 6px,
    rgba(217, 83, 79, 0.8) 6px,
    rgba(217, 83, 79, 0.8) 12px
  );
  outline: 2px solid #000;
  outline-offset: -2px;
}

.miniBar {
  width: 25%;
  height: 50%;
  border-top: 1px solid #999;
  border-right: 1px solid #999;
}

.borderLeft {
  border-left: 1px solid #999;
}

.borderRight {
  border-right: 1px solid #999;
}
</style>
