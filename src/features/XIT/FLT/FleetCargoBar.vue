<script setup lang="ts">
import { shipsStore } from '@src/infrastructure/prun-api/data/ships';
import { storagesStore } from '@src/infrastructure/prun-api/data/storage';
import {
  getMaterialCategoryCssClass,
  translateCategory,
} from '@src/infrastructure/prun-ui/item-tracker';
import { getInventorySummary } from '@src/core/inventory-summary';
import Tooltip from '@src/components/Tooltip.vue';
import { fixed02 } from '@src/utils/format';
import { showBuffer } from '@src/infrastructure/prun-ui/buffers';
import { ref, watch, computed, onUnmounted } from 'vue';

const props = defineProps<{
  shipId: string | null;
  tall?: boolean;
}>();

const $style = useCssModule();

interface Segment {
  name: string;
  class: string;
  borderClasses?: string[];
  width: string;
  title: string;
  load?: string;
}

interface CargoBarData {
  segments: Segment[];
  miniMode: boolean;
}

const cargoBar = computed<CargoBarData>(() => {
  const ship = shipsStore.getById(props.shipId);
  const inv = storagesStore.getById(ship?.idShipStore);
  if (!inv || inv.items.length === 0) {
    return {
      segments: [],
      miniMode: false,
    };
  }

  const wCap = inv.weightCapacity;
  const vCap = inv.volumeCapacity;
  const wLoad = inv.weightLoad;
  const vLoad = inv.volumeLoad;

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

  const segments = [] as Segment[];
  const summary = getInventorySummary([inv]);

  const categories = [...summary.categories.keys()].sort((a, b) => a.name.localeCompare(b.name));
  for (const category of categories) {
    const categorySummary = summary.categories.get(category)!;
    const value = useVolume ? categorySummary.volume : categorySummary.weight;
    const percentage = (value * 100) / divisor;
    segments.push({
      name: category.name,
      class: getMaterialCategoryCssClass(category),
      width: `${percentage}%`,
      title: formatTitle(
        translateCategory(category.name),
        categorySummary.weight,
        categorySummary.volume,
      ),
    });
  }

  if (summary.shipments.weight > 0 || summary.shipments.volume > 0) {
    const value = useVolume ? summary.shipments.volume : summary.shipments.weight;
    const percentage = (value * 100) / divisor;
    segments.push({
      name: '运输中',
      class: `rp-category-none`,
      width: `${percentage}%`,
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

  return {
    segments: segments,
    miniMode: isMiniMode,
  };
});

function enhanceSegmentVisibility(segments: Segment[], loadRatio: number) {
  const lowContrastCategories = new Set(['elements', 'metals', 'shipments', 'unit prefabs']);

  const isAlmostFull = loadRatio > 0.98;
  if (segments.length === 1 && isAlmostFull) {
    return;
  }

  for (let i = 1; i < segments.length; i++) {
    const current = segments[i];
    const previous = segments[i - 1];
    const currentLowContrast = lowContrastCategories.has(current.name);
    const previousLowContrast = lowContrastCategories.has(previous.name);

    if (currentLowContrast && previousLowContrast) {
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
  [$style.miniBar]: cargoBar.value.miniMode,
}));

const isAnimating = ref(false);
let animationTimeout: ReturnType<typeof setTimeout> | null = null;

watch(
  () => cargoBar.value.segments,
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

onUnmounted(() => {
  if (animationTimeout) {
    clearTimeout(animationTimeout);
  }
});

// 货物条轨道原先是 repeating-linear-gradient 斜条纹 + 运行时 inline 的深灰
// --stripe-color：浅色主题只能改写样式表里的颜色，inline 变量仍是深灰，于是
// 变成黑白相间的斜纹方框。改为纯色轨道（原版深灰、主题下由皮肤变量接管）。
function onClick() {
  const ship = shipsStore.getById(props.shipId);
  if (ship) {
    showBuffer(`SHPI ${ship.registration}`);
  }
}
</script>

<template>
  <div
    :class="[
      C.ProgressBar.progress,
      'rp-cargo-track',
      $style.container,
      { [$style.isUpdating]: isAnimating, [$style.tall]: tall },
    ]"
    @click="onClick">
    <div :class="[$style.bar, miniBarClass]">
      <Tooltip
        v-for="segment in cargoBar.segments"
        :key="segment.name"
        position="top"
        :tooltip="segment.title"
        no-icon
        :class="[$style.segment, segment.class, segment.borderClasses]"
        :style="{ width: segment.width }">
        <div v-if="segment.load" :class="$style.full">
          {{ segment.load }}
        </div>
      </Tooltip>
    </div>
  </div>
</template>

<style module>
.container {
  margin: 0px;
  cursor: pointer;
  display: flex;
  min-width: 30px;
  width: 100%;
  min-height: 13px;
  height: 13px;
  align-items: flex-end;
  justify-content: flex-start;
  /* 纯色轨道：原版深灰；浅色 / 暖米纸主题下由 theme.ts 的 .rp-cargo-track
     覆盖成皮肤的中浅纯色 + 细边框。不要再引入斜条纹或 inline 颜色变量。 */
  background-color: #2a2a2a;
}

.tall {
  min-height: 18px;
  height: 18px;
}

/* 数据刷新时用极轻的透明度脉冲代替原来的斜纹滚动，保持纯色观感。 */
.isUpdating {
  animation: cargo-pulse 0.5s linear infinite;
}

@keyframes cargo-pulse {
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

/* Override Tooltip's display: inline-block so flex children keep their
   width share. !important is required because both rules are single-class
   selectors and Tooltip's <style> may load after ours. */
.segment {
  display: block !important;
  height: 100%;
  padding: 0;
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

.full {
  width: 100%;
  font-size: 10px;
  display: flex;
  align-items: center;
  justify-content: center;
}
</style>
