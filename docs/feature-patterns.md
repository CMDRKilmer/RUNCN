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

Only one listbox can be open at a time — react-autosuggest closes the focused input's listbox when another input takes focus, so listbox interactions in a multi-row form must run one row at a time. Plain value writes (amount, price) are safe to run in parallel, but a write can land on a node React swapped under a concurrent re-render. Follow parallel writes with a sequential verify-and-fixup pass that re-writes mismatches, so races become retries instead of silent corruption — see the two-wave fill in `contd-auto-fill.ts`.

### CXPO 卖出表单（挂单 vs 填单）

CXPO 表单即交易所下单表单：`form.children[7]` 数量输入、`children[8]` 价格输入、`children[12]` 按钮区（买入 `C.Button.success`，卖出 `C.Button.danger`）。卖出按钮必须限定在按钮区内查找（`children.item(12)` 内 `_$`），避免全局误点买入。

挂单与填单是同一张表单，区别只在价格：
- **挂单（LIMIT）**：按指定价（或卖一价）下单，订单挂盘等待成交，CX 仓库数量**不变**。
- **填单（FILL）**：按买一价下单，立即吃买单成交，CX 仓库数量**下降**（成交后等仓库更新）。

参考实现：`CXPO_SELL`（`action-steps/CXPO_SELL.ts`）执行时从实时订单簿定价；`CXOS` 压价重挂用同一按钮定位。

### SFC 滑块自动化与离屏窗口（FTC 参数扫描）

- rc-slider 滑块（SFC「燃料消耗/反应堆使用量」）用共享工具 `setSliderValue`（`src/infrastructure/prun-ui/utils/set-slider-value.ts`）写入。后台自动设置滑块的功能（如 `sfc-auto-fuel-settings`）与主动扫描（FTC）会互相覆盖参数——写入前先 `reserveTile(tile.anchor)` 独占，结束时 `releaseTile`；后台功能用 `isTileReserved` 跳过被独占的 tile。
- 滑块写入依赖 `getBoundingClientRect` 计算百分比坐标：离屏自动化窗口必须用 `transform: translate(-200vw, -200vh)` 移出屏幕，**不能**用 `display:none`（矩形为 0，写入永远失败）。
- 只填目的地/滑块、不点「开始」时，服务器仍会重算并下发 `SHIP_FLIGHT_MISSION`——用 `getPrunId` 从 `C.MissionPlan.table` 拿 mission id，再从 `flightPlansStore` 读精确计划（时长/燃料/损伤），无需自行建模。以 `C.MissionPlan.stats` 文本内容变化作为「重算完成」信号。
- `SHIP_FLIGHT_MISSION` 的 TRANSIT 段 `transferEllipse.startPosition/targetPosition` 是出发/目标天体在出发/到达时刻的**绝对坐标**（带时间戳的观测）；MS 星系地图**不**下发行星绝对坐标（行星按轨道根数渲染）。飞行计划首段 `departure.timestamp - Date.now()` 可标定游戏世界时钟偏差。
- **FTC 最优方案（平衡点）无需设置档位**（2026-08-27）：`fuel-model.ts` 的 `autoFuelGrid()`（燃料 0.05–1 步长 0.05）与 `autoReactorGrid()`（反应堆 minReactorUsage–1 步长 0.05，滑块下限来自蓝图性能）自动扫描全范围，玩家不再手动输入档位组合。最优=平衡点：设了时间价值（₳/h）时按总成本（燃料费+时间价值）最优（经济平衡）；未设时用 `findBalanceOption()` 的 **Pareto 拐点**——把「最快」（时间最短/燃料最多）与「最省油」（燃料最少/时间最长）连成线，前沿上距线最远的点即折衷平衡点（尽量快同时耗油少，两端都不极端）。结果只显示最佳方案单行（燃料滑块/反应堆/总时长/STL+FTL 燃料/燃料费/时间成本/总成本）。**全程系内/纯网关飞行（无自然跃迁）不扫描反应堆**（`reactorRelevant` = natPc/jumpCount 为 0 时网格固定为 [1]），反应堆列显示 `--`、提示语不含反应堆。
- **STL 段燃料基准 = 当前 STL 罐余量**（2026-08-27 实测，`fuel-model.ts` `stlSegmentSpeedFor`/`computeFuelOption`）：跨星系段燃料 `Q = 0.49×余量×min(f, f_cap)`（离港）+ `0.49×余量×f + 8`（进近），段速度 = 各引擎 Weibull(Q)。**关键**：服务器用「段开始时当前 STL 罐余量」而非蓝图罐容量——罐不满（MTRA 转移油）时 Q 变小 → 段燃料少、段速度慢、时间/距离变。`ShipPerformance.stlRemaining` 由 `ftc-compute.ts` `shipFuelRemainingFor()` 从油罐 store（`Ship.idStlFuelStore`→`storagesStore`）实测；缺余量时回退 `stlFuelCapacity`（罐满时两者一致，历史标定仍成立）。实测对照：STL=500 离港 23u（新模型 24.5，旧罐模型 171.5 差 7 倍）；f=1.0 进近 1731u = 0.49×3500×1+8 精确吻合，离港 289u = 0.49×3500×0.164（f_cap=10.96×流量）饱和。
- **滑块改动必须用键盘，mousedown 拖拽是假象**（2026-08-27 测试教训）：rc-slider 的 mousedown 只改 DOM `aria-valuenow`，**不触发 React onChange**——表格显示陈旧计划，会得出「f/r 滑块无效」的错误结论。SFC 面板用键盘（focus + Home/End/方向键）才会触发重算（状态变「计算中」→「有效」）。自动化用 `setSliderValue`（`src/infrastructure/prun-ui/utils/set-slider-value.ts`）或真实 keydown 事件。
- FIO 公开端点可查轨道数据：`/planet/{id}`（半长轴 m/偏心率/倾角/升交点赤经/近拱点/质量）、`/systemstars/star/{id}`（恒星质量）、`/global/simulationdata`（`PlanetaryMotionFactor`=20，行星运动加速倍率）。FIO 不下发轨道相位——用一次带时间戳的观测反解（方向→真近点角→平近点角零点，半径比→米↔位置单位缩放）。实现见 `src/infrastructure/fio/orbit.ts`。
- **游戏不下发行星相位，但相位已从 bundle 逆向**（`DATA_DATA["systems", id]` 星系详情 / `["planets", id]` 行星详情只有轨道根数 `orbit{semiMajorAxis,eccentricity,inclination,rightAscension,periapsis}` + mass，无 M0/历元/当前位置；`SYSTEM_STARS_DATA` 仅 698 颗恒星含固定坐标）。客户端本地公式（已用日志观测验证，误差 <1%）：**M0 = 0**（世界时间 0 时平近角为 0）、`worldTime = 1451690603 + (t_s − 1451690603) × 20`（`SimulationInterval=86400`、`PlanetaryMotionFactor=20`）、`M = n·worldTime`（`n = √(G·M_center/a³)`，G=6.67384e-11）。`predictPosition` 直接用该公式，**无需观测**即可全量离线预测；输出与 transferEllipse 同一坐标系（km、x/y 交换、`R3(-Ω)·R1(-i)·R3(-ω)` 旋转）。历史 FTC 的 `orbitalToWorld` 用正角（等价逆旋转），方向与游戏相反，是旧相位标定不准的根源。
- **空间站也绕恒星公转**：星系详情 `DATA_DATA["systems", id]` 的 `celestialBodies` 数组含空间站（naturalId 全大写如 `HRT`，无 mass），`orbit` 轨道根数与行星同构（中心=所属星系恒星）。空间站的 `predictPosition` 靠 `resolveParent` 解析中心恒星，轨道积累走 DATA_DATA 被动监听。**游戏无卫星**（所有行星都是 `XX-XXX`+单个小写字母，直接绕恒星；FIO `allplanets` 4155 行星无一例外）。
- **FIO 无空间站数据端点**（`/planet/{空间站}`→204 空、`/system`/`/station`→404；`doc.fnar.net` 不可达）。空间站→星系映射与轨道只能从游戏内获取：`defaultStations` 内置 6 个站（MOR/HUB/ANT/ARC/HRT/BEN）→ 星系映射（无轨道）；空间站轨道根数需浏览含空间站的星系详情（DATA_DATA celestialBodies）积累。内置框架：`public/json/stations.json`（`{ "HRT": { "s":"VH-331", "a/e/i/o/p": 轨道 } }`，仅归属可省轨道）+ `orbit.ts` 的 `stationSystem`/`getStationSystem`/`exportStationOrbits`；FTC 面板「导出空间站」→ `scripts/build-station-data.mjs` 精简内置。FTC `resolveSystemId`/`resolveParent` 优先查内置映射，`liftOffKm` 用 `predictPosition` 离线预测（无需观测）。
- **游戏原生命令可打开实体详情界面**（从游戏 bundle 逆向，EntityLink `_link` 用命令字符串拼接 `openBuffer(command)`）：`MS <systemId>`（Map: Star System，打开星系详情）、`PLI <planetId>`（行星信息）、`STNS <stationId>`（空间站）、`GTW <gatewayId>`（网关）、`SYSI <systemId>`（系统信息）、`CO <code>`/`CORPS <code>`/`USR <name>` 等。**执行这些命令会触发客户端自动请求对应实体的 DATA_DATA**（如 `MS VH-331` 打开星系地图并请求 `DATA_DATA["systems", VH-331]`，orbit.ts 即积累 celestialBodies 空间站轨道）。扩展用 `showBuffer("MS <systemId>", { autoClose, closeWhen })` 即可模拟"用户浏览星系"——FTC **计算时自动浏览**（无手动按钮）：对起终点所在星系（阻塞等待，保证本次计算 STL 起降距离可用）+ 无轨道空间站的归属星系（后台渐进）依次打开星系详情，轮询 `hasSystemData`（orbit.ts 的会话级 Set，记录已打开过的星系）确认整个星系数据（恒星质量 + 行星/空间站轨道）积累后自动关窗。命令帮助文本在 bundle 的 `Command.*` i18n 消息表（如 `MS` = "Map: Star System"）。
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

让 ACT/FLEETACT 执行窗口「不弹出、后台自动跑」，参考 `ChainView.vue` 环线自动执行（`chainAutoTrigger`）：

1. `queueTriggerRun({ triggerId, packageName })`（`ACT/trigger-queue.ts`）入队 —— `ExecuteActionPackage` 挂载时 `watch(hasPendingTriggerRun, ..., { immediate: true })` 消费队列并走 `onAutoClick()`（预览→自动执行），与触发器引擎同一条通道，跨缓冲区拆分重挂载仍有效。
2. `showBuffer(command, { force: true, autoClose: true, closeWhen: computed(() => 完成信号) })` —— `force` 保证新窗口隐藏打开（复用旧窗口会请求聚焦而弹出）；`closeWhen` 绑定共享的完成 ref。
3. 完成信号：`ExecuteActionPackage.onEnd`（成功/失败/取消均触发）把共享 ref 翻为 true，`closeWhen` 随即关窗。`ActionRunner` 成功时已自带 `closeActWindow()`，完成 ref 补上失败/取消路径。

### 静默并行批处理窗口（MTRA_BATCH 模式）

`MTRA_BATCH`（`action-steps/MTRA_BATCH.ts` + `mtra-common.ts`）是"多窗口 + 隐藏 + 并行提交"的参考实现，适用于需要在多个同命令窗口中批量执行、且不需要用户看到过程的步骤：

- **每个目标开一个窗口**：`openMtraWindow` 用 `showBuffer(command, { force, autoSubmit, autoClose, closeWhen })`；`force` 允许多窗口并存，`autoClose`+`closeWhen` 全程隐藏（见上节）。
- **setup 串行、提交并行**：材料选择器 listbox 一次只能开一个（本文件「Selecting from listbox」节），所以所有窗口的"输入→选建议"阶段必须串行；之后的点击提交与反馈等待互不干扰，可 `Promise.all`。
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

环线规划核心在 `src/features/XIT/FLEET/chain-planner.ts`，UI 在 `ChainView.vue`。

- 单路线由 `planChainRoute` 规划：拓扑排序定航线 → 按目标天数平衡链上运量 → 沿航线模拟舱容。
- **组内产出的闭环**：BSN 白名单 + output>0 的 ticker 为「组内产出」，一律不进 CX 采购清单；缺口优先由出发地空间站仓库库存以「取货」（`originPickup`）补足，仍不足则警告。
- **进度与脚本**：执行时把计划快照持久化到 `userData.chainRuns.*.plan`，页面刷新后仍按规划样式显示各阶段载重/操作；生成的 ACT 操作包带阶段号（`0 Chain 船名`、`N 站点 Loop 船名`、`M Chain Return 船名`）。**环线主包/站点包/归航包不再 autoDelete**（保留完整脚本供状态列表/云端同步/手动清理），仅到港触发器仍 autoDelete；阶段完成由 `ExecuteActionPackage.vue` 在包执行成功后无条件调用 `markChainStageDone` 写回 `chainRuns` 持久化状态（**不能只依赖 `pkg.autoDelete` 分支**——环线包不 autoDelete 时该分支永不触发，站点/归航状态会永远停在 `arrived`，状态检查无法推进下一阶段）。
- **多船 = 并行分段（唯一方案，已废弃 A/B/C 三策略）**：`splitChainPlanAcrossShips(plan, ships, bases)` 按拓扑序把站点切为连续段，每船独立规划其段并同时出动，总耗时 ≈ 单环线 / 船数。切分按**剩余舱容逐站装箱**（当前船装不下重量或体积任一才换下一艘，最后一艘兜底），产物密度（大重量小体积 / 大体积小重量）自然决定段边界，避免某船段载荷超出其容量。跨段产物经出发地仓库接力。传全局 `groupProducedTickers` 保证跨段产物在任何段都不被误采。
- 无货舱（或剩余舱容 0）的船不参与分段。
- **断线恢复（状态检查 + 自动恢复）**：环线各阶段靠到港 FLIGHT_ENDED 告警触发器驱动，网页关闭期间到港告警错过会导致环线卡在当前阶段。`ChainView.vue` 以「船当前停靠位置 + 持久化阶段状态 + 操作包是否仍存在」判断当前阶段（执行成功即 `markChainStageDone` 持久化 `done`，不会重复执行），经 `queueTriggerRun` + 隐藏 ACT 窗口（与触发器引擎同通道）静默执行下一步操作包，`hasPendingTriggerRun` 防重复入队。`runProgress` 按环线顺序执行假设，把**船当前停靠站点之前的所有站**推导为完成（`dockedStopIndex` 前推），旧记录（autoDelete 时代遗留的 arrived/pending）也能被状态检查推进。「状态检查」按钮手动触发；「自动恢复」开关（默认开）在船数据就绪后自动执行，且**服务器重连（页面未刷新）也能再次触发**：模块级 `CLIENT_CONNECTION_OPENED` 监听重置「已恢复」标志（状态放普通 `<script>` 块承载、跨组件实例共享，切换页签卸载/重挂载不丢失），store 重置后重新推送即自动再次检测断线阶段。状态检查无匹配步骤时输出诊断（每船停靠位置 vs 预期阶段），便于核对位置/脚本差异。
- **多端同步（跨浏览器/设备）**：环线配置 + `chainRuns` + 环线 ACT 包/触发器经 org-api 服务器同步（`src/features/XIT/FLEET/chain-sync.ts` + `src/infrastructure/org-api/chain-sync.ts`，后端 `/chain-sync` 端点）。命名空间 = 公司代码（JWT `company_code`）：同账号跨设备共享、多账号天然隔离。启动拉取 + 数据变化防抖 5s 推送 + 60s 轮询 + 手动「云端同步」双向同步；冲突用 `updatedAt` LWW + PUT `baseUpdatedAt` 乐观锁（409 时采用较新端，`applyRemote` 抑制由此引发的 markDirty 避免无限同步循环）。应用远端**只恢复列表与状态、不自动执行**（执行仍由本端状态检查/触发器引擎驱动）；`applyConfig` 需在 `chainGroup` 的 watch flush（`nextTick`）后再设其余字段，否则远端 `chainBaseIds` 会被该 watch 误清。网络不可达 / 未登录静默降级，现有 JSON 导出/导入保留作离线备份。
