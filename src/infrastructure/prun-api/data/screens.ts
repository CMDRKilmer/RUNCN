import { onApiMessage } from '@src/infrastructure/prun-api/data/api-messages';
import { createEntityStore } from '@src/infrastructure/prun-api/data/create-entity-store';
import { companyContextId } from '@src/infrastructure/prun-api/data/user-data';

const store = createEntityStore<PrunApi.Screen>();
const state = store.state;

const removed = shallowReactive([] as PrunApi.Screen[]);

// 政府管理视图（URL 带 `context=<管理机构 id>`）下，UI_DATA 只带当前视图的
// 屏幕（实测 1 条）。整表替换会让标签栏只剩一条，并连带把 userData 里记录的
// 屏幕顺序与隐藏清单当成「已删除」清空 —— 特征就是切一次视图后所有标签全冒
// 出来。已有公司数据时，外来上下文的整表替换一律忽略。
function isForeignContext() {
  const urlContext = context.value;
  const company = companyContextId.value;
  return urlContext !== undefined && company !== undefined && urlContext !== company;
}

onApiMessage({
  UI_DATA(data: PrunApi.UIData) {
    const hasCompanyScreens = (state.all.value?.length ?? 0) > 0;
    if (hasCompanyScreens && isForeignContext()) {
      store.setFetched();
      return;
    }
    store.setAll(data.screens);
    removed.length = 0;
    removed.push(...data.removedScreens);
    store.setFetched();
  },
  UI_SCREENS_ADD(data: PrunApi.Screen) {
    store.addOne(data);
  },
  UI_SCREENS_RENAME(data: { id: string; name: string }) {
    const screen = state.getById(data.id);
    if (screen !== undefined) {
      store.setOne({
        ...screen,
        name: data.name,
      });
    }
  },
  UI_SCREENS_DELETE(data: { id: string }) {
    const screen = state.getById(data.id);
    if (!screen) {
      return;
    }
    store.removeOne(data.id);
    removed.unshift(screen);
  },
  UI_SCREENS_UNDELETE() {
    const screen = removed.shift();
    if (!screen) {
      return;
    }
    store.addOne(screen);
  },
});

export const screenHash = ref(undefined as string | undefined);
export const context = ref(undefined as string | undefined);

function updateCurrent() {
  screenHash.value = location.hash.match(/screen=([^&]*)/)?.[1];
  context.value = location.hash.match(/context=([^&]*)/)?.[1];
}

updateCurrent();

window.addEventListener('locationchange', updateCurrent);
window.addEventListener('hashchange', updateCurrent);

const sorted = computed(() =>
  state.all.value
    ?.filter(x => !x.hidden)
    .sort((a, b) => (a.name === b.name ? 0 : a.name < b.name ? -1 : 1)),
);

const current = computed(
  () => sorted.value?.find(x => x.id === screenHash.value) ?? sorted.value?.[0],
);

export const screensStore = {
  ...state,
  sorted,
  current,
};
