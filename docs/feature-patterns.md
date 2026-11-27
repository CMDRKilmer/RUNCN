# Feature Patterns

## Feature types

- **Basic** (`src/features/basic/`): enhances UI without removing information. Loaded for all users.
- **Advanced** (`src/features/advanced/`): removes, shortens, or hides information. Loaded for user that turned on FULL feature mode.

## Adding a Feature

Each feature is a self-contained `.ts` or `.tsx` file registered at the end:

```ts
function init() {
  tiles.observe('BBL', onTileReady);
}

features.add(import.meta.url, init, 'BBL: Short description of what this does.');
```

- `import.meta.url` → the filename (without extension) becomes the feature ID.
- Then import the file in `src/features/basic/index.ts` or `src/features/advanced/index.ts`.

### Naming

If a feature targets a specific buffer command, prefix the feature ID and mention it in the description:

```ts
// Feature file: src/features/basic/sysi-blue-negative-value.ts
features.add(import.meta.url, init, 'SYSI: Makes lower negative planet values blue instead of red.');
```

If a feature touches more than one command, don't prefix with a single command name.

```ts
// Bad: feature affects PROD, PRODQ, and PRODCO
features.add(import.meta.url, init, 'PROD: Highlights orders with errors.');

// Good
features.add(import.meta.url, init, 'Highlights production orders with errors.');
```

### File Organization

If a feature has more than a `.ts` + `.module.css` pair, create a folder for it.

Vue component filenames must match the import name:

```ts
// If you write: import ContextRow from './ContextRow.vue';
// The file MUST be: ContextRow.vue (not my-feature.vue)
```

### Parameter Checks

If a tile command can't be opened without a parameter (like `PRODQ`), don't guard against missing parameters.

```ts
// Bad (PRODQ always has a parameter)
if (!tile.parameter) {
  return;
}

// Just use tile.parameter directly
```

## Adding an XIT Command

XIT commands are custom in-game panels opened via the `XIT` buffer. Register in a `.ts` file.

User-facing `name` and `description` strings are written in Chinese (see existing commands in `src/features/XIT/`).

```ts
xit.add({
  command: ['CMD', 'CMDALIAS'],  // one or more
  name: '面板标题',                // or (params) => string for dynamic title
  description: '面板功能描述。',
  mandatoryParameters: 'PARAM1',  // optional
  optionalParameters: 'PARAM2',   // optional
  component: params => MyVue,     // Vue component factory; params is string[]
  bufferSize: [600, 400],         // optional default window size [w, h]
  contextItems: params => [{ cmd: 'XIT OTHER', label: 'Link' }],  // optional
});
```

Then import the file in `src/features/XIT/index.ts`.

The command should be short. Refer to `docs/game/commands.csv` for an example of game commands. Alias is usually added for backwards compatibility or if the community REALLY wants it.

### Tile State Persistence

`tileStatePlugin` binds each XIT component to `getTileState(tile)`, keyed by the tile's numeric ID. Numeric IDs are **non-persistent** — pruned when the tile closes. Named string keys (e.g., `getTileState('my-workspace')`) **are** persistent.

To pass data between XIT commands (e.g., a list view opening an editor), use a named workspace key as a transfer buffer:

1. **Sender** writes data to `getTileState('my-workspace')`, then calls `showBuffer()`.
2. **Receiver** checks the workspace on setup, copies data into its own tile state via `useTileState`, then clears the workspace.

The receiver's `useTileState` reads from its own tile ID (injected by the plugin), **not** from the named key. You must explicitly consume and clear the workspace.

Non-Vue basic features (e.g., a feature that builds a DOM panel via `tiles.observe`) can't use `useTileState`. They read the workspace directly via `getTileState('my-workspace')` on panel mount, copy the value into the panel's local DOM (textarea, input, etc.), then `delete` the workspace key — same consume-and-clear contract, just without the Vue composable.

For multi-select lists (e.g., picking bases for a route), store an ID array in tile state with `undefined` meaning "default: all selected" — new items stay selected until the user saves an explicit selection. Render each toggle with `RadioItem` used as a checkbox: pass `:model-value` plus `@update:model-value` (RadioItem flips and emits the boolean itself; no `v-model` needed).

---

## Auto-Imports (no explicit import needed)

| Symbol | Source |
| -------- | -------- |
| Vue composables (`ref`, `computed`, `reactive`, `watch`, …) | `vue` |
| `$`, `$$`, `_$`, `_$$` | `@src/utils/select-dom` |
| `C` | `@src/infrastructure/prun-ui/prun-css` |
| `subscribe` | `@src/utils/subscribe-async-generator` |
| `tiles` | `@src/infrastructure/prun-ui/tiles` |
| `features` | `@src/features/feature-registry` |
| `xit` | `@src/features/XIT/xit-registry` |
| `config` | `@src/infrastructure/shell/config` |
| `createFragmentApp` | `@src/utils/vue-fragment-app` |
| `applyCssRule` | `@src/infrastructure/prun-ui/refined-prun-css` |

---

## `C` Object

`C` maps all PrUn CSS class names with auto-complete. Always prefer `C` over hardcoded hashed class names — hashes change between game updates.

```typescript
// Bad: brittle
applyCssRule('.Frame__logo___qu6xPzo', $style.logo);

// Good: robust
applyCssRule(`.${C.Frame.logo}`, $style.logo);
```

### Known limitations

- `C.ColoredValue` only exposes `.positive` and `.negative`. There is no `.danger`/`.warning`. For three-tier color coding (red/orange/green), fall back to inline `style` on the element: `style="color: #d9534f"` (red), `style="color: #f0ad4e"` (orange), `style="color: #5cb85c"` (green).
- `C.Select` does not exist. For `<select>` elements in Vue templates, use a plain `<select>` (no class binding) or define a local `style module` class. `SelectInput.vue` is the reusable option if you need a styled wrapper.

---

## Automating PrUn Inputs (React Controlled Components)

PrUn ships a React bundle from its CDN. Its React-Autowhatever wrappers (AddressSelector, MaterialSelector) and most form `<input>`/`<select>` elements are **React controlled**. To set their values from an extension:

### Value-setting recipe

```ts
import { changeInputValue } from '@src/util';

// 1. Focus first so React-Autowhatever opens the listbox.
input.focus();
await sleep(50);
// 2. Set value through the native prototype setter (bypasses React's
//    per-instance override) and dispatch the same events React's
//    onChange listens for. Do NOT add `beforeinput` — it suppresses
//    AddressSelector's server search.
changeInputValue(input, value);
// 3. Wait for the search to actually return before picking: for an
//    AddressSelector the pacing factor is the server round-trip —
//    wait for a listbox item matching the search term rather than a
//    fixed 500ms sleep (fast searches shouldn't waste time, slow
//    ones shouldn't race into clicking a stale suggestion). See
//    fillAddress in src/features/basic/contd-auto-fill.ts.
// 4. Click the listbox item using the NATIVE .click() (not a full
//    pointer/mouse event sequence). React-Autowhatever's
//    onSuggestionSelected listens for the trusted click that
//    HTMLElement.click() synthesizes. Synthetic dispatchEvent
//    sequences are filtered out.
await selectListboxItem(input, value);
```

Prefer adaptive waits over fixed sleeps: fixed sleeps both waste time on fast connections and race slow ones. The real completion signals are the listbox portal unmounting (react-autosuggest removes it on selection) or the input value being replaced by the committed suggestion. `selectListboxItem` in `src/features/basic/contd-auto-fill.ts` waits for either and throws a clear error on timeout instead of silently continuing with an uncommitted value.

### Click recipe

```ts
// Good — triggers React-Autowhatever onSuggestionSelected reliably.
target.click();

// Bad — dispatches full pointer/mouse sequence. Often results in the
// listbox item being hovered/highlighted but never selected, so
// onSuggestionSelected never fires and PrUn's modal-close drops the
// value silently.
await clickElement(target);
```

### Wait for the target to appear before clicking

Buttons/inputs that only render after async data loads (e.g. the SFC 指令表单「开始」button appears once a destination resolves) must be awaited via the `$` gate before judging their state — a sync `_$` lookup silently returns `undefined`/stale state if the node hasn't rendered yet.

```ts
// Blocks until the button actually renders, then judge.
const command = await $(tile.anchor, C.FormComponent.containerCommand);
const button = await $(command, C.Button.success);
if (button.classList.contains(C.Button.disabled)) {
  return; // not ready (e.g. no destination set)
}
```

Actions that trigger server communication (clicking SFC「开始」launches the flight) must stay behind a reserved interface defaulting to OFF — the player has to opt in (ToS).

### Why this matters

PrUn's modal dialogs (template selection, contract conditions) read their state from PrUn's React state tree at the moment their `应用` / `保存` button is clicked. If `onSuggestionSelected` never fired, the value visible in `input.value` is just a DOM mirror — the React state stays empty, and the modal-close drops the value. The `_valueTracker` reset + native setter + clickElement chain we tried first did populate `input.value` but never reached React state.

### Selecting from listbox

See `selectListboxItem` in `src/features/basic/contd-auto-fill.ts` for a working universal selector that handles both flat MaterialSelector lists and nested AddressSelector sections.

建议列表可能被渲染到 tile/窗口之外的 portal（26.11.11 起为避免被窗口裁剪）。tile 内的 `C.MaterialSelector.suggestionsList` 查不到时，按输入框 `aria-controls` → 文档级 `[role="listbox"]` → `[class*="suggestionsList"]` 定位，条目按可见文本（ticker、`<TICKER> 名称` 或本地化名称）匹配（参考 `mtra-common.ts` 的 `findSuggestionsList` / `findSuggestionEntry`）。

Only one listbox can be open at a time — react-autosuggest closes the focused input's listbox when another input takes focus, so listbox interactions in a multi-row form must run one row at a time. Plain value writes (amount, price) are safe to run in parallel, but a write can land on a node React swapped under a concurrent re-render. Follow parallel writes with a sequential verify-and-fixup pass that re-writes mismatches, so races become retries instead of silent corruption — see the two-wave fill in `contd-auto-fill.ts`.

### CXPO 卖出表单（挂单 vs 填单）

CXPO 表单即交易所下单表单：`form.children[7]` 数量输入、`children[8]` 价格输入、`children[12]` 按钮区（买入 `C.Button.success`，卖出 `C.Button.danger`）。卖出按钮必须限定在按钮区内查找（`children.item(12)` 内 `_$`），避免全局误点买入。

挂单与填单是同一张表单，区别只在价格：
- **挂单（LIMIT）**：按指定价（或卖一价）下单，订单挂盘等待成交，CX 仓库数量**不变**。
- **填单（FILL）**：按买一价下单，立即吃买单成交，CX 仓库数量**下降**（成交后等仓库更新）。

参考实现：`CXPO_SELL`（`action-steps/CXPO_SELL.ts`）执行时从实时订单簿定价；`CXOS` 压价重挂用同一按钮定位。

### SFC 滑块自动化与离屏窗口（FTC 参数扫描）

**当前 XIT FTC 面板**使用 `FlightCalculator.vue` → `formula-options.ts` → `infrastructure/fio/flight-formula.ts` 的新公式。默认蓝图模式，也可读取停靠船的载重、船况和油量。支持指定档位及全档位平衡方案，展示分段时间、两类耗油和余油；采集工具折叠保留。缺少任务 UUID 时，着陆按停泊高度中值估算并标注。面板计算不发布 SFC 滑块。**SFC 联动与 FLEET 现在也走同一套公式模型**（2026-11-17）：`formula-plan.ts` 是后台入口（停靠船 + 起终点 + 油量/载重 + 时刻 → 方案，输入来自 store：ships / blueprints / orbit / routes / planet-environment），它只调用 `calculateFormulaOptions`，因此面板与后台不会出现两套口径。

- **SFC 写滑块**：`sfc-auto-fuel-settings` → `formula-compute.computeFormulaFtcPlan`（旧 `ftc-compute.computeFtcPlan` 已不再被调用）。契约不变：按航线键 `ftcRouteKey(船|起点|终点|gw|nat)` 写 `ftc-fuel-settings` 的燃料/反应堆参数并置 `lastFtcCompute`（`waitForFtcCompute`/DEPART 等待的同一个信号）；`publish: false` 的假设性计算既不写参数也不写完成信号。**判缺口径变了**：不再看服务器原生 STL 段记录，而是看**蓝图/轨道/环境/星图**是否够算 —— `formula-plan` 抛错或返回 `inputIncomplete` 时一个参数都不写，SFC 沿用玩家当前设置。蓝图未加载时按旧口径**最多等 6 s**（`blueprintsStore` 首次访问会触发 BLU 请求；失败后按蓝图 id 记 60 s 负缓存，避免 FLEET 逐段白等），且推送门的几何签名里加了「已加载蓝图数」，蓝图到达后签名变化 → 自动重算（否则那条航线会被「同签名已算过」永久抑制）。端点解析在 `formula-endpoint.ts`（按 naturalId 缓存，SFC 与 FLEET 会对同一批起终点反复调用）：先直接解析；解析不到具体天体/空间站时，把 **SFC 规范化后的星系 id**（如 VH-331）反推成该星系唯一空间站（HRT）再解析；同星系多站或无法唯一反查时直接报错并列候选（绝不猜）。回归：`scripts/verify-formula-endpoint.mjs`（8 条）。
- **FLEET 环线时长**：`chain-flight-time` 每段直接取 `planFormulaFlight(...).best.totalHours`（选点口径 = 成本最优 / Pareto 平衡点，与该段设没设时间价值一致），逐段累加起飞时刻。**逐段状态按公式口径递推**：每段把该段离站载重（`legPayloads`，来自计划的 `loadOnDeparture` / `loadOnReturn`）与上一段到达后的剩余油量传给模型；出发油量默认取罐容量（环线在出发地补满，`refuelAtOrigin: false` 可改回当前余量）。输入残缺时 `leg.ok = false` + `leg.missingInputs`（成因全文）+ `leg.error = '缺规划输入'`，绝不写成「0 小时且 ok」。旧的 `approximated`（均值圆弧/反方向记录的公式估算）与 `approximatedLegs` 已删除：新模型自带轨道几何，链上不再有第三种几何来源。
- **FLEET 原生 RT 航点档位**：`planFormulaFlight(..., selection: 'value')` 扫描可写入的整数档位，从 STL 和 FTL 余量都足够的档位中选性价比。明确缺油时中止创建。单趟 RT 只在公式缺输入时回退到 BTF 试飞。循环 RT 估时按网关偏好、逐段计划载重、出发时刻和余油计算，向导直接沿用同一份档位和油耗结果生成 RT 与备货包。
- **节油 STL 混合路径**：共用公式支持网关—自然和自然—网关两组路径。自然—网关的自然进近与末段长转移预留按节油引擎流量相对标准流量缩放。循环 RT 仍由公式估时。
- **网关首/末段（端点是行星）**：原生 SFC 实测 `HRT → OF-375b`（`useGateways: true`、最少跳数、f=0.05、着陆）给的是 **7 段纯网关**航线：`TRANSIT HRT→VH-331a 23845.495 km/178 u` → `TRANSIT 10 km/15 u` → `LOCK 10 min/5 u` → `JUMP_GATEWAY 19.1327 pc/0 油` → `DECAY 10 min/5 u` → `TRANSIT 10 km/15 u` → `LANDING 4.207 km/24 u`。关键点：网关 `GTW-MWD-607` 就绕着目标行星 OF-375b，**到达网关即到达目标天体**，所以没有「网关母星 → 目标行星」的额外转移段。模型据此改口径：网关母星与起点/终点是**同一颗天体**时，该端 STL 转移整段不存在、预算归零（`stationGatewayFuelBudget(..., transferCount)` 的段数参数），`selectFormulaRoute` 也不再剔除落在行星端点的网关腿（旧的「网关端点目前支持空间站」报错已删除）。仍未经盲测的部分会在 warning 里点名（「网关段位于航线首/末段且端点是行星」）。回归：`scripts/verify-formula-gateway-endpoint.mjs`（4 条：网关母星==目标/!=目标、母星==出发行星、站到站回归）。
- **油量读取**：`shipFuelRemainingFor` 已抽到 `FTC/ship-fuel.ts`（旧 `ftc-compute` 原样 re-export），公式链路不必再 import 旧编排模块。
- **燃料单价**：`FTC/fuel-prices.ts` 从 **FIO** 读取四大市场（AI1／CI1／IC1／NC1）报价并取简单平均：每市场先取 FIO 的 `PriceAverage`，缺失回退买一 `Ask`、再回退卖一 `Bid`；只统计有报价的市场，各市场货币 **1:1 不换汇**（与 BPC/BMAT/GOVH 同口径）。数据源是 `https://rest.fnar.net/exchange/all`（一次约 380 KB，过滤 SF／FF × 四市场），会话内缓存 10 分钟、并发合并成一次请求，失败时保留上一次结果并记录错误。面板**不再提供手填单价**：单价始终取该均价，取不到时成本列显示「未计价」；「重读 FIO 均价」强制刷新。回归：`scripts/verify-fuel-average.mjs`（6 条：均价/回退链/过滤/缓存/失败保留/并发合并）。
- **网关运行时加载**：`XIT FTC` 打开时复用已入库的连接，缺数据则发与原生星图相同的 `DATA_GET_DATA{path:['gateways']}`。勾选网关的计算和跨星系试飞共用进行中的请求，拿到连接后才读取公式输入或导出试飞快照。超时或 socket 未就绪时返回失败。手动「网关」和「导出网关」按钮可跳过冷却重试。加载器不打开星图窗口，不轮询服务器。SFC 和 FLEET 只读取已有连接。回归见 `scripts/verify-gateway-loader.mjs`。
- **勾了网关却按自然跃迁算**：`predictFormulaFlight` 在 `useGateways && route 无网关段` 时给**一条**成因 warning：①本地没有网关连接数据（提示重试/刷新页面）；②否则按当前跃迁偏好（`ftlPreference`）自然航线更优/不需要网关。这样玩家不会误以为网关生效了。
- **回归**：`scripts/verify-sfc-formula-plan.mjs`（6 条：写参数/判缺不写/publish=false/同点空输入/网关键隔离）、`scripts/verify-chain-flight-time.mjs`（7 条，已按新契约重写）、`scripts/verify-native-route-settings.mjs`（12 条，替身改为 `formula-plan`）。

- **旧口径提示**：本节后面用 `####` 标出的「旧 FTC 口径」小节，只记录 `fuel-model.ts`／`route-planner.ts`／`computeFtcPlan` 自身的标定与已知局限（这些模块仍服务 BTF 采集、FTC 面板的导出按钮与 `verify-ftc-*.mjs`），**不是** FTC 面板、SFC 或 FLEET 的预测口径——当前口径见上文各条与 `docs/game/game-concepts.md`。

- rc-slider 滑块（SFC「燃料消耗/反应堆使用量」）用共享工具 `setSliderValue`（`src/infrastructure/prun-ui/utils/set-slider-value.ts`）写入。后台自动设置滑块的功能（如 `sfc-auto-fuel-settings`）与主动扫描（FTC）会互相覆盖参数——写入前先 `reserveTile(tile.anchor)` 独占，结束时 `releaseTile`；后台功能用 `isTileReserved` 跳过被独占的 tile。
- 滑块写入依赖 `getBoundingClientRect` 计算百分比坐标：离屏自动化窗口必须用 `transform: translate(-200vw, -200vh)` 移出屏幕，**不能**用 `display:none`（矩形为 0，写入永远失败）。
- 只填目的地/滑块、不点「开始」时，服务器仍会重算并下发 `SHIP_FLIGHT_MISSION`——用 `getPrunId` 从 `C.MissionPlan.table` 拿 mission id，再从 `flightPlansStore` 读精确计划（时长/燃料/损伤），无需自行建模。以 `C.MissionPlan.stats` 文本内容变化作为「重算完成」信号。
- `SHIP_FLIGHT_MISSION` 的 TRANSIT 段 `transferEllipse.startPosition/targetPosition` 是出发/目标天体在出发/到达时刻的**绝对坐标**（带时间戳的观测）；MS 星系地图**不**下发行星绝对坐标（行星按轨道根数渲染）。飞行计划首段 `departure.timestamp - Date.now()` 可标定游戏世界时钟偏差。

#### 旧 FTC 口径：`fuel-model.ts` / `route-planner.ts` / `computeFtcPlan`（已停用，仅供追溯）

旧链路 `computeFtcPlan`（`ftc-compute.ts`）已没有界面调用方：FTC 面板走 `FlightCalculator.vue`，SFC 与 FLEET 走 `formula-plan.ts`。`fuel-model.ts`、`route-planner.ts`、`transfer-geometry.ts` 仍留在树里，供 `native-route-btf` / `native-route-fuel` 的 BTF 采集、FTC 面板的导出按钮（`exportStlSegments()`、空间站轨道）与 `verify-ftc-*.mjs` 使用；`stlSegmentsStore` 的各类计数还留在 `sfc-auto-fuel-settings.geometrySignature()` 的推送门签名里。以下记录的是这些模块自己的标定与已知局限，**不构成**当前预测口径。

- **转移段燃料 = 罐口径**：`0.98 × 罐 × min(f, 0.5)`（= 两段 `0.49 × 罐 × f`，进近另 `+ 8`），与距离、载重无关，f ≥ 0.5 饱和；BTF 28 点最大误差 3.3%。`C_F×f×d` 口径被证伪（同航线罐 1500 高 10.0×）。
- **转移段时长 = 参考速度 × 质量幂律 × 引擎 f 曲线**：`v = 27,512 × (1,271 / 质量_t)^0.78 × (min(f,0.5)/0.5)^fExp ÷ (0.05/0.5)^fExp` km/s（标准引擎 fExp=0.84、节油 0.59，f ≥ 0.5 饱和）。27,512 不是船无关常数：同距离 2,727 t 实测 15,186 vs 模型 15,168 km/s。
- **几何来源**：`system-bodies` 的 `stlSegmentsStore` 四张表（离港 / 进近 / 同星系 `transit` / 航线级 `routeRecords`；网关键加 `#gw`，网关禁用通配回退）。`routeMetrics()` 首选航线级记录，取不到才退回 `departKm + approachKm` 或 `transitKm`；记录缺失即 `missingModelInputs()` 判缺、`computeFtcPlan` 一个参数都不写。持久化 `rprun.ftc.stl-segments.v1`。
- **转移段距离不是航线常数**：同航线同船同 f 的点间漂移 <1%，且大于两体轨道半径之和（是转移弧长，不是两点直线）；记录没有时间戳，无法追溯某个值属于哪份计划。
- **速度查询表自愈**：`public/json/transit-speed-table.json` 的 aEff 覆盖极窄，质量比不同的船会被 `stlTransitTableReliableFor` 判「超出可靠范围」。BTF 试飞把每条 OK 计划的 TRANSIT 段写成 `(q, aEff, v)` 样本（`q = 0.98 × 罐 × min(f, 0.5)`，速度除以 `conditionFactor` 还原健康船速度），落盘 `rprun.ftc.transit-samples.v1`（`addTransitSpeedSample` / `restoreTransitSpeedSamples`）。
- **星系 id 反查**：SFC 地址框把空间站目的地规范化成所属星系 id，服务器记录按实际天体/空间站 id 键控 → 查表前用 `route-model.lookupStationInSystem()` 反查；合并运行时 `stationsStore` 后恰好 1 个候选才反查，0 个或 ≥2 个一律拒绝（回归 `scripts/verify-ftc-station-reverse.mjs`）。
- **罐容量读数存疑（未修）**：旧面板读的是蓝图 `performance.stlFuelCapacity`，实船油罐容量在 `storagesStore`（`ship-fuel.shipFuelRemainingFor().stlCap`）。罐是乘性因子，不影响选出的最优 f，但影响燃料总量显示与缺口判断。
- **基线数据已清理**：`btf-*` / `grid-*` / `matrix-*` 与 `data/ftc-calibration/` 已移出仓库（可从 git 历史取回）；拟合脚本 `scripts/analyze-btf-load.py` 仍在。
- **滑块改动必须用键盘，mousedown 拖拽是假象**（2026-08-27 测试教训）：rc-slider 的 mousedown 只改 DOM `aria-valuenow`，**不触发 React onChange**——表格显示陈旧计划，会得出「f/r 滑块无效」的错误结论。SFC 面板用键盘（focus + Home/End/方向键）才会触发重算（状态变「计算中」→「有效」）。自动化用 `setSliderValue`（`src/infrastructure/prun-ui/utils/set-slider-value.ts`）或真实 keydown 事件。该共享写入器现在的顺序是「点击轨道定位 → 边界用 Home/End 补齐 → 方向键消除剩余档位偏差」（先按一次量出步长，越过目标即放弃），载重这类任意值用 `setSliderValueNearest` 接受最近可达档（仍返回实际读到的值，调用方自行容忍）。
- FIO 公开端点可查轨道数据：`/planet/{id}`（半长轴 m/偏心率/倾角/升交点赤经/近拱点/质量）、`/systemstars/star/{id}`（恒星质量）、`/global/simulationdata`（`PlanetaryMotionFactor`=20，行星运动加速倍率）。FIO 不下发轨道相位——用一次带时间戳的观测反解（方向→真近点角→平近点角零点，半径比→米↔位置单位缩放）。实现见 `src/infrastructure/fio/orbit.ts`。
- **游戏不下发行星相位，但相位已从 bundle 逆向**（`DATA_DATA["systems", id]` 星系详情 / `["planets", id]` 行星详情只有轨道根数 `orbit{semiMajorAxis,eccentricity,inclination,rightAscension,periapsis}` + mass，无 M0/历元/当前位置；`SYSTEM_STARS_DATA` 仅 698 颗恒星含固定坐标）。客户端本地公式（已用日志观测验证，误差 <1%）：**M0 = 0**（世界时间 0 时平近角为 0）、`worldTime = 1451690603 + (t_s − 1451690603) × 20`（`SimulationInterval=86400`、`PlanetaryMotionFactor=20`）、`M = n·worldTime`（`n = √(G·M_center/a³)`，G=6.67384e-11）。`predictPosition` 直接用该公式，**无需观测**即可全量离线预测；输出与 transferEllipse 同一坐标系（km、x/y 交换、`R3(-Ω)·R1(-i)·R3(-ω)` 旋转）。历史 FTC 的 `orbitalToWorld` 用正角（等价逆旋转），方向与游戏相反，是旧相位标定不准的根源。
- **空间站也绕恒星公转**：星系详情 `DATA_DATA["systems", id]` 的 `celestialBodies` 数组含空间站（naturalId 全大写如 `HRT`，无 mass），`orbit` 轨道根数与行星同构（中心=所属星系恒星）。空间站的 `predictPosition` 靠 `resolveParent` 解析中心恒星，轨道积累走 DATA_DATA 被动监听。**游戏无卫星**（所有行星都是 `XX-XXX`+单个小写字母，直接绕恒星；FIO `allplanets` 4155 行星无一例外）。
- **FIO 无空间站数据端点**（`/planet/{空间站}`→204 空、`/system`/`/station`→404；`doc.fnar.net` 不可达）。空间站→星系映射与轨道只能从游戏内获取：`defaultStations` 内置 6 个站（MOR/HUB/ANT/ARC/HRT/BEN）→ 星系映射（无轨道）；空间站轨道根数需浏览含空间站的星系详情（DATA_DATA celestialBodies）积累。内置框架：`public/json/stations.json`（`{ "HRT": { "s":"VH-331", "a/e/i/o/p": 轨道 } }`，仅归属可省轨道）+ `orbit.ts` 的 `stationSystem`/`getStationSystem`/`exportStationOrbits`；FTC 面板「导出空间站」→ `scripts/build-station-data.mjs` 精简内置。FTC `resolveSystemId`/`resolveParent` 优先查内置映射；`liftOffKm`/`liftOffKmAt`（`predictPosition` 离线预测）已随「无回退」删除，不再参与 STL 几何（轨道数据仅剩浏览/导出/诊断用途）。
- **游戏原生命令可打开实体详情界面**（从游戏 bundle 逆向，EntityLink `_link` 用命令字符串拼接 `openBuffer(command)`）：`MS <systemId>`（Map: Star System，打开星系详情）、`PLI <planetId>`（行星信息）、`STNS <stationId>`（空间站）、`GTW <gatewayId>`（网关）、`SYSI <systemId>`（系统信息）、`CO <code>`/`CORPS <code>`/`USR <name>` 等。**执行这些命令会触发客户端自动请求对应实体的 DATA_DATA**（如 `MS VH-331` 打开星系地图并请求 `DATA_DATA["systems", VH-331]`，orbit.ts 即积累 celestialBodies 空间站轨道）。扩展用 `showBuffer("MS <systemId>", { autoClose, closeWhen })` 即可模拟"用户浏览星系"——旧链路 `ftc-compute.computeFtcPlan` **计算时自动浏览**（无手动按钮；该链路已无界面调用方，仅 `verify-ftc-*.mjs` 与 BTF 采集脚本使用）：对起终点所在星系（阻塞等待）+ 无轨道空间站的归属星系（后台渐进）依次打开星系详情，轮询 `hasSystemData`（orbit.ts 的会话级 Set，记录已打开过的星系）确认整个星系数据（恒星质量 + 行星/空间站轨道）积累后自动关窗。当前公式面板（`formula-inputs` → `flight-formula`）**不打开任何窗口**，只读已入库的星系/轨道数据，缺数据直接报缺。命令帮助文本在 bundle 的 `Command.*` i18n 消息表（如 `MS` = "Map: Star System"）。
- **插件不能主动请求数据**（只能发 `UI_TILES_*` 等 UI 命令）：`DATA_DATA` 星系/行星详情在用户浏览星系/行星时客户端自动请求，`orbit.ts` 监听被动积累（零网络开销的批量轨道来源）。FIO `/planet/allplanets` 含 4155 行星列表（全为 planet，无卫星）、`/systemstars` 含 698 恒星（无行星轨道）——FIO 无批量行星轨道端点，全量预取只能低并发逐个（`prefetchAllOrbits`，FTC 面板「预取全部轨道」触发）。
- **观测快照持久化**（`system-bodies.ts`，`rprun.ftc.bodies.v1`）：位置 + 游戏世界时间戳跨会话保留。方向 2 后 `predictPosition` 不再依赖观测（改用游戏公式），观测保留供诊断/验证。

### FTC 标定锚点与本地物理缩放

滑块程序写入不稳定（重试 5 次、400ms 间隔仍可能全部失败）。替代方案是**本地计算模式**：只做一次服务器查询拿「标定计划」，其余参数组合用物理关系本地缩放（`route-model.ts` 的 `scaleCalibration`）：

- STL 时长 ∝ 质量^0.8 · 滑块^−0.85（实测指数，非 Brachistochrone 的 √(m/m₀)·√(f₀/f)——游戏 STL 不是 F=ma 匀加速，有效航速远高于蓝图加速度所能解释）；STL 燃料 ∝ 燃料滑块 f（线性）且 ∝ 距离，与质量基本无关（曾误用 √，0.1→1 少算 √10 倍）。
- FTL：充能/跃迁时间 ∝ r₀/r；FTL 燃料/损伤 ∝ r/r₀（跃迁速度随反应堆使用量线性）。
- STL 损伤由航线环境决定（小行星密度/辐射），不随滑块/质量/时长缩放；标定提取时按段类型拆分 `damageStl`/`damageFtl`。

标定锚点（`anchor.ts`）三来源：被动捕获（用户自己 SFC 预览时按「首段 origin = 飞船地址 + 未独占窗口」关联滑块值，多窗口匹配则放弃）、主动捕获（`captureAnchor`：离屏窗口只选目的地、**被动读**滑块、不写入）、服务器扫描每组成功结果。**锚点与航线绑定**（记录起点/目的地实体）：标定是该航线的服务器精确结果，跨航线距离外推误差过大（实测燃料可虚高 8 倍），缓存仅在「飞船当前位置 + 首航点」一致时复用，否则重新捕获（代价低）。**已知局限**：航线匹配时复用旧缓存、不自动刷新——船体条件（<80% 减速）/专家/蓝图变化后本地计算仍用旧锚点（跃迁时长/FTL 燃料会与当前游戏不一致），核对请用服务器扫描模式或重新捕获。首段直接使用标定数据（精确）；续航段外推：同星系纯 STL 段时长/损伤按 √(距离比)、STL 燃料按距离比（线性，∝ 距离而非时长）；跨星系段时长 = STL·√(stlRatio) + (充能+跃迁)·ftlRatio，STL/FTL 燃料按各自距离比线性。质量变化由 质量^0.8 修正。localStorage 持久化。

`FlightPlan` 消息不带飞船标识（SFC 表格的 prun-id 是 UI 侧关联，离屏窗口读取常失败）。`plan-tracker.ts` 记录消息到达顺序，按「首段 origin 地址 = 飞船当前地址 + 目的地实体」匹配（`latestPlanForAddress`），读取完全不依赖 DOM。

---

## DOM Helpers

Four auto-imported functions for finding elements by CSS class name (`C.X.y`) or HTML tag name.

| Function | Returns | Mechanism | Use When |
| ---------- | --------- | ----------- | ---------- |
| `$` | `Promise<Element>` | MutationObserver — resolves when first match appears | Waiting for element to render (gate pattern) |
| `$$` | `AsyncIterable<Element>` | MutationObserver — yields existing + future matches | Processing current and dynamically added elements |
| `_$` | `Element \| undefined` | Sync `getElementsByClassName` / `getElementsByTagName` | Element is guaranteed to exist already |
| `_$$` | `Element[]` | Sync snapshot of all matches | All target elements exist already |

### Selectors

Selectors are **not CSS selector strings**. Internally they resolve to `getElementsByClassName` or `getElementsByTagName`.

Valid selectors:

- `C.ComponentName.className` — a PrUn CSS class name (preferred)
- HTML tag names: `'div'`, `'tr'`, `'td'`, etc

### `$` — Async Single Element (Gate Pattern)

`Promise` that resolves when the first matching element appears. Blocks execution until the element exists — acts as a natural gate that filters out tiles without the expected DOM structure.

```ts
// Wait for container before proceeding
const container = await $(tile.anchor, C.StoreView.container);

// Chain awaits for nested elements
const text = await $(container, C.CommodityAd.text);
```

### `$$` — Async Iterable (Subscribe Pattern)

`AsyncIterable` that yields existing matches immediately, then watches for new ones via MutationObserver. Almost always paired with `subscribe()`.

```ts
// Process each row as it appears (current + future)
subscribe($$(tile.anchor, 'tr'), row => {
  // Called once per row, including rows added later
});

// Nested subscribes for hierarchical DOM traversal
subscribe($$(tile.anchor, C.ScrollView.view), scroll => {
  subscribe($$(scroll, 'table'), async table => {
    // ...
  });
});

// Async operations inside subscribe callback
subscribe($$(tile.anchor, C.FormComponent.containerPassive), async container => {
  const label = await $(container, 'label');
  hideField(container, label, 'MaterialInformation.ticker');
});
```

### `_$` — Sync Single Element

Immediate lookup — returns first match or `undefined`. Use inside `subscribe` callbacks or other contexts where the parent is already available.

```ts
// Check for element existence
const isHeader = _$(row, 'th') !== undefined;

// Find a specific child
const label = _$(row, C.ColoredIcon.label);
if (label) {
  row.classList.toggle(css.hidden, !visibleMaterials.value?.includes(label.textContent!));
}
```

### `_$$` — Sync All Elements

Returns an array snapshot of all current matches. Use when all target elements are already rendered.

```ts
// Get all cells in a row
const cells = _$$(row, 'td');
if (isEmpty(cells)) {
  return;
}

// Combine: $$ for parent iteration, _$$ for child lookup
subscribe($$(tile.anchor, C.InventoriesListContainer.filter), async filter => {
  for (const label of _$$(filter, C.RadioItem.value)) {
    label.textContent = map.get(label.textContent!) ?? label.textContent;
  }
});
```

### Choosing the Right Function

```text
Need to wait for element? → $ (async single) or $$ (async iterable)
Element already exists?   → _$ (sync single) or _$$ (sync all)
Processing one element?   → $ or _$
Processing many elements? → $$ or _$$
```

Prefer async (`$`/`$$`) over sync (`_$`/`_$$`) when possible — they're type-safe (no `undefined` return for `$`) and handle timing automatically.

---

## Key Concepts

**Tiles** are the game's UI panels — each opened by a command (e.g., `INV`, `PROD`, `FLT`). See `docs/game/ui-concepts.md` for full APEX interface reference.

**`C` object** maps all PrUn CSS class names, parsed at runtime from the game's hashed stylesheets. Always use `C.Component.class` — never hardcode hashed class names.

---

## Observing Tiles

```ts
function onTileReady(tile: PrunTile) {
  // tile.command, tile.parameter, tile.frame, tile.anchor
}

tiles.observe('BBL', onTileReady);          // single command
tiles.observe(['FLT', 'FLTS'], onTileReady); // multiple commands
tiles.observeAll(onTileReady);              // every command

// subscribe() calls callback for each match, including future ones
subscribe($$(tile.anchor, C.SectionList.section), section => { ... });
```

---

## Footer (Bottom Bar) Features

Footer widgets insert into the footer via `subscribe($$(document, C.Frame.foot), onFooterReady)`. Inside `onFooterReady`, wait for `$(footer, C.UsersOnlineCount.container)` and chain inserts relative to it (or relative to other widgets inserted in the same `onFooterReady` call) — see `rprun-version-label.tsx`.

If two footer widgets belong together (e.g. version label + cash balances), keep them in the same `onFooterReady` rather than splitting into two features — the DOM order is then deterministic regardless of `init()` registration order.

---

## Mounting Vue Components

```ts
createFragmentApp(MyComponent, { prop: value })
  .appendTo(container)   // also: .prependTo(), .before(sibling), .after(sibling)

// Reactive props — wrap in reactive() so Vue sees live values
subscribe($$(tile.anchor, 'tr'), row => {
  createFragmentApp(MyComponent, reactive({ id: refPrunId(row) })).appendTo(row);
});
// Note: refPrunId() returns Ref<string | null>. Vue auto-unwraps Refs nested inside
// reactive(), so the component receives a live string | null, not a Ref object.
// The prop type should be declared as `string | null`, not `Ref<string | null>`.

// Inline TSX (no .vue file needed for simple UI)
createFragmentApp(() => (
  <div class={[C.MaterialIcon.indicator, hiddenClass.value]}>
    {count.value}
  </div>
)).appendTo(container);
```

Auto-unmounts when the parent node disconnects from the DOM.

Extract external DOM handling from Vue components into the feature `.ts` file. Vue components handle rendering; feature files handle DOM wiring and game data access. Use callback props to communicate values from Vue to the feature.

**`:key` is compared by strict equality, and typed as `PropertyKey`.** Vue's `isSameVNodeType` is `n1.type === n2.type && n1.key === n2.key` (`@vue/runtime-core`), and keyed diff stores keys in a `Map` — a key is **never stringified**, so an object key compares by identity and a replaced object *does* force a remount (`FleetActWindow.vue` relies on exactly that to make `ExecuteActionPackage` re-create when a new package object is staged — its behavior was correct all along). What an object key breaks is the **type**: `:key` expects `PropertyKey`, so `vue-tsc` reports `TS2322` — which stayed invisible while `.vue` went unchecked. When the intent is "remount whenever this object is replaced", keep a counter bumped from a `watch` on that identity: same behavior, valid key type.

---

## Reactively Mutating DOM Attributes

Watcher stops automatically when the node disconnects from the DOM.

```ts
import { watchEffectWhileNodeAlive } from '@src/utils/watch';

watchEffectWhileNodeAlive(row, () => {
  const value = someComputed.value;
  if (value !== undefined) {
    element.dataset.tooltip = value;
    element.dataset.tooltipPosition = 'right';
  } else {
    delete element.dataset.tooltip;
    delete element.dataset.tooltipPosition;
  }
});
```

`watchEffectWhileNodeAlive` runs immediately — don't duplicate initialization code before it.

---

## Appending Reactive Text to Existing Elements

Lighter than a full Vue component. `undefined` hides the element, string shows it.

```ts
import { createReactiveSpan } from '@src/utils/reactive-element'; // also: createReactiveDiv

const text = computed(() => someCondition ? 'value' : undefined);
existingElement.appendChild(createReactiveSpan(owner, text));
```

---

## Wrapping DOM Values as Refs

```ts
import { refTextContent, refAttributeValue, refValue, refAnimationFrame } from '@src/utils/reactive-dom';

refTextContent(element)              // Ref<string | null> — MutationObserver on textContent
refAttributeValue(element, 'attr')   // Ref<string | null> — MutationObserver on attribute
refValue(inputElement)               // Ref<T> — polls .value via rAF
refAnimationFrame(element, x => x.someProperty)  // Ref<K> — polls via rAF, auto-cleans when disconnected

// Shorthand for data-prun-id attribute
import { getPrunId, refPrunId } from '@src/infrastructure/prun-ui/attributes';
getPrunId(element)   // string | null — sync read
refPrunId(element)   // Ref<string | null> — reactive
```

---

## Accessing Game Data

All stores in `@src/infrastructure/prun-api/data/`. File name matches entity: `sites.ts` → `sitesStore`, `planets.ts` → `planetsStore`, etc.

```ts
import { sitesStore } from '@src/infrastructure/prun-api/data/sites';

const site = computed(() => sitesStore.getById(siteId));  // reactive
sitesStore.all.value      // undefined until fetched, then array
sitesStore.fetched.value  // boolean
```

A few stores (e.g. `blueprintsStore`) are wrapped in `createRequestStore` — accessing any property triggers a guarded one-shot fetch, so reading `blueprintsStore.all.value` opens the `BLU` buffer once automatically and manual requesting is unnecessary.

---

## Data & Reactivity Rules

### Identifying Things in the UI

Never rely on strings in HTML to identify game entities. Use IDs from API stores — they're stable across localizations and UI changes.

```ts
// Bad: fragile, breaks with localization or UI changes
const planet = element.textContent?.includes('Promitor');

// Good: use store IDs
const store = getInvStore(tile.parameter);
const site = sitesStore.getById(store?.addressableId);
const naturalId = getEntityNaturalIdFromAddress(site?.address);
```

### Localized Text

Avoid matching on localized text (like "Weight", "Volume"). Use element index or `PrunI18N` lookup instead.

### Reactivity

**Prefer `computed` over `watch`/`watchEffect`.** Thinking in computed produces more compact and readable code.

```ts
// Good: store.getById is reactive under the hood
const line = computed(() => productionStore.getById(tile.parameter));
```

**Never use `onApiMessage` in features.** It's a low-level API for entity stores in `infrastructure/prun-api`. All API data lands in entity stores — derive what you need with `computed` or `watchEffect`.

**Timestamps in ETAs must stay reactive.** Use `timestampEachMinute` (not `Date.now()`) when calculating ETAs, so it re-renders automatically.

---

## Opening Panels Programmatically

```ts
import { showBuffer } from '@src/infrastructure/prun-ui/buffers';

showBuffer('CXM AI1.RAT');  // opens a buffer with the given command
```

`showBuffer` 选项（`src/infrastructure/prun-ui/buffers.ts`）：

- `force: true` — 跳过同命令窗口的复用检查，总是创建新窗口，可开多个相同命令的窗口并存（并行执行同命令的转移/交易等场景）。
- `autoClose` + `closeWhen` — 窗口以 `display:none` 打开（`css.hidden`），`closeWhen` 变 true 后自动关闭。隐藏窗口上的 DOM 交互（click、changeInputValue、MutationObserver 等待）照常工作，可用于不需要用户看到过程的操作（参考 `ActionRunner.preloadPriceData`）。
- 隐藏窗口的输入交互可用：`focusElement` 派发合成 `focusin` 事件（React 根监听，不依赖真实焦点），react-autosuggest 的 listbox 在 display:none 下仍会打开。静默窗口模式先例：`openMtraWindow`（`mtra-common.ts`）用 `{ force, autoSubmit, autoClose, closeWhen }` 全程隐藏执行 MTRA 批量转移。
- 不带 `force` 时优先复用已打开的窗口并请求聚焦。
- 注意：窗口创建在内部是单槽串行的（`acquireSlot`），并发调用会排队；隐藏窗口仍占游戏窗口槽位。

### 隐藏 ACT 执行窗口后台自动执行

触发器引擎通过隐藏 ACT 执行窗口执行操作包：

1. `queueTriggerRun({ triggerId, packageName })`（`ACT/trigger-queue.ts`）入队 —— `ExecuteActionPackage` 挂载时 `watch(hasPendingTriggerRun, ..., { immediate: true })` 消费队列并走 `onAutoClick()`（预览→自动执行），与触发器引擎同一条通道，跨缓冲区拆分重挂载仍有效。
2. `showBuffer(command, { force: true, autoClose: true, closeWhen: computed(() => 完成信号) })` —— `force` 保证新窗口隐藏打开（复用旧窗口会请求聚焦而弹出）；`closeWhen` 绑定共享的完成 ref。
3. 完成信号：`ExecuteActionPackage.onEnd`（成功/失败/取消均触发）把共享 ref 翻为 true，`closeWhen` 随即关窗。`ActionRunner` 成功时已自带 `closeActWindow()`，完成 ref 补上失败/取消路径。

### 静默并行批处理窗口（MTRA_BATCH 模式）

`MTRA_BATCH`（`action-steps/MTRA_BATCH.ts` + `mtra-common.ts`）是"多窗口 + 隐藏 + 并行提交"的参考实现，适用于需要在多个同命令窗口中批量执行、且不需要用户看到过程的步骤：

- **每个目标开一个窗口**：`openMtraWindow` 用 `showBuffer(command, { force, autoSubmit, autoClose, closeWhen })`；`force` 允许多窗口并存，`autoClose`+`closeWhen` 全程隐藏（见上节）。
- **setup 串行、提交并行**：材料选择器 listbox 一次只能开一个（本文件「Selecting from listbox」节），所以所有窗口的"输入→选建议"阶段必须串行；之后的点击提交与反馈等待互不干扰，可 `Promise.all`。
- **建议列表可能在 portal 里**：为避免被窗口裁剪，游戏会把 listbox 渲染到窗口外，因此 `prepareMtraWindow` 从输入框的 `aria-controls` / 文档级 `[role="listbox"]` 定位列表，条目按 ticker（含 `<TICKER> 名称`）或本地化名称命中；不要再用 `C.MaterialSelector.suggestionsList` 在 tile 内查找。
- **关闭**：`closeMtraWindows` 翻转各窗口的 `closeWhen` ref（触发 autoClose 关窗），`closePrunWindow` 兜底（覆盖 `processWindow` 提前返回、closeWhenDone 未启动的窗口）。
- 隐藏窗口仍占游戏窗口槽位；取消/失败时必须在 `finally` 关闭窗口（见下节）。

### 长步骤的取消与清理

`StepMachine` 的 `waitAct` 在取消（`stop`）时会以 `ACT_CANCELLED` 拒绝，步骤的 `execute` 应在 `finally` 中清理自己打开的窗口，并在长循环中检查 `ctx.isCancelled()` 提前退出（参考 `MTRA_BATCH`）。`skip()` 不会拒绝挂起的 `waitAct` —— 被跳过的步骤的 execute 会永久挂起（预存在行为），不要在 execute 中依赖 skip 触发的清理。

---

## URL Handling

DOM-text → URL sinks (e.g. `<img src={x}>`, `script.src = x`, `iframe.src = x`) are a CodeQL `js/xss-through-dom` finding. Two rules keep the sink clean:

### Use `isSafeUrl` (or a similar guard) for non-trivial URLs

```ts
import { isSafeUrl } from '@src/utils/is-valid-url';

// Bad — passes any parseable URL through, including javascript: and data:
clone.src = script.textContent;

// Good — enforces scheme + exact hostname
if (!isSafeUrl(text, 'apex.prosperousuniverse.com')) {
  return;
}
clone.src = text;
```

`isSafeUrl(url, hostname)` only accepts `http:` and `https:` schemes. For image-only helpers, build a parallel `parseSafeImage(url)` that also validates extension against `URL.pathname` (the regex should not match the raw input — it must match the parsed pathname).

### Never use substring/endsWith for host checks

```ts
// Bad — `evil-apex.prosperousuniverse.com` and `evil.com/apex.prosperousuniverse.com` match
if (s.src.includes('apex.prosperousuniverse.com')) { ... }

// Good — strict hostname comparison
try {
  if (new URL(s.src, location.href).hostname === 'apex.prosperousuniverse.com') { ... }
} catch { /* ignore */ }
```

Substring / suffix / contains checks are flagged by `js/incomplete-url-substring-sanitization`.

### Route the sink value through `new URL(x).href`

CodeQL's dataflow tracks tainted DOM text into the sink. Routing the value through `new URL(text).href` so that the sink reads from the *parsed* URL object (not the original variable) breaks the taint propagation in the sanitizer model:

```ts
// Bad — CodeQL still flags the flow
clone.src = text;

// Good — value reaches the sink via `new URL().href`
clone.src = new URL(text).href;
```

This is what made the CodeQL alerts close on `deserialize-prun-app.ts:9` and `chat-images.tsx:21` even after scheme/host validation alone wasn't sufficient.

---

## CSS

The theme settings in `XIT SET THEME` apply across color themes. Size increases for existing text
use `--rp-font-enlargement` (0 for 标准, 1 for 放大). Extra table separators and floating window
outlines use `data-rp-borders` on `html`. An absent attribute follows the theme, `on` forces the
enhancements, and `off` leaves the underlying table and window styles in effect.

Each feature needing CSS gets a `.module.css` alongside the `.ts`. `applyCssRule` and `C` are auto-imported.

```ts
import $style from './my-feature.module.css';

function init() {
  applyCssRule(`.${C.Frame.logo}`, $style.logo);                              // global
  applyCssRule('PROD', `.${C.OrderTile.overlay}`, $style.disablePointerEvents); // scoped to command
  applyCssRule(['PROD', 'PRODQ'], `.${C.OrderTile.overlay}`, $style.x);        // scoped to multiple
}
```

`applyCssRule` must be called during feature `init()`.

### 界面主题（token 模式）

唯一事实源是 `src/features/basic/theme-registry.ts`。新增 token 模式主题改三处：注册表加一行
（id/label/desc/mode:'token'，深色主题再标 `dark: true`）；新建 `src/features/basic/themes/<id>.css`，
里面写一个 `html[data-rp-theme='<id>']` 精确块，定义与 ceramic 同名的全套 `--rp-cc-*` token（含
`--rp-cc-pulse-*` 三档呼吸灯色），外加首屏防闪的 `body` 底色规则，深色主题再补自己的格式层；
最后在 `src/refined-prun.ts` 按主题顺序 `import` 这个文件，构建时它才与 `src/refined-prun.css`
合并成同一个 `dist/refined-prun.css`，首屏时序与特异性都不变。设置页卡片、首屏标记、图表取色、
引擎映射全部自动派生，不改其它文件。颜色字面量只允许出现在该精确块内；组件规则一律 `var()`，
复用 `buildComponentCss(<id>)` 与 `buildCeramicSkin(<id>)`。自检跑 `pnpm run verify:themes`
（`scripts/verify-theme-palette.mjs`）：token 名契约、精确块结构、对比度硬门槛、模拟窗口取色一次查完。

另有四个可不写的 token，缺省时行为与不写完全一致：`--rp-cc-bg-image`（画布上的方向性提亮，
如暖米纸右上角的高光渐变，默认 `none`）、`--rp-cc-neutral-shift`（引擎重映射中性色时的偏移，
默认浅色 `[2,1,-4]`、深色 `[-4,0,10]`）、`--rp-cc-indicator-glow` 与
`--rp-cc-indicator-line-soft`（指示点光晕与柔线强度，默认取强调色实色；浅底主题要写半透明变体，
否则 6px 光晕会在浅灰上糊成一团）。

设置页的卡片本身就是一个模拟窗口（标题栏写主题名、正文写说明，下面用该主题自己的色摆一份表格行 /
柱图 / 输入框 / 两个按钮）。窗口不画自己的色：`src/features/basic/theme-palette.ts` 从样式表里该主题
的精确块读出 `PREVIEW_TOKENS` 那组 `--rp-cc-*`，作为内联自定义属性挂到卡片元素上，`THEME.vue` 的窗口
样式一律裸 `var()`、零颜色字面量；所以预览既不会另存一份颜色，也不受当前启用主题影响，8 张卡片同时
各自为政。原样主题（`mode:'native'`）没有色板块，走同文件里的 `NATIVE_PREVIEW`——那份值全部取自仓库
既有的原生深色兜底（面板 `rgb(26,33,38)`、表头 `rgb(36,44,52)`、输入框 `#1a2632`、图表 FALLBACK 序列色等），
只为把「原样」这张卡画齐，不参与主题引擎、不进任何 CSS。
三个必须记住的坑：① 色板选择器锚在 `html` 上，给卡片挂 `data-rp-theme` 不会命中，只能内联变量；
② CSSOM 把 `selectorText` 的属性值重新序列化成双引号（源码是单引号），比对必须忽略引号，取值走
`rule.cssText` 而不是 `rule.style.getPropertyValue()`，否则整窗静默少色；③ 加色位要同步把 token 名
加进 `PREVIEW_TOKENS`，`verify:themes` 会拦漏网和写进 `THEME.vue` 的颜色字面量。

深色不靠 CSS 认 id：`dark` 标记由首屏（`refined-prun-startup.ts`）和引擎
（`theme-appearance.ts`）写成 `html[data-rp-dark]`，`refined-prun.css` 里那组共享「染深」覆盖
（顶栏/状态栏/提醒/表格单元格等）只认这个属性，因此新深色主题不必再往选择器里补 id。
`--rp-cc-text-inverse` 是「实色强调块上的反色字」：浅色主题是纸白、深色主题是深底，划词选区与
选中块的字色（`--rp-skin-on-accent`）一律指回它，不写死白色。

特异性：斑马纹 `tbody tr:nth-child(even)` 是 (0,3,3)（`:nth-child` 按类级计）。要压过它的规则
（如选中行）必须再叠一级 `[data-rp-theme]`，同 `!important` 下文档顺序救不了低特异性。

色板验收：文字对 `surface` 与 `canvas` 两种底都要 ≥4.5:1（禁用态按 WCAG 1.4.3 豁免）；图表实色、
焦点环、控件边界与指示线 ≥3:1。指示线 `--rp-cc-accent-line` 除窗口描边、指示条、光晕外，还驱动
选中态边框（`theme.ts` 的 `INDICATOR_LINE_RE`：选中格、模板选中、`:focus`、滑杆点），不能按纯装饰
处理。品牌强调色本身常达不到这些阈值，取同色相加深变体（claude：品牌陶土 #d97757 只作色相基准，
链接文字 #a84c2c、图表与指示线 #cf6a45）。

视觉验收：移动端媒体查询只能结构性验证，真实游戏内效果以用户实采验收为准。

Game filter containers (`.ComExOrdersPanel.filter`, `.ContractsListTable.filter`, `.LocalMarket.filter`) stack their children vertically. A toolbar built from one must also carry the shared `filterToolbarStyle.toolbar` (`@src/components/filter-toolbar.module.css`), which turns it back into a wrapping row:

```ts
import filterToolbarStyle from '@src/components/filter-toolbar.module.css';
// <div :class="[C.ComExOrdersPanel.filter, filterToolbarStyle.toolbar]">
```

For hover/focus/etc., use CSS Nesting inside the module — one `applyCssRule` call handles both base and nested rules:

```css
.logo {
  cursor: pointer;

  &:hover {
    background-color: rgba(128, 128, 128, 0.5);
  }
}
```

### Class Names

Name classes after where they're applied, not what they do. Fall back to "what it does" only when "where" makes no sense.

```css
/* Bad */
.padLeftRight { }
.flexRow { }

/* Good */
.sortControls { }
.storeInfoColumn { }
```

### Scoping

If a feature targets specific commands, always use scoped CSS rules. Otherwise, styles leak to other commands that share the same DOM structure.

```ts
// Bad: leaks to SHPI and other store views
applyCssRule(`.${C.StoreView.row}`, $style.storeInfo);

// Good: only affects INV
applyCssRule('INV', `.${C.StoreView.row}`, $style.storeInfo);
```

For more specific selectors (descendant combinators, `:nth-child`, etc.), tighten them further to improve performance.

### Import Naming

When importing CSS modules into feature `.ts` files, use `$style` for consistency with Vue's `$style` object.

```ts
import $style from './my-feature.module.css';
```

### Reuse

Use `css.hidden` from `@src/utils/css-utils.module.css` instead of creating your own hidden class.

### `:has` Selector

Use `:has` to implement conditional styling in pure CSS, avoiding unnecessary JS.

```js
/* Highlights the parent when a descendant has the error class */
applyCssRule(`.${C.InputsOutputsView.input}:has(.${C.InputsOutputsView.amountMissing})`, $style.input);
```

### Dynamic & Global Styles (outside `applyCssRule`)

`applyCssRule` wraps every rule in `.refined-prun { … }` (the class sits on `<html>`). That makes it unsuitable for rules that target `:root`/`html`/`::selection` directly, or whose values are computed at runtime (e.g. a user-configurable color or CSS filter).

For those cases, own a `<style>` element and rewrite it from a `watchEffect` that reads `userData` (auto-synced, so no manual save needed):

```ts
import { userData } from '@src/store/user-data';

function init() {
  const style = document.createElement('style');
  document.head.appendChild(style);
  watchEffect(() => {
    const s = userData.settings.someSetting;
    style.textContent = s.enabled ? `html { filter: ...; }` : '';
  });
}

features.add(import.meta.url, init, '...');
```

See `src/features/basic/dark-mode.ts` for a working example.

---

## Formatting Dates and Numbers

All formatters are locale-aware (use `Intl.DateTimeFormat` / `Intl.NumberFormat` with the user's preferred locale). Import from `@src/utils/format`.

### Date Formatters

Signature: `(date?: number | Date | undefined) => string`

| Formatter | Output | Example |
| ----------- | -------- | --------- |
| `ddmm` | Month + day | `"03/09"` |
| `ddmmyyyy` | Month + day + year | `"03/09/2026"` |
| `hhmm` | Hours + minutes (respects user's 12H/24H setting) | `"14:30"` |
| `hhmmss` | Hours + minutes + seconds | `"14:30:00"` |

### Number Formatters

Signature: `(value: number) => string`. Do **not** accept `undefined`.

| Formatter | Decimals | Example | Use For |
| ----------- | ---------- | --------- | --------- |
| `fixed0` | 0 | `"1,235"` | Integer amounts, large values |
| `fixed01` | 0–1 | `"1,234"`, `"1,234.5"` | Mid-range values |
| `fixed02` | 0–2 | `"1,234"`, `"1,234.56"` | Values where trailing zeros are noise |
| `fixed1` | 1 | `"1,234.6"` | Always 1 decimal |
| `fixed2` | 2 | `"1,234.56"` | Prices, always exactly 2 decimals |
| `percent0` | 0 | `"43%"` | Large percentages (>100%) |
| `percent1` | 1 | `"42.5%"` | Medium percentages (10–100%) |
| `percent2` | 2 | `"3.45%"` | Small percentages (<10%) |

Always use number formatters when showing numbers in the UI.

### `formatEta(from, to)`

Takes two timestamps, returns time string with day offset. Uses `hhmm` internally.

```ts
formatEta(timestampEachMinute.value, arrival.value)  // "14:30" or "14:30 +2d"
```

### `formatCurrency(value, format?)`

Formats a number with the user's currency symbol, position, and spacing. Returns `'--'` for `null`/`undefined`.

```ts
formatCurrency(price)              // "1,235 ₳" (defaults to fixed0)
formatCurrency(price, fixed2)      // "1,234.56 ₳"
```

Dynamic format selection based on value magnitude:

```ts
let format = fixed02;
if (price >= 100) format = fixed0;
else if (price >= 10) format = fixed01;
return formatCurrency(price, format);
```

## Chain Planner (XIT FLEET 环线)

- **生成原生 RT（单船单趟）**：从单船计划生成出发仓库、各基地、归航仓库。出发装载用 `cxBill`，每站先卸货后提取，归航按 `finalUnload` 卸货，定量装卸步骤的最小和最大数量均为计划量。出发地默认补满 STL 与 FTL，单趟在手动填写时可于计算燃料前取消。采购包仅含现有 `CX Buy`，沿用仓库取货库存保留量。中断时保留已写入的 RT，显示已知航线 ID。分配前核对 Loop、备货和飞行参数，随后在 RT 手动分配，在 RTE 查看进度。
- **循环执行（原生 RT Loop，单船）**：写完航点/步骤后打开游戏 Loop（`socketSetRouteRepeats` → `SHIP_ROUTES_SET_REPEAT`），由服务端反复执行同一闭环，关闭页面后继续运行。Loop 默认关闭。
  - **循环配货**：每轮按整趟预计飞行小时数 ÷ 24 向上取整出的天数配货，最少 1 天。送达量为该天数的 BURN 净缺口向上取整，提取净余量向下取整，先抵扣各基地自产自耗。账单由 `loopBurnBill` 生成，保留基地库存缓冲。单趟补给设置和到港预计库存不参与循环运量计算。必需装卸受舱容约束，当前库存与订单簿用于首轮备货预览。
  - **BURN 数据来源**：循环规划和可用天数直接读取基地 BURN。已开工订单的额外日耗与日产折算只用于单趟规划，避免把单次订单写成每轮装卸需求。
  - **循环飞行估算**：`computeLoopPlan` 从 1 天开始，用 `legLoadWeight` 和 `estimateChainFlightTimes` 对当前货量计算逐段飞行时间、油耗与档位。跨到另一档时更新配货并重新估时，直到配货天数与飞行时长匹配。缺少有效估时、确认缺油、超舱容或无法收敛时停用生成。运行中使用生成时的预计飞行时长。原生 Loop 在完成末站后继续。
  - **满载可用天数**：船总舱容 ÷ Σ各基地净日耗（取重量和体积上限较小者）。自给基地净日耗为 0。此值用于查看容量，实际每轮按预计飞行时长向上取整配货。规划表使用 `ChainPlan.fullLoadUsableDays`，向导与运行中卡片使用 `nativeRouteUsableDays`。缺少净消耗物料的重量、体积或基地 BURN 时显示 —。
  - **min/max 口径**：基地定量装卸、仓库装载和单趟归航卸货使用 `min=max=计划量`，缺量时等待。同料号的采购与链上卸货合并。循环仓库的逐项卸货使用 `min=0, max=计划量`，首轮没有回运货也能开始装船。`verify-fleet-contracts.mjs` 回放服务端响应，校验定量与循环仓库卸货的报文，补油两栏使用 `CAPACITY`。
  - **清舱卸货与循环航点**：选船初始货舱确认为空、本站计划卸完全部在舱物料时写一条 `UNLOAD_ALL`，回退界面填写时展开为逐项卸货。循环预览与新建原生 RT 合用一个仓库航点，先卸货，再补油、装船。仓库航点使用末站返回仓库的档位，运行中从末站显示返航段。关闭 Loop 生效时船停在末个基地。单趟 RT 仍保留末尾仓库航点。
  - **更新配货**：FLEET「规划中」可预览同船、同产业链、未分配的循环 RT 配货差异。现有航点、步骤、料号、补油和飞行档位需与当前规划一致。确认后读回差异，按原航点和步骤 ID 逐条修改变化的数量，仍由 socket 队列串行写入。完整成功后记录新规划快照，中途失败可重新预览剩余差异。
  - **记录合并**：`NativeRouteRecord.loop/cycleHours` 是本地元数据，`repeats` 以服务端 `RouteData.repeats` 为准（`mergeRouteRecord` 覆盖）。`toStep` 按 `maximum.units` 记数量，保留卸货的 `min=0` 和 `UNLOAD_ALL`。手动编辑会作废受影响的预计飞行时长。尚未解析 `UNLOAD_FUEL`/`WAIT`/`LOAD_SHIPMENT`/`UNLOAD_SHIPMENT` 与 LOAD 的 `retain`。RTE 阻塞/等待状态 `parseRouteStatus` 暂按英文候选识别，中文文案**待实采校准**，读不到保留 undefined（界面「—」）。
  - **UI**：ChainView 循环开关 + 单船闭环规划覆盖「规划中」表 + 「本轮周期（预计）」横幅（4b）；NativeRouteDialog 循环选项、写后 `socketSetRouteRepeats` 开 Loop（失败保留航线，提示分配前手动开启）、N 轮备货（`roundBill`=cxBill+每轮 SF/FF，`stockingRoundsMax` 限一船满载，SF/FF 无订单簿只提示不下单）（5）已接，均需浏览器验收。运行中卡片循环状态/补货/预检（7）已接：`loopCardInfo` 只认生成时的 `fuelPerRound` 快照（`loopSustain`），没有快照的游戏手建循环航线不给支撑轮数（显示「—」、补货包只含物料）——按罐容量估会把整圈当成耗满一罐而误报「不足 1 轮」，显示周期/可支撑轮数、阻塞/等待徽标（RTE `status` 经 `matchRunningRoutes`→`collectNativeRoutes` 透传）、船况/PRO/缺料告警与「补货（1 轮）」CX 包，需浏览器验收。
- **RT 窗口识别**：在 `showBuffer` 返回的窗口内读当前磁贴命令并定位控件。创建时同一窗口可从 `RT` 切换为 `RT <id>`，磁贴注册信息可能仍是旧命令。RT 控件按界面语言匹配，简体中文创建按钮显示「创建航线」，装载编辑器的限量行显示「至少」「至多」，数值行显示「最少单位数」「最大单位数」，容量选项显示「最大容量」。同名控件仍须唯一才可点击。打开窗口或填写当前步骤失败可以重试，创建结果不明确时先核对游戏里的航线列表。
- **RT 步骤定位**：原生 `Waypoint.commandsSteps` 在航点下始终挂载，默认仅在悬停时由 CSS 显示。`rt-show-waypoint-actions` 在 RT 内让该操作栏常显。向导按 `Waypoint.destination` 找到航点，再在该航点的 `commandsSteps` 中匹配并点击按钮，简体中文的卸货按钮显示「卸船」。若已点击添加但结果不明确，先核对原生 RT。
- **RT 自动填写**：**默认走 socket 直写**（`native-route-socket.writeNativeRouteBySocket`：建航线 → 逐站添加航点和步骤 → 按回包补写不符的档位、偏好及步骤属性 → 按产业链名改名），不开窗口、不点 UI，秒级完成；socket 不可用或接口报错时可**回退界面填写**。已取得服务端 ID 的半成品须先确认删除。创建请求超时时，由玩家在原生 RT 核对结果。**规划预览与写入前检查**：FLEET「规划中」的表格就是预览。循环校验失败时保留已计算的循环方案和归航数据。玩家点「生成原生 RT」后，`checkNativeRoute` 核对全部航点地址与装卸物料，有问题时按站显示在规划页。地址优先复用基地和空间站数据，同一地址只查一次，写入复用检查结果。检查通过且规划仍有效时，FLEET 在对应飞船的规划卡片内显示生成进度。单趟先用 FTC/BTF 计算档位，循环沿用规划档位，随后自动写入。**生成会话**：`FLEET.vue` 持有通过校验的快照，`NativeRouteDialog.vue` 显示进度与备货操作。切页或切换 FLEET 视图保留会话，关闭卡片后可开始下一次生成。socket 写入中途停止后保留已创建的服务端 id，重试前先删半成品再重写，删除失败则保留 id 并停止重试。关闭卡片或 FLEET 时尽力删除，建航线响应晚于组件卸载时在创建回调里补删。socket 响应按「响应类型 + 航线 id」匹配，游戏里其它窗口的航线响应不会串位；界面创建的记录只有 RT 号，FLEET 校准与删除都按 RT 号反查服务端 id。界面路径：点击「自动填写」后按顺序创建航线、添加航点、填写并保存每条步骤；停止时等待已提交操作返回，再停在下一项；继续使用同一向导可从当前进度接着做；手动逐步按钮仍可使用。**校准触发（2026-11-18 放宽，见 `contributing.md` 的 ToS 例外清单）**：面板打开时就停在「运行中」页（或从别的视图切回环线）时自动校准一次，点页签与向导写入后照常校准；不做定时轮询。**展示与运行方式**：① 创建完成后可从卡片打开原生 RT，或跳到 FLEET「运行中」定位新航线。旧 `XIT RTWIZ` 命令提供迁移提示和 FLEET 入口。原生 RT 展示在**「运行中」页**（页签始终可见，不依赖是否已有环线/规划；进入时自行发现游戏里正在执行的航线），航点/步骤/档位以**游戏航线定义**为准（玩家在原生 RT 改过后卡片随之刷新，本地快照只沿用**燃料档位与上一站都仍匹配**的预计时长（本地记录过反应堆时反应堆也要匹配；系内/纯网关航段不记反应堆，不参与判定；**上游装卸步骤、上游档位、换站或补油步骤变化也会作废下游时长，直到受影响的油罐补满；航线改派给别的船则全部时长作废**（时长是按生成时那艘船的质量/引擎/状况/罐容量算的）。换站的航点即使本站补满也作废「飞到它」与「从它起飞」两段；边界只认**补满**（`CAPACITY`）——玩家把补油改成固定数量后（记录里的 `limited`）出发油量仍与上游消耗有关，不作为边界；航点的「使用跃迁点」偏好（`useGateways`）换了路、或着陆改飞掠（`landing`）都整段作废——着陆改的是「飞到它」与「从它起飞」两段）），沿用规划表样式（序/星球·空间站/操作/飞行/载重）并带逐站状态标记与 `当前/总站数` 进度（飞行列的「预计」时长来自生成时的 `flightHours`，玩家手改燃料/反应堆档位后该段时长清空）——进度由飞船当前航班目的地（`flightsStore`）或在港位置匹配航点得出（游戏 UI 手动创建的航线只有编码地址，用 `waypoint.encoded` 与 `encodeAddress(flight)` 直接比对；首站与归航站同址时用「上一站 → 目的地」的连续航段定位，归航不会回落到第 0 站；到港后航班消失、只剩在港位置时按「上一次确定的航段位置」取之后的第一个匹配点，`routeStopStates`/`routeProgressText` 因此不会把跑完的归航重置成 1/N；没有船就无法定位，进度显示 `—`）；卡片头部有「查看原生 RT」（`showBuffer('RT <naturalId>')`）与「删除」（确认后 socket 删游戏航线 + 移除**这条航线本身**的记录 + 从缓存的航线定义里摘掉该 RT，卡片即从运行中消失；同船同产业链的其它记录不动；同 `naturalId` 的重复记录一起清）；「运行中」页签计数为原生 RT 卡片数。**购买补给（2026-11-18）**：**未运行**的卡片（没有任何船通过 `ship.assignedRoute` 分配到该航线）头部有「购买补给」：按航点 0 的「装载」步骤汇总出发地清单，扣掉出发地仓库现有库存（玩家仓库经 `warehousesStore.getByEntityNaturalId(出发地)` 取 `storeId` 读 store；站级 `warehouseId` 是静态地址、不是玩家 store id，混用恒查不到），生成只含 `CX Buy`（`useCXInv: false`，避免重复抵扣）的采购包并暂存到 `XIT FLEETACT`；出发地不在交易所、或已经备齐时按钮置灰。按容量装载没有确定数量，不参与下单。**显示范围（2026-11-13，2026-11-13 晚改为「全部创建过的航线」）**：`collectNativeRoutes` 先列出**所有本地记录**（创建时间倒序，点页签立刻有内容），再把**游戏里的航线定义**（`SHIP_ROUTES_GET_ROUTES` 的完整列表，含还没分配船只/已经跑完的）与执行状态覆盖到同一条航线的卡片上（`routeIdentity` 按 RT 号去重，执行中的在前；没刷新过的第一次先只显示本地记录）；RTE 只补充「哪艘船在跑」与最新航点，读不到也不影响列表——船的分配优先取 `ship.assignedRoute`（`SHIP_SHIPS`/`SHIP_DATA` 随船下发，与 SHP 窗口「航线分配」同源，不用开窗口、也不受 RTE 渲染时机影响），RTE 行只在旧版游戏缺该字段时兜底——所以玩家建过的航线还没开跑、或游戏 UI 里改过，都照样显示。校准由面板打开/点页签发起：先发 `SHIP_ROUTES_GET_ROUTES` 取航线定义，**返回后立刻发布**（航线卡片不等 RTE），再后台打开原生 `RTE`（`native-route-rte`：`showBuffer` 时 `autoClose` 全程隐藏、读完即关；已有的 RTE 磁贴直接复用）补执行状态；向导正在写航线时这次校准不发请求、写完之后自动重试（仍属同一次打开/点击，不新增后台轮询）。RTE 行只有在 `ship.assignedRoute` 缺失（旧版游戏）时才用来配船：按行里的航线号 `RT-XXXX-NNNN` 与船注册号/船名配对（船名要求完整词边界且唯一命中，多个候选视为未解析交给航班推断）；行里没有航线号时按航线名，或按该船当前航班（连续航点，含循环末站→首站）唯一命中推断，多个航线同时命中则不猜（计为 `unresolved`）。**RTE 读不到、或整页执行行都无法配对时列表不变**（本地记录本来就在），不猜也不清空面板。RTE 数据不在 socket 报文里，只能读执行窗口——这是「游戏 UI 手动创建的航线也要显示在运行中」的唯一数据源（分配关系另有 `ship.assignedRoute`）。数据来源：`native-route-game` 把 `RouteData` 转成展示记录（**航点 `destination` 在响应里不是字符串**——写入请求才是 `{系统}|PLA|STA,{天体}` 编码；响应可能是地址对象/实体字段，统一走 `resolveDestination`，只有真正的字符串才写入 `encoded` 供航班比对，否则 `x.encoded.trim` 会崩；位置按已知星级/空间站/基地/仓库实体 id 反查 naturalId，换不出来保留末段/字段值；`minimum/maximum` 为 `CAPACITY` 的步骤不按 0 吨计算，显示为「×满/×全部」，载重列显示未知（—），直到 `UNLOAD_ALL` 将舱载重置）。**写航线期间跳过校准**——socket 响应没有 actionId，插入请求会让向导的 FIFO 对位错乱（RTE 窗口自身也可能发请求，因此航线请求与 RTE 读取严格串行）；校准只按**发起请求前已存在的记录**判定「游戏里已删除」——期间向导刚建好的航线不在那份响应里，删掉它就丢掉了本地产业链名与预计时长；反过来，**等待期间删过航线**（`routeMutationSeq` 变了）时这份快照也已过期：丢掉它重拉（最多 3 次），否则旧定义会把刚删的航线写回「运行中」；记录本体在 `native-route-registry`（服务端 `routeId`、游戏内 `naturalId`、名称、各段档位、步骤；**打开窗口必须用 `naturalId`**，`RT <hash>` 会显示「未找到航线」；localStorage 键按**公司 id** 分（`rprun.fleet.native-route.v2.<companyId>`）——同浏览器换账号后旧记录不属于当前公司，会被校准当成「已删除」清掉；旧的无公司维度键在首次加载时一次性迁到当前公司并删除）；② 界面路径运行期间原生 RT 窗口用 `parkWindow` 移到屏外（属性 + `!important` 的 transform，不影响 `getBoundingClientRect`），结束时 `unparkWindow` 恢复；③ 界面路径提速：`waitForRt` 轮询 20ms，`dismissSuccess` 去掉固定 `sleep(150)`，改为「等成功/失败提示出现 → 点掉」，无反馈时 250ms 防抖。
- **航线命名**：航线名取 FLEET 顶部选中的**产业链分组名**（BSN 的「供应链分组」）。创建后 `nameNativeRoute` 尝试改游戏里的航线名（点 `[class*="Route__name"]` → 出现输入框 → 写入 + Enter）；没有输入框出现就返回 false，由对话框提示玩家手动改名，并在 FLEET 摘要里保留计划名称。
- **原生 RT 的 socket 接口（2026-11-12 从游戏实采捕获，`prun-client-log.json` + `prun-log.json`）**：航线写入**都是单条 action 消息**，`payload.actionId` 为 UUID、`contextId` 在顶层；没有批量接口。**响应有两种**：变更类请求回 `SHIP_ROUTES_ROUTE`（单条完整航线：`{ id, naturalId, name, created, repeats, waypoints: [{ id, destination, landing, fuelUsageFactor, reactorUsageFactor, preferences, steps: [{ id, type, material: { id, ticker }, minimum: { type: 'ABSOLUTE', units }, maximum, retain }] }] }`），删除/拉取回 `SHIP_ROUTES_ROUTES`（`{ routes: [...] }`）。新增的航点/步骤都在数组末尾 —— 后续请求的 `waypointId`/`stepId` 从这里取。服务端不回 `actionId`，所以按「一次请求一份响应」FIFO 串行 await，并且**全局只允许一条航线请求在飞**（`native-route-socket` 内的 promise 队列 `serialize`）——FLEET 的航线校准（`SHIP_ROUTES_GET_ROUTES`）与向导写入因此不会互相抢响应。**建航线的响应无法对位**（请求里没有 routeId，其它窗口的变更同样回单条 `SHIP_ROUTES_ROUTE`）：`socketCreateRoute` 先拉一份现有航线 id，只接受不在快照里的那一条，否则会把别人的航线当成本次新建、后续航点/改名写到它上面、取消时还会把它删掉。同理，**变更类 action 只接受单条 `SHIP_ROUTES_ROUTE`**——其它窗口的列表响应哪怕带着本条航线也只是变更前的状态，认成自己的会让后续步骤改错航点；`writeRoute` 再用「航点数是否增加」复核。实现：`native-route-socket.ts`。
  | 动作 | messageType | payload |
  |---|---|---|
  | 拉取航线 | `SHIP_ROUTES_GET_ROUTES` | `{ actionId }` |
  | 建航线 | `SHIP_ROUTES_CREATE_ROUTE` | `{ actionId }` |
  | 加航点 | `SHIP_ROUTES_ADD_WAYPOINT` | `{ routeId, destination: "{systemId}\|PLA\|STA,{bodyId}", actionId }` |
  | 设航点档位 | `SHIP_ROUTES_EDIT_WAYPOINT` | `{ routeId, waypointId, destination, landing: true, fuelUsageFactor, reactorUsageFactor, preferences: { ftlPreference: 'LEAST_JUMPS', useGateways }, actionId }` |
  | 加步骤 | `SHIP_ROUTES_ADD_STEP` | `{ routeId, waypointId, type, actionId }`。`type` 实采见 `LOAD`/`UNLOAD`/`REFUEL`/`UNLOAD_ALL`/`UNLOAD_FUEL`/`WAIT`/`LOAD_SHIPMENT`/`UNLOAD_SHIPMENT`（`UNLOAD_ALL` 只需添加请求；其余四种特殊步骤 RPrun 不写） |
  | 设装卸步骤 | `SHIP_ROUTES_EDIT_LOAD_STEP` / `SHIP_ROUTES_EDIT_UNLOAD_STEP` | `{ routeId, waypointId, stepId, material, minimum: { type: 'ABSOLUTE', units }, maximum: {…}, retain, actionId }`。`units` 可为 0（2026-11-19 实采：**LOAD 与 UNLOAD 都接受并回显 `min=0`**，对称性成立；新建步骤默认 `min=1`，因此回包的 `minimum/maximum` 与计划量不符时，RPrun 显式写入两者，见上面的 min/max 口径）。`retain` 语义未实采（游戏回显 46）；RPrun 在 `EDIT_LOAD_STEP`/`EDIT_UNLOAD_STEP` 都固定下发 `retain: 0`，读回不使用 |
  | 改名 | `SHIP_ROUTES_RENAME_ROUTE` | `{ routeId, name, actionId }` |
  | 循环开关 | `SHIP_ROUTES_SET_REPEAT` | `{ routeId, repeats: boolean, actionId }`，回单条 `SHIP_ROUTES_ROUTE`（`repeats` 已翻转）。2026-11-19 实采：与航点/步骤独立，只有航点没步骤也能切；`RouteData.repeats` 随响应下发 |
  | 补油步骤 | `SHIP_ROUTES_ADD_STEP`（`type: 'REFUEL'`）+ `SHIP_ROUTES_EDIT_REFUEL_STEP` | `{ routeId, waypointId, stepId, fuel: 'STL' \| 'FTL', source: 'LOCAL_STORE', minimum: { type: 'CAPACITY', units: 0 }, maximum: { type: 'CAPACITY', units: 0 }, actionId }`（`CAPACITY` = 补满；游戏 UI 会先写一次 `ABSOLUTE` 再切 `CAPACITY`，socket 直接写终态即可；2026-11-19 实采确认 `source: 'LOCAL_STORE'` 与 CAPACITY 回显） |
  | 等待步骤 | `SHIP_ROUTES_ADD_STEP`（`type: 'WAIT'`）+ `SHIP_ROUTES_EDIT_WAIT_STEP` | `{ routeId, waypointId, stepId, amount, unit: 'MINUTES', actionId }`；服务端步骤回 `{ amount, unit }`（2026-11-19 实采）。RPrun 不写 |
  | 卸油步骤 | `SHIP_ROUTES_ADD_STEP`（`type: 'UNLOAD_FUEL'`）+ `SHIP_ROUTES_EDIT_UNLOAD_FUEL_STEP` | `{ routeId, waypointId, stepId, fuel, minimum: { type: 'CAPACITY', units: 0 }, maximum: {…}, actionId }`（2026-11-19 实采）。RPrun 不写 |
  | 删航线 | `SHIP_ROUTES_DELETE_ROUTE` | `{ routeId, actionId }`，回 `SHIP_ROUTES_ROUTES`（列表里已无该 `routeId` 才算成功）；FLEET「运行中」的「删除」按钮用它，成功后只移除该航线自己的记录（`recordsToRemoveAfterDelete`：同船同产业链可以有多条航线，共用船/产业链不代表别的记录被删或作废；其它记录交给校准按游戏航线列表清理）；游戏里仍有船只使用该航线时服务端会拒绝，错误提示里带说明 |
  游戏写航点的默认偏好是 `useGateways: true`（BTF 试飞也用同一偏好）。地址编码与 BTF 试飞同口径（`flight-test-collector.encodeAddress`），材料 id 用 `materialsStore.getByTicker()`。**航点档位语义（官方手册确认）**：`fuelUsageFactor`/`reactorUsageFactor` 描述「**飞到该航点**」的那一段（首个航点也是目的地，船从当前所在地飞过去），所以第 i 段（1 起）写在 `waypoints[i]` 上；FLEET 卡片「飞行」列展示的是「这一站 → 下一站」，因此取 `waypoints[i+1]` 的档位显示。


- **历史（2026-11-17 起航点档位改走 `formula-plan`，见 SFC 段落的新条目）** —— **RT 航点燃料消耗**：按段先算 FTC（`native-route-fuel` → `ftc-compute.computeFtcPlan` 传 `valueOptimal: true`，与 FTC 面板同一套模型与全档扫描，但**选点口径不同**：`pickBestValueOption` 逐档比较「每 +1 个百分点燃料换回多少小时」，边际收益跌破首档的一半就停——临近饱和段速度提升很小、燃料继续涨，正是该停的位置；FTC 面板仍是 Pareto 拐点；向导的三处调用都传 `publish: false`——规划载重、未来出发油量与按实际写入档位重算的参数都属于**假设性**结果，同键发布会覆盖玩家当前 SFC 航班正在用的滑块参数与完成信号），**FTC 按「规划出发油量」计算**（`computeFtcPlan` 的 `stlFuelOverride`：出发地有 STL 补满步骤时从罐容量开始，**多段之间按上一段实耗递减，只有存在补油步骤的航点才重置**——BTF 单段试飞同样传入当前剩余油量；油量算到 0 时保留显式 0（不回退罐容量假装满油）；反应堆档被取整抬高时按**实际写入的档位**重算消耗与时长（公式兜底的段保持 `estimateGeometry`，重算仍判残缺则不采用并清空时长））；**复用服务器原生 TRANSIT 样本时按 (样本质量 / 规划质量)^0.78 换算速度**（`nativeTransitMassT`），否则补了计划载重时长也不会变化；**样本侧的出发油量同样取「测这份计划时的余额」**（`sampleStlTank`，在应用 `stlFuelOverride` 之前取）——规划 override 只影响候选侧，顶掉样本侧会把样本速度按另一个档位重标定；**校准曲线（查表键 Q = 0.98×油量×min(f,0.5)）的基准那段也要用样本油量评估**（`sampleShip`）——用候选的 override 会让样本与候选混在同一行，同档位时比值恒为 1、等于没校准；**样本质量取「测这份计划时的质量」**：游戏按飞船当前状态下发的原生计划就是当前质量，试飞计划则由 `native-route-btf` 用 `setTestFlightSample` 记下测量条件（`massT` = 船质量 + 计划载重、`stlFuel` = 试飞时的出发油量、`condition` = 试飞时的船况——耗时含那次船况的惩罚，复用时要按 `nativeTransitCondition` 还原成健康船速度，否则修好/换件后仍按旧惩罚算）——试飞响应同样进 `flightPlansStore`，按实时质量/余额换算会把货舱与油量惩罚各算两次；取最优 `fuel`×100 与 `reactor`×100 写入目的航点（含归航）；**不再按「离港燃料饱和点」硬封顶**（2026-11-14 实测证伪：同船同航线 `f=0.15` 离港耗 219u、`f=0.08` 耗 139u，8.2% 处并未饱和——饱和点是离港距离与载重的性质，不是引擎常数；`stlDepartureFuelCapPercent` 仍留在 `fuel-model` 供模型口径使用，但向导与 BTF 选点都不再用它砍档，档位只受 1–100 整数与蓝图下限约束，玩家手填的更高档位也不会被覆盖）；**FTC 用严格模式（不传 `estimateGeometry`）**——缺服务器原生 STL 段记录（`missingModelInputs` 判缺）或航线不可达的段一律回退 BTF 实测（`native-route-btf`：直接走 socket 发 `SHIP_FLIGHT_CALCULATE_TEST_FLIGHT` —— 与 BTF 面板同一个服务器计算，**不开窗口、不碰滑块**，载重 `payload`/`stlFuel`/`condition`/`fuelUsageFactor`/`reactorUsageFactor` 都是请求参数（`payload` = 该段计划离站舱载 `legLoadWeight` + 船上现有货物 `cargoStore.weightLoad`——`loadOnDeparture` 从空舱起算，现有货物只用于压减可用舱容，服务器试飞只认 `payload`）；每档一次请求（间隔 250ms），试飞 5%–100%（5% 是游戏滑块下限，1% 会被服务器拒绝），**扫完整档位**（不做提前停止：截断样本会把拐点推到截断点上，正是之前给出 25–30% 的原因；唯一例外是所有档位都被服务器拒绝——见下），用 `pickBestValueOption` 选值（**按反应堆分组**后在同一序列内比较燃料边际收益，避免把反应堆带来的时间差算成燃料收益；边际时间收益跌破首档一半即停；燃料各档无差别时取最快，避免退化到 5%；**跨反应堆按实际时间与油耗比较**——先剔除被严格支配的候选，再取 Pareto 折衷。自然跃迁航线上反应堆给的是常数时间，序列内「时间/燃料」比值会把它抵消掉，旧做法可能选出「更慢又更费油」的劣解），反应堆使用量取 `max(50%, 蓝图 minReactorUsage)`（高下限船不能用低于下限的值试飞），并回传实测时用的反应堆档；**同时把这档位的总飞行时长（小时）带回**（`BtfLegFuel.hours`）——FTC 分支也取 `best.totalHours`，全程不额外请求；FLEET 航点记录存为 `flightHours`，「飞行」列在燃料档位下方显示「预计 X天 X小时」；试飞的油量基准用**罐容量**（航线每站都 REFUEL 补满，用当前余量会让高档位因油不足失败；油罐 store 读不出容量时 STL 回退蓝图 `stlFuelCapacity`，FTL 没有第二个来源——**读不出来就整条字段不发**：覆盖成 `undefined` 会连 `calculateTestFlight` 的基线默认值（STL 1500 / FTL 300）一起顶掉，回退成 0 更会让跨星系航线每一档都因跃迁没油被服务器拒绝；出发油量未知时不写 `setTestFlightSample` 与转移速度样本，猜一个罐容量会污染 `Q = 0.98×罐×min(f,0.5)` 校准行）；被拒绝的档位按 `plan.status` 汇总成一行（如 `OVERWEIGHT ×2`），**连续 2 档被拒且一条样本都没有时停止扫描**（载荷与消耗对档位单调，最低档已经飞不出去时更高档只会更费油；有样本时仍扫完整网格）；响应里的 `SHIP_FLIGHT_MISSION` 顺带写入原生 STL 段记录）。BTF 也没结果的段才用公式估算补算，再不行保留 25%，都在对话框逐段列出原因，不中断整条生成。首航点无规划入站航段，预填 25%，生成前可逐站修改。**写入的档位一律向上取整且不低于蓝图下限**（`percentAtLeast`：下限 0.653 若四舍五入成 65%，航线就低于下限、自然跃迁段飞不动；BTF 试飞与写入、FTC 重算都用同一个百分比）；**取整改了档位就等于换了档，必须重算**——`applyWrittenTiers` 在反应堆百分比与选中值不同时走重算，否则时长/油耗还是旧档位的；**出发余量不足的航段只警告不改档**（模型不校验油量，`consume` 会把余量夹到 0；`reportShortfall` 在每段写入前比对 STL/FTL 消耗与已知余量，提示「航线会中途停下」）；**反应堆只在存在自然跃迁时写**（`reactorRelevant`；全程系内/纯网关飞行反应堆不影响时长与燃料，对话框留空即不改游戏原值）：航点编辑器按 `REACTOR USAGE`/「反应堆使用量」定位滑块，找不到或留空就只写燃料消耗，保存前把两个档位一起读回校验。
- **历史（2026-11-17 起该兜底已删除）** —— **FTC 缺原生记录时的公式估算**：`route-planner.estimateRouteStl()` 给出跨星系 STL 起降距离（离港 70M / 进近 68M km，内置 2018 条离港 + 1082 条进近实测中位数；网关/系内段改用天体到本星系恒星的轨道距离）。**只有** `computeFtcPlan({ estimateGeometry: true })` 消费它，而且现在**只是原生 RT 生成里 BTF 试飞也失败后的兜底**（`native-route-fuel` 的 `estimateLegs`）——系内段用「到恒星的轨道距离」代替真实 STL 距离是粗估，曾导致所有档位算出同样时长、平衡点退化到 5%（用户实测报障），所以不再作为主路径；FTC 面板与 SFC 联动仍按 `missingModelInputs` 严格判缺、绝不写估算值。只有时间受影响——跨星系 STL 燃料是罐口径，与距离无关。

- **FTC「转移速度查询表超出可靠范围」的自愈**：`public/json/transit-speed-table.json` 的 aEff 覆盖极窄（`STL_ENGINE_FUEL_SAVING` / `STL_ENGINE_HYPERTHRUST` 各只有**单一** aEff 行），质量比不同的船会让 `stlTransitTableReliableFor` 对整个燃料网格判「超出可靠范围」→ 整段跳过 FTC（用户实测：某船三段全跳过）。原生 RT 生成的 BTF 试飞顺带把每条 OK 计划的 TRANSIT 段转成 `(q, aEff, v)` 样本写进查询表：`q = 0.98×罐×min(f,0.5)`、`aEff = 加速度×空重/(船质量+计划新增载重)`（`ship.mass` 已含船上现有货物，只叠加 `legLoadWeight`；试飞请求的 `payload` 另加现有货物交给服务器；速度**除以** `conditionFactor` 还原成健康船速度（乘回去等于把惩罚算两次：40% 船况的 2.78h 会被放大到 11h）），段时长 <60s 或距离 <1000km 不入表（噪声大）；样本由 `transit-speed-samples`（`native-route-btf` 调用）落盘 `rprun.ftc.transit-samples.v1`，`fuel-model` 在远端表加载后再叠加（`addTransitSpeedSample` / `restoreTransitSpeedSamples`）。采到该船自己的 aEff 行后，同船后续的 FTC 计算就能通过可靠区间检查——BTF 本来就是因为 FTC 算不了才跑的，等于自我修复。

FLEET 基地规划的计划天数有两个来源，由第二行工具栏的全局「填满库存」开关选择（默认关）：
关闭时沿用每基地手填天数（改派船只**不会**再自动改写天数——旧的写回路径 `fitShip`/`pendingShipFits` 已删除）；开启后各基地按仓储安全上限补满，并优先取该船按剩余载重、容积和维修占用能装的补给天数（`FLEET.vue` 的 `fittedDaysByShip` 逐船调 `utils.fitDaysForShip`；天数上限统一由 `supplies-cap` 按各基地 cap 收紧——`clampTargetDays` 用于补给账单、`fitTargetDays` 用于环线试算）。
基地规划和环线补给都计算消耗品和原料，顶部「CX 购买」控制两种规划生成的采购步骤。
环线规划使用自身勾选的船只和基地试算补给天数，并按分段结果检查每艘船的舱容。
两种规划都应用各基地的仓储上限：适配值还要按本基地 cap 再钳一次（`supplies-cap.fillInventoryDays`——一船挂多个补给基地时 `fitDaysForShip` 的饱和点取各基地 cap 的最大值，不钳会显示「目标 40 天 > 本基地上限 25 天」）；环线试算不写回主页面的天数；开关打开期间天数输入框只读，`PlanetRow` 的 clamp watch 也不再回写 `config.days`（否则关掉开关会跳出一个用户没设过的数字）。

环线单船规划入口在 `chain-planner.ts`，`chain-data.ts` 采集输入快照，`chain-plan-core.ts` 负责计算；多船分配在 `chain-allocation.ts`，`use-chain-planning.ts` 编排响应式规划与异步估时，界面在 `ChainView.vue`。多船可以预览分段，生成原生 RT 时需选择一艘船。循环模式另由 `native-route-loop.ts`（零依赖循环数学）与 `use-chain-loop-planning.ts`（单船配货和估时）承载。模块边界见 `docs/architecture.md` 的 FLEET 小节。

- 单路线由 `planChainRoute` 规划：拓扑排序定航线 → 按目标天数平衡链上运量 → 沿航线模拟舱容。
- **链上装船按下游优先度逐条装载（不按比例缩放）**：装载到下游站点的链输送（`chainPickup`）走 `pushItemsPrioritised`（`src/features/XIT/FLEET/chain-fit.ts`），按 dest 的 daysLeft 升序逐条装填，可装多少装多少，超载 item 跳过；缺货的下游留待下一航次。**关键**——按比例缩放会让每个下游都被裁到一半、谁都拿不到足额，按下游优先度则保证最急的下游拿满。出发地装载 CX 采购物资（`initialItems`）仍用 `pushItemsProportional`（整批按同一比例缩放，超载则让用户减少天数或换大船）。
- **组内产出的闭环**。BSN 白名单中有产出的物料由组内供给。单趟使用出发地库存补足链上缺口。循环优先回运需要从出发地装船的组内物料。实际回运量算作首轮周转货，返航补回后继续使用。回运不足的差额计入每轮外购和备货包，出发地仍按完整需求装船。
- **循环周期与备货**。在固定出发时刻与生产消耗快照下，按整数装卸表估算逐段载重、时间和油耗，再用新周期核对同一张装卸表。归航带回周转货供下一轮使用，首轮库存和已知 CX 供应缺口在规划页单独显示。单趟按下方库存和订单簿规则裁减。
- 自动适配天数时允许交换船只接段顺序。合并规划按仓库去重汇总库存，分段子计划按各船实际出发仓库验证供给，空子计划也参与检查。裁减下游交付会使候选不可行。返航货物使用本站到归航全程的剩余舱容，为后续必需交付留出空间。分段容量校验只计卸货与必需装载（取两者较大值），可选返航货物可裁剪、不参与校验；站点尺寸会把同一批链货在装、卸两端各算一次，因此候选取不出来时改为逐段重规划，按子计划的峰值必需载荷（无裁减、无缺口）判定可行。
- **购买时检测空间站库存**：两层检测。
  1. **空间站仓库库存抵扣**：生成采购清单时，出发地空间站仓库（`originStock`）已有的物资（含组内产物与普通补给）优先以「取货」装船（`originPickupByStop`），采购量在 `purchaseBill` 阶段扣除取货部分——仓库已有不重复购买。
  2. **订单簿供应检测**：合并规划不传 `exchangeCode`，保留候选站点供分船；分船后每艘船按自身出发地交易所代码（`exchangeCode`）查 `cxobStore` 订单簿（key = `ticker.exchangeCode`）的 `supply`（卖单总量），供应不足时在舱容模拟之前按航线顺序分配可购数量，使采购、分站卸货、载荷快照同步缩减并警告（「空间站库存不足（供应 X / 需 Y），采购量已缩减至 X」），防止执行时 `CX Buy` 因库存不足而整体失败。订单簿数据未加载（未打开过 CXOB）时跳过检测、不误报。
- **序 0 空间站行分开展示采购/取货**：装船物资按来源分两行——「采购」= `purchaseBill`（从 CX 购买），「取货」= `cxBill − purchaseBill`（从空间站仓库直接装船，含组内产出 `originPickup` 与仓库已有库存）。
- **采购执行保留装船库存**：环线的采购组使用净采购量 `purchaseBill`，同时把计划取货量 `originPickup` 传给 ACT 作为库存保留量。只有超过该保留量的仓库库存才能抵扣采购，包括重试前已经买到的物资。
- **多船并行分段**：`planFastestChainSegments` 沿拓扑序切连续站段，每艘船都可以接任意一段。候选段用该船出发地到段首、段内相邻站、段尾回出发地的方向估时，优先最小化最慢船的闭环时长，同样快时最小化总飞行时长。大船队限制每个站点前缀保留的船只组合数。缺少可用估时时沿用容量分配。逐船子计划按航线顺序扣减共享仓库和交易所供应，跨段产物归航后可供下一轮使用。
- 无货舱（或剩余舱容 0）的船不参与分段。逐船应用库存和订单簿供应限制后，无剩余操作站点的子计划不返回。
- **分段返回值**：`ranges` 和 `hours` 与输入船只逐位对齐，非空半开区间 `[start, end)` 表示该船负责的站点。瓶颈站的相邻分段按站点下标确定。视图层用 `stopIds.slice(start, end)` 将区间转换为站点 ID。
