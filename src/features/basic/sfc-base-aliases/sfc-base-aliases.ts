// SFC 目的地输入框：把玩家设置的基地别名替换为行星 naturalId，
// 让 PrUn 原生的 AddressSelector 服务端搜索能命中对应基地。
//
// 替换时机：在 AddressSelector 输入框的 value 变化后（rAF 轮询，
// 不抢 React 的 input 事件，避免和受控组件打架）；
// 替换方式：调用 util.changeInputValue 走 React 的 setter+事件路径，
// 与 selectAddress 的写法一致。

import { changeInputValue, focusElement } from '@src/util';
import { refValue } from '@src/utils/reactive-dom';
import { resolveBaseAliasOrNaturalId } from '@src/core/base-aliases';
import { userData } from '@src/store/user-data';
import { watchEffectWhileNodeAlive } from '@src/utils/watch';

function getAddressInput(container: Element) {
  return _$(container, C.AddressSelector.input) as HTMLInputElement | undefined;
}

function replaceAlias(input: HTMLInputElement) {
  const raw = input.value;
  if (!raw || !raw.trim()) {
    return;
  }
  // 仅当当前输入"完全等于"某个别名时才替换。
  // 子串匹配（例如正在输入「my」）不要替换，否则会干扰正常打字。
  const trimmed = raw.trim();
  const lower = trimmed.toLowerCase();
  let aliasMatch = false;
  for (const alias of Object.values(userData.baseAliases)) {
    if (alias.toLowerCase() === lower) {
      aliasMatch = true;
      break;
    }
  }
  if (!aliasMatch) {
    return;
  }
  const naturalId = resolveBaseAliasOrNaturalId(trimmed);
  if (!naturalId || naturalId === trimmed) {
    return;
  }
  focusElement(input);
  changeInputValue(input, naturalId);
}

function attachInputWatcher(container: Element) {
  const input = getAddressInput(container);
  if (!input) {
    return;
  }
  // rAF 轮询 value：React 受控组件把 input.value 视为派生状态，
  // 直接监听 input 事件会和 React 的 onChange 抢着触发，反而卡死。
  // 轮询在值稳定后再做替换，避免打字中途被吞。
  let lastSeen = input.value;
  const valueRef = refValue(input);
  watchEffectWhileNodeAlive(input, () => {
    const next = valueRef.value;
    if (next !== lastSeen) {
      lastSeen = next;
      replaceAlias(input);
    }
  });
}

function onTileReady(tile: PrunTile) {
  subscribe($$(tile.anchor, C.AddressSelector.container), attachInputWatcher);
}

function init() {
  tiles.observe('SFC', onTileReady);
}

features.add(import.meta.url, init, 'SFC：输入基地别名时自动替换为对应 naturalId，以便定位基地。');
