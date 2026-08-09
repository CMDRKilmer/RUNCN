<script setup lang="ts">
import { storagesStore } from '@src/infrastructure/prun-api/data/storage';
import { getMaterialCategoryCssClass } from '@src/infrastructure/prun-ui/item-tracker';
import { materialCategoriesStore } from '@src/infrastructure/prun-api/data/material-categories';
import { fixed02 } from '@src/utils/format';
import { showBuffer } from '@src/infrastructure/prun-ui/buffers';
import { getInboundShipStores } from '@src/core/burn';
import { StorageAlarmLevel } from '@src/core/storage-analysis';

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
      title: formatTitle(category.name, categorySummary.weight, categorySummary.volume),
    });
  }

  if (summary.shipments.weight > 0 || summary.shipments.volume > 0) {
    const value = useVolume ? summary.shipments.volume : summary.shipments.weight;
    segments.push({
      name: 'shipments',
      class: 'rp-category-none',
      width: `${(value * 100) / divisor}%`,
      title: formatTitle('shipments', summary.shipments.weight, summary.shipments.volume),
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

interface CategorySummary {
  weight: number;
  volume: number;
}

function getInventorySummary(stores: PrunApi.Store[]) {
  const shipments: CategorySummary = { weight: 0, volume: 0 };
  const categories = new Map<PrunApi.MaterialCategory, CategorySummary>();

  for (const store of stores) {
    for (const item of store.items) {
      if (item.type === 'SHIPMENT') {
        shipments.weight += item.weight;
        shipments.volume += item.volume;
        continue;
      }

      const material = item.quantity?.material;
      if (!material) {
        continue;
      }

      const category = materialCategoriesStore.getById(material.category);
      if (!category) {
        continue;
      }

      let categorySummary = categories.get(category);
      if (!categorySummary) {
        categorySummary = { weight: 0, volume: 0 };
        categories.set(category, categorySummary);
      }

      categorySummary.weight += item.weight;
      categorySummary.volume += item.volume;
    }
  }

  return { shipments, categories };
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

const totalLoadRatio = computed(() => {
  const primary = storagesStore.getById(props.storeId);
  if (!primary) {
    return 0;
  }
  const all = [primary, ...inboundStores.value];
  const wLoad = sumBy(all, s => s.weightLoad);
  const vLoad = sumBy(all, s => s.volumeLoad);
  return Math.max(wLoad / primary.weightCapacity, vLoad / primary.volumeCapacity);
});

const stripeAlertColor = computed(() => {
  const ratio = totalLoadRatio.value;
  const start = { r: 50, g: 50, b: 50 };
  const target = { r: 100, g: 100, b: 100 };
  if (ratio < 0.7) {
    return `rgb(${start.r}, ${start.g}, ${start.b})`;
  }
  const normalized = (ratio - 0.7) / 0.3;
  const r = Math.round(start.r + (target.r - start.r) * normalized);
  const g = Math.round(start.g + (target.g - start.g) * normalized);
  const b = Math.round(start.b + (target.b - start.b) * normalized);
  return `rgb(${r}, ${g}, ${b})`;
});

const stripeWidth = computed(() => {
  const ratio = totalLoadRatio.value;
  const startWidth = 10;
  const smallWidth = 2;
  if (ratio < 0.7) {
    return `${startWidth}px`;
  }
  const normalized = (ratio - 0.7) / 0.3;
  return `${startWidth - (startWidth - smallWidth) * normalized}px`;
});

const alarmClass = computed(() => ({
  [$style.isAlarmRed]: props.alarmLevel === 'red',
}));
</script>

<template>
  <div
    :class="[C.ProgressBar.progress, $style.container, { [$style.isUpdating]: isAnimating }]"
    :style="{ '--stripe-color': stripeAlertColor, '--stripe-width': stripeWidth }"
    :data-tooltip="alarmReason"
    :data-tooltip-position="alarmReason ? 'top' : undefined"
    @click="showBuffer(onClickCmd)">
    <div v-if="alarmLevel === 'red'" :class="[$style.alarmOverlay, alarmClass]" />
    <div :class="[$style.bar, miniBarClass]">
      <div
        v-for="segment in invBar.segments"
        :key="segment.name"
        :class="[segment.class, segment.borderClasses]"
        :style="{ width: segment.width }"
        :title="segment.title" />
    </div>
  </div>
</template>

<style module>
/* padding: 0 cancels the game's [data-tooltip] rule (`padding: 0 4px 0`),
   which kicks in as soon as an alarm supplies a tooltip. It would inset the
   bar 4px on each side, so the striped background showed at both ends and
   the segments no longer read as left-aligned. */
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
  background-color: #2a2a2a;
  --stripe-width: 10px;
  --hypotenuse: calc(var(--stripe-width) * sqrt(2));

  background-image: repeating-linear-gradient(
    45deg,
    #2a2a2a,
    #2a2a2a calc(var(--stripe-width) / 2),
    var(--stripe-color) calc(var(--stripe-width) / 2),
    var(--stripe-color) var(--stripe-width)
  );
  background-size: var(--hypotenuse) var(--hypotenuse);
}

.isUpdating {
  animation: move-stripes 0.5s linear infinite;
}

@keyframes move-stripes {
  from {
    background-position: 0 0;
  }
  to {
    background-position: var(--hypotenuse) 0;
  }
}

.bar {
  width: 100%;
  height: 100%;
  display: flex;
}

/* A dedicated sibling of .bar rather than a ::after pseudo-element on
   .container: .container also carries data-tooltip for the alarm reason,
   and the game's own [data-tooltip]::after rule (used for the tooltip
   arrow) collides at equal specificity and wins, zeroing this out if it's
   a pseudo-element on the same node. A real element sidesteps that.
   It's a sibling of .bar (not nested inside it) so it spans .container's
   full padding-box — .bar itself is inset by .container's own
   padding/border (from the game's C.ProgressBar.progress class), which
   would otherwise leave a sliver of .container's background visible at
   each end. */
.alarmOverlay {
  position: absolute;
  pointer-events: none;
  z-index: 2;
}

/* Red alarm: black/red hazard-tape stripes with a black outline, across
   the whole bar. Storage is at (or projected past) capacity. The black
   stripes are fully transparent and the red stripes are 20% translucent,
   so the bar underneath always shows through. */
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
