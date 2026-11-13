import { userData } from '@src/store/user-data';
import { App, Plugin } from 'vue';
import { deepFreeze } from '@src/utils/deep-freeze';
import { tilesStore } from '@src/infrastructure/prun-api/data/tiles';
import { context } from '@src/infrastructure/prun-api/data/screens';
import { companyContextId } from '@src/infrastructure/prun-api/data/user-data';

type TileState = UserData.TileState;

export function initializeTileListener() {
  pruneTileStates();
  tilesStore.listener = {
    tilesInitialized() {
      pruneTileStates();
    },
    tileMoved(fromId: string, toId: string) {
      moveTileState(fromId, toId);
    },
    tileRemoved(id: string) {
      removeTileState(id);
    },
  };
}

// 政府管理视图（URL 的 context= 是管理机构 id，且玩家兼任州长时该 id 属于用户
// 自有上下文）属于「外来上下文」：这里的 UI_DATA 只带政府的磁贴，整表替换后
// tilesStore 里只剩政府磁贴。见 pruneTileStates 里的说明。
function isForeignContext() {
  const urlContext = context.value;
  const company = companyContextId.value;
  return urlContext !== undefined && company !== undefined && urlContext !== company;
}

function pruneTileStates() {
  // 政府管理视图下，UI_DATA 整表替换让 tilesStore 只剩政府磁贴。此时跑裁剪会把
  // 公司磁贴（按数字 id 存于 userData.tileState 的 XIT 设置、库存标记等）当成
  // 「不存在」删掉并持久化，回公司视图就再也找不回。外来上下文的整表替换并不
  // 代表公司磁贴真的消失，所以这种时候直接跳过裁剪，保留公司 tile state
  // （PR #60 审查 #219）。
  if (isForeignContext()) {
    return;
  }
  const tiles = tilesStore.entities.value;
  if (!tiles) {
    return;
  }
  for (const key of Object.keys(userData.tileState)) {
    if (!(key in tiles)) {
      removeTileState(key);
    }
  }
}

function removeTileState(id: string) {
  delete userData.tileState[id];
}

function moveTileState(fromId: string, toId: string) {
  if (userData.tileState[fromId]) {
    userData.tileState[toId] = userData.tileState[fromId];
    removeTileState(fromId);
  }
}

export function getTileState<T extends TileState>(tileOrId: PrunTile | string) {
  const id = typeof tileOrId === 'string' ? tileOrId : tileOrId.id;
  let state = userData.tileState[id];
  let isAdded = state !== undefined;
  if (!state) {
    state = reactive({});
  }
  const isPersistent = isNaN(Number(id));
  if (isPersistent) {
    watch(
      state,
      () => {
        const hasKeys = Object.keys(state).length > 0;
        if (hasKeys && !isAdded) {
          userData.tileState[id] = state;
          isAdded = true;
        }
        if (!hasKeys && isAdded) {
          delete userData.tileState[id];
          isAdded = false;
        }
      },
      { deep: true },
    );
  }
  return state as T;
}

const baseTileStateKey = Symbol() as InjectionKey<Ref<TileState>>;

export function tileStateKey<T extends TileState>() {
  return baseTileStateKey as InjectionKey<Ref<T>>;
}

export const tileStatePlugin: Plugin = {
  install: (app: App, options: { tile: PrunTile | string }) => {
    app.provide(
      tileStateKey(),
      computed(() => getTileState(options.tile)),
    );
  },
};

export function createTileStateHook<T extends TileState>(defaultState: T) {
  deepFreeze(defaultState);
  return function useTileState<K extends keyof T>(key: K) {
    const state = inject(tileStateKey<T>())!;
    return computedTileState(state, key, defaultState[key]);
  };
}

export function useTileState<T>(key: string, defaultValue: T): WritableComputedRef<T> {
  const state = inject(tileStateKey())!;
  return computedTileState(state, key, defaultValue) as WritableComputedRef<T>;
}

export function computedTileState<T extends TileState, K extends keyof T>(
  state: Ref<T>,
  key: K,
  defaultValue: T[K],
) {
  return computed({
    get: () => {
      // 触发属性以触发响应式更新
      const value = state.value[key];
      return Object.hasOwn(state.value, key) ? value : defaultValue;
    },
    set: value => {
      if (
        typeof value === 'object' &&
        !Array.isArray(value) &&
        Object.keys(value as object).length === 0
      ) {
        // 空对象视为未设置（避免持久化无意义数据）。
        delete state.value[key];
        return;
      }
      if (value === defaultValue) {
        delete state.value[key];
        return;
      }
      state.value[key] = value!;
    },
  });
}
