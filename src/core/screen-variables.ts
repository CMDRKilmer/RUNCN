import { reactive, watch } from 'vue';
import { userData } from '@src/store/user-data';

// 插件自维护的屏幕变量。
// name -> 变量值(第一版仅 LOCATION,即星球/空间站 naturalId)。
// 与游戏原生 ScreenVariableControls__bar 共存:写入此 store 会驱动原生 tile 同步(通过
// 直接调用原生 BS input),原生 tile 也会反向刷新此 store(在 UI_SCREENS_VARIABLES 推送后)。
export const screenVariables = reactive<Record<string, string>>({});

// 初始化:从 userData 恢复(user-data.ts 中声明的 screenVariables 字段)。
function loadFromUserData() {
  const stored = userData.screenVariables;
  if (stored === undefined || stored === null || typeof stored !== 'object') {
    return;
  }
  for (const name of Object.keys(stored)) {
    const value = stored[name];
    if (typeof value === 'string' && value.length > 0) {
      screenVariables[name] = value;
    }
  }
}

loadFromUserData();

// 反向持久化:store 变化时写回 userData(自动同步到 chrome.storage.local)。
// 按 key 写入而非全量 spread,扩展到 NUMBER/TEXT/ENUM 多变量时无需重写。
watch(
  screenVariables,
  (next, prev) => {
    for (const name of Object.keys(next)) {
      if (next[name] !== prev[name]) {
        userData.screenVariables[name] = next[name];
      }
    }
    for (const name of Object.keys(prev)) {
      if (!(name in next)) {
        delete userData.screenVariables[name];
      }
    }
  },
  { deep: true },
);

export function setScreenVariable(name: string, value: string) {
  screenVariables[name] = value;
}

export function getScreenVariable(name: string): string | undefined {
  return screenVariables[name];
}
