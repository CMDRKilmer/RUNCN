import { onApiMessage } from '@src/infrastructure/prun-api/data/api-messages';

// 会在 UI 之前初始化，因此不需要 undefined 或回退值。
export const userDataStore = shallowReactive<PrunApi.UserData>({} as PrunApi.UserData);

export const companyContextId = computed(
  () => userDataStore.contexts?.find(x => x.type === 'COMPANY')?.id,
);

// 用户参与的**全部**上下文（公司 + 政府）：游戏 URL 里的 `context=` 就是这里的
// 某个 id。政府管理视图把 context 设成管理机构的 id，与公司上下文共用同一条
// socket、推的是同一批账号数据，所以不能因为它和公司 id 不同就丢消息。
export const userContextIds = computed(
  () => new Set((userDataStore.contexts ?? []).map(x => x.id)),
);

onApiMessage({
  USER_DATA(data: PrunApi.UserData) {
    Object.assign(userDataStore, data);
  },
});
