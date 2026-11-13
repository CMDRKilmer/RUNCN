<script setup lang="ts">
import HeadItem from './HeadItem.vue';
import { context, screensStore } from '@src/infrastructure/prun-api/data/screens';
import { userData } from '@src/store/user-data';
import { vDraggable } from 'vue-draggable-plus';
import { syncState } from '@src/features/basic/screen-tab-bar/sync';
import { useTemplateRef } from 'vue';

watchEffect(syncState);

const current = computed(() => screensStore.current.value);

function getScreen(id: string) {
  return screensStore.getById(id);
}

// 顺序清单是持久化数据，只追加不删除（见 sync.ts）。已被删除的屏幕可能还留在
// 清单里，渲染时按 store 过滤掉，避免出现空白标签页。
const tabs = computed(() => userData.tabs.order.filter(id => getScreen(id) !== undefined));

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
  <div
    ref="container"
    v-draggable="[userData.tabs.order, { animation: 150 }]"
    :class="$style.container">
    <template v-for="id in tabs" :key="id">
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
