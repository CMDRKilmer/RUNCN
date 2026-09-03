# Screen Variables — 插件自研变量替换

## 背景

游戏原生 SCRN 界面提供「界面变量」机制：用户可以在屏幕上声明命名变量（如 `BS`，类型 `LOCATION`，值 `VH-331b`），其他 tile 的命令文本里用 `$BS` 引用它，变量值变化时游戏引擎自动重渲染引用它的 tile。

`UI_SCREENS_VARIABLES` 消息结构（来自 `prun-log.json`）：

```json
{
  "screenId": "4cc12190-c048-40cb-bf80-6162c4c3c48c",
  "variables": [{
    "id": "c538ceac6e64d663b642e62876858310",
    "type": "LOCATION",
    "name": "BS",
    "options": [],
    "value": { "lines": [<SYSTEM>, <PLANET>] }
  }]
}
```

该机制的能力与限制：
- ✅ 引擎内部完成变量值 → 引用 tile 的渲染同步，无需插件介入
- ❌ 变量值的**写入入口**完全隐藏在原生 `ScreenVariableControls__bar` UI 里
- ❌ 插件观察不到 `tile.parameter` 是否被引擎做变量替换（替换发生在 React 渲染管线内部）

## 目标

由插件自主实现一套「变量定义 + 写入 + 同步」机制，**逐步替代原生变量栏**：

1. 在 FLEET 基地行点击时，把当前选中的基地**直接写入**插件自维护的变量 `BS`，而不是去操作原生 `BS` 变量
2. 插件自渲染的 XIT 系列面板（含变量占位符 `$BS` 的）按当前变量值动态刷新
3. **可选**：若游戏客户端消息能驱动原生变量，则由插件代为同步原生 `BS`，让原生 tile 也吃到变更

## 非目标

- ❌ 不重写游戏 tile 渲染管线
- ❌ 不替换原生 `ScreenVariableControls__bar` 之前，先**保留**（先用 `display:none` 隐藏入口而非删除游戏状态里的变量），后续再视情况移除
- ❌ 第一版不实现复杂类型（仅 `LOCATION`，后续再扩展 `NUMBER` / `TEXT` / `ENUM`）

## 设计

### 1. 入口变更

`src/features/XIT/FLEET/PlanetRow.vue` 的基地行星列点击行为**改为写入插件自研变量**，不再操作原生输入框：

```ts
async function onPlanetClick() {
  // 优先级 1：当前聚焦的原生 AddressSelector → 静默填入
  const focused = getOpenAddressSelector();
  if (focused && (await selectAddress(focused, naturalId))) return;

  // 优先级 2：写入插件自研变量 BS（替代原生 BS）
  setScreenVariable('BS', naturalId);

  // 优先级 3：回退（若变量写入失败 / 用户禁用自研变量）
  showBuffer(`BS ${naturalId}`);
}
```

`getOpenAddressSelector` 与 `selectAddress` 沿用已有实现（见 `src/features/XIT/FLEET/PlanetRow.vue`、`src/infrastructure/prun-ui/utils/select-address.ts`）。

### 2. 变量存储

新建 `src/core/screen-variables.ts`：

```ts
// reactive store；name → 地址值（planet naturalId）
export const screenVariables = reactive<Record<string, string>>({});

export function setScreenVariable(name: string, value: string) {
  screenVariables[name] = value;
  // 触发订阅（reactive 已自动派发）
}

export function getScreenVariable(name: string): string | undefined {
  return screenVariables[name];
}
```

持久化：`@src/infrastructure/storage/user-data.ts` 中新增 `screenVariables` 字段，关页/重开后从 storage 恢复。

### 3. 同步给插件自己的 UI

新建 `src/features/XIT/screen-variable-substitute.tsx`（或类似位置），对所有插件自渲染的 XIT 面板做变量替换：

- 在 FLEET / BURN / PROD 等 XIT tile 渲染时，检查 `tile.parameter` 是否含 `$<name>` 形态
- 含 `$BS` 时，从 `screenVariables` 取值替换
- 变量值变化 → reactive 自动重渲染

### 4. 同步给原生 tile（可选 / 探查）

可行性未知，需要先验证：

- 是否存在类似 `SET_SCREEN_VARIABLE` 的客户端消息（`dispatchClientPrunMessage` 通道）
- 若游戏接受：插件在 `setScreenVariable` 后同时调用，让原生 `$BS` 引用同步刷新
- 若不接受：仅做 1~3 步，原生 tile 不同步（用户可手动在 SCRN 屏幕再设置一次 `BS`）

### 5. 顶部栏入口

在 `src/features/basic/screen-tab-bar/screen-tab-bar.tsx` 同源位置，新增一个「变量」按钮（齿轮图标后面），点击弹出变量管理面板（查看、切换、添加）。

## 阶段

| 阶段 | 内容 | 验证 |
|---|---|---|
| 1 | 隐藏原生 `ScreenVariableControls__bar`（`display:none`） | 原生 tile 用 `$BS` 引用仍能同步（游戏状态未变） |
| 2 | 实现 `screenVariables` store + 持久化 | 写入/读取正确，重启后值存在 |
| 3 | FLEET 点击基地 → 写入 `BS` 变量 | 插件自渲染 UI 中 `$BS` 占位符刷新 |
| 4 | 探查游戏是否接受写变量客户端消息 | 若接受则补充原生同步；若不接受则不补 |

## 风险

- **R1**：游戏原生变量栏即使被 `display:none` 隐藏，**插件也无法用 `dispatchClientPrunMessage` 驱动它的 input**（祖先节点不可聚焦时 react-autosuggest 不工作）。结论：自研变量方案**不依赖**这条路径
- **R2**：变量同步范围若仅限插件 UI 而不影响原生 tile，会导致 FLEET 基地选择与原生 `BS` tile 的实际数据脱节。需在阶段 4 探查后明确告知用户
- **R3**：`reactive` 对象在持久化/恢复时需做 JSON 序列化校验，避免旧数据残留导致运行时报错
