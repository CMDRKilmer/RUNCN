<script setup lang="ts">
import HeadItem from './HeadItem.vue';
import { context, screensStore } from '@src/infrastructure/prun-api/data/screens';
import { userData } from '@src/store/user-data';
import { vDraggable } from 'vue-draggable-plus';
import { syncState } from '@src/features/basic/screen-tab-bar/sync';
import { reconcileTabOrder } from '@src/features/basic/screen-tab-bar/order';
import { useTemplateRef } from 'vue';

watchEffect(syncState);

const current = computed(() => screensStore.current.value);

function getScreen(id: string) {
  return screensStore.getById(id);
}

// 顺序清单是持久化数据，只追加不删除（见 sync.ts）。已被删除的屏幕仍留在清单里，
// 渲染时按 store 过滤掉。v-draggable 必须绑定**真正渲染的那一份**数组：以前直接绑
// `userData.tabs.order`，Sortable 报的是可见 DOM 的索引，却被套用到含已删 ID 的完整
// 清单上，`[deleted, A, B]` 里把 B 拖到 A 前面实际移动的是保存的 A，可见顺序不变
// （PR #60 审查）。
const dragOrder = ref<string[]>([]);

// 只在持久化顺序或屏幕列表变化时同步。拖拽过程由库改写 dragOrder，这个 watch 不读
// dragOrder 作为依赖，因此不会把正在拖的顺序覆盖回去。
watch(
  () => [userData.tabs.order.join('|'), screensStore.sorted.value?.length ?? 0],
  () => {
    const next = userData.tabs.order.filter(id => getScreen(id) !== undefined);
    if (next.join('|') !== dragOrder.value.join('|')) {
      dragOrder.value = next;
    }
  },
  { immediate: true },
);

// 拖拽结果按 screen id 写回：只重排「仍在的屏幕」所占的槽位，已删除的 ID 保持原位，
// 既保住 append-only 的历史数据，也不会因为删过屏幕而错位。
watch(dragOrder, visible => {
  const before = userData.tabs.order;
  const merged = reconcileTabOrder(before, visible, id => getScreen(id) !== undefined);
  if (merged.join('|') !== before.join('|')) {
    userData.tabs.order = merged;
  }
});

// 政府管理视图是在「context=管理机构 id」下看同一批界面。标签页如果用纯
// `#screen=<id>` 跳转，会把 context 丢掉、直接从政府视图弹回公司上下文，
// 所以当前带 context 时要把 context 一起带上。
function screenHref(id: string) {
  return context.value ? `#/context=${context.value}&screen=${id}` : `#screen=${id}`;
}

const container = useTemplateRef('container');

onMounted(() => {
  container.value?.addEventListener(
    'wheel',
    e => {
      e.preventDefault();
      // 换行后横向可能仍有滚动（超长名字），纵向是两行封顶后的余量，两者都跟手。
      container.value?.scrollBy({
        left: e.deltaX,
        top: e.deltaY,
        behavior: 'smooth',
      });
    },
    { passive: false },
  );
});
</script>

<template>
  <div :class="$style.spacer" />
  <div ref="container" v-draggable="[dragOrder, { animation: 150 }]" :class="$style.container">
    <template v-for="id in dragOrder" :key="id">
      <a v-show="!userData.tabs.hidden.includes(id)" :href="screenHref(id)" :class="$style.item">
        <HeadItem :label="getScreen(id)?.name ?? ''" :active="current === getScreen(id)" />
      </a>
    </template>
  </div>
  <div :class="$style.spacer" />
</template>

<style module>
.spacer {
  display: inline-block;
  width: 5px;
}

.container {
  display: flex;
  /* 一行放不下就换行：窄窗口下不再横向裁掉看不见的标签。最多两行，
     再多只纵向滚动（不横滚），保证每个标签都能点到。 */
  flex-flow: row wrap;
  align-content: flex-start;
  align-items: stretch;
  flex: 1 1 auto;
  min-width: 50px;
  max-height: 54px;
  overflow-x: hidden;
  overflow-y: auto;
  scrollbar-width: thin;

  > .item {
    flex: 0 0 auto;
    height: 26px;
  }
}
</style>
