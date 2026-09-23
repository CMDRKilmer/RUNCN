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
- **FTC 最优方案（平衡点）无需设置档位**（2026-08-27）：`fuel-model.ts` 的 `autoFuelGrid()`（燃料 0.05–1 步长 0.05）与 `autoReactorGrid()`（反应堆 minReactorUsage–1 步长 0.05，滑块下限来自蓝图性能）自动扫描全范围，玩家不再手动输入档位组合。最优=平衡点：设了时间价值（₳/h）时按总成本（燃料费+时间价值）最优（经济平衡）；未设时用 `findBalanceOption()` 的 **Pareto 拐点**——把「最快」（时间最短/燃料最多）与「最省油」（燃料最少/时间最长）连成线，前沿上距线最远的点即折衷平衡点（尽量快同时耗油少，两端都不极端）。**退化保护**（2026-09-23 修复实测 bug）：燃料或时间在全部候选方案中无差异时（`fSpan`/`tSpan` 退化，例如燃料模型拿不到 STL 距离使 `stlFuel` 恒为 0）拐点无意义，**绝不返回最快方案（f=1 拉满）**，改为返回最省油方案（燃料最小 → 反应堆最小 → 滑块最小）；也**不允许**用极小 span 归一化（旧代码的 `Math.max(1e-9, span)`）把浮点噪声放大成全量程——那正是「同星系飞空间站时滑块被写成 1」的放大机制（同星系 `stlFuel = C_F×f×d`，`d = departKm + approachKm` 只要一段缺失即 undefined → 燃料无梯度）。结果只显示最佳方案单行（燃料滑块/反应堆/总时长/STL+FTL 燃料/燃料费/时间成本/总成本）。**全程系内/纯网关飞行（无自然跃迁）不扫描反应堆**（`reactorRelevant` = natPc/jumpCount 为 0 时网格固定为 [1]），反应堆列显示 `--`、提示语不含反应堆。
- **FTC 几何只用「服务器下发的原生 STL 段记录」（2026-09-23 用户拍板；同日二次修订取消回退）**：STL 起降几何（`routeMetrics()` 的 `departKm`/`approachKm` → `stlDistanceKm`）**只取服务器下发的原生 `stlDistance`**；自建轨道模型 `liftOffKmAt` 与统计中位数常数 `STL_EST_*` **已删除**（用户原话「不需要回退，永远等服务器下发」—— 宁可不动、不写滑块，也不写假值）。做法：`system-bodies.recordStlSegments` 对**无 JUMP** 的计划（同星系直飞）按 (出发天体, 目标天体) 记录 DEPARTURE/APPROACH 两段原生距离（键全大写，独立于按跳键控的跨星系表，互不污染）；`routeMetrics` 在 `legs` 为空（同星系）时查该表。**⚠️ 2026-09-23 复核更正（重要）**：这条路径在真实数据里**从未命中** —— 系内计划的段结构是「转移」（TRANSIT）（实测用户 SFC 原生计划 ZV-307a → ZV-307/Antares Station = 单段 101,655,808 km / 43分59秒 / 2655 单位 STL），不含 DEPARTURE/APPROACH，故 `sameSystem` 表此前恒为空（内置 `public/json/stl-segments.json` 的 `sameSystem` 仍是 `[]`；**2026-09-23 起运行时会把该段记进去**，见下）。此前记作「实测」的 `zv-307a → ANT = 离港 68.0562M + 进近 33.6491M` 其实是**本模型自己的估算行**（FTC 面板该区块标题写明「航线分段（模型估算）」），不是服务器原生值 —— 由此推出的「同星系直飞带原生 DEPARTURE/APPROACH」**不成立**。**系内航线的路程与是否勾选「使用跃迁点」无关**：勾选态原生 101,655,808 km vs 直飞口径几何 101.7053M km 与「直飞口径」101.7053M 的 0.05% 比法是**跨样本无效**的（后者是已删除的自建模型估算行，不是原生值）—— 已作废，见下方第四轮条目；`planRoutes` 对同星系航线两种模式都返回 `natural`（legs 为空，gateway 候选恒空）。因此 `missingModelInputs` 对系内航线统一给出「该航线是系内飞行（同一星系）：服务器计划用的是「转移」（TRANSIT）段…换模式无用」，不再建议「取消勾选改走直飞」（无效操作），也不再让系内航线去「生成一次计划等下发」（等不到）。**2026-09-23 第三轮（本项）**：段名/字段核实完成（`PrunApi.SegmentType` 含 `'TRANSIT'`、字段就是 `FlightSegment.stlDistance`，只有一个候选段名）→ `recordStlSegments` **现在会记录这一段**（同星系表的独立字段 `transit`，不伪造离港/进近），`routeMetrics` 给出 `transitKm`（整段原生路程；⚠️ **该值随计划时刻变**，不是航线常数，见下方第四轮条目）供面板展示/诊断；因此「生成一次计划」对系内航线又变成**有效**操作（数据到了就有几何）。**但 `missingModelInputs` 仍判缺、不写滑块** —— 转移段的**燃料与时长口径都未标定**，不能拿未标定口径去写玩家的 f。**交叉验证（夹具船：标准引擎 / 罐 3500 / 质量 2140t → 载重因子 0.7315；原生计划 ZV-307a → ZV-307：d = 101,655,808 km / 2639 s / 2655u，原生平均速度 38,521 km/s）**：① 燃料：`C_F×f×d` 要 f ≈ 0.9164 才能给 2655u（档位 f=0.90 给 2607.5u / −1.8%，f=1.0 给 2897u / +9.1%），而罐口径 `0.98×罐×min(f,0.5)` 最大只到 1715u（−35.4%）—— 两口径互斥；BTF 另一条原生转移段（罐 1500、d = 520.38M km、f=0.05、74u）则是罐口径 −0.7% 精确、`C_F×f×d` 高 **10.0×**。⇒ **燃料口径不可信**（单样本无法判定，必须实测）。② 时长：模型 v(f) ∈ [39,239, 55,012] km/s（载重因子已含），**恒高于**实测平均速度 38,521 km/s（f=0.05 快 1.02×，f≥0.2 饱和后快 1.43×；忽略载重因子时 1.95×）⇒ 原生的 (2655u, 2639s) 不落在模型曲线上（要匹配时长只能 f≈0.05，此时燃料差 95%）。**已知局限：系内航线的时长是模型估算（巡航式 d/v(f)），未按加减速段标定** —— 误差 1.02–1.43×，方向恒为模型偏快；未消费记录里的原生 `transitSeconds`（它绑定记录当时那条计划的 f/质量，按当前 f 复用会把时长钉死、把最优解带偏）。**待办（解锁自动写滑块的前置）**：一次受控实测 —— BTF 固定航线 + 固定 f、**只换 STL 罐容量**：燃料随罐变 = 罐口径（同星系改成 `0.98×罐×min(f,f_sat)` 结构），不随罐变 = `C_F×f×d` 口径（维持本式）；测完删掉 `fuel-model.missingModelInputs` 里的 `transitCalibrationPending` 那一条即可放开。几何来源（**无回退**）：同星系 → 按 (出发天体, 目标天体) 的原生记录（DEPARTURE/APPROACH 拆分，或真实结构「转移」（TRANSIT）的整段路程 — 存于同记录的 `transit` 字段；查得到时仍因口径未标定而不写滑块，见上）；跨星系 → 按跳键的原生记录；查不到 → `undefined` → `missingModelInputs` 判缺 → 不写滑块，等服务器下发该航线的原生段记录（SFC 推送门按几何签名放行重算）。**代价（用户知情取舍）**：从未预览过 / 服务器从未算过的航线，SFC 不再写滑块（FTC 面板仍显示结果但带 `inputIncomplete` 警告、不写共享参数），直到该航线的原生 STL 段入库；三条几何来源仅剩一张表（`rprun.ftc.stl-segments.v1`）。持久化 `rprun.ftc.stl-segments.v1` 为旧格式超集（旧 `depart/approach` 原样保留 + 新增 `sameSystem`），旧缓存/旧内置 JSON 可读；写入有 1000ms 防抖（与 `rprun.ftc.bodies.v1` 同口径，批量采集时避免每条记录都全量 `JSON.stringify` + `setItem`）；面板「导出 STL 段数据」与 `build-stl-data.mjs` 同步带上 `sameSystem` —— 后者会拒绝把**自己的输出**当输入（入口形状校验 + 非空输入但三类解析结果全空则报错退出，否则会把条目值 `[key, number]` 全当无效跳过、静默写出空表覆盖内置数据）。**首次预览时序**：SFC 联动由「目的地输入框 value 变化」（先于服务器重算）与「`C.MissionPlan.table` 文本变化」（服务器重算完成，`SHIP_FLIGHT_MISSION` 的 store 监听同步执行、先于 DOM 刷新）两个信号触发；前者先到时同星系记录尚未入库 → 判 `incomplete` 不写滑块，此时**不**标记该航线 settled，等表格文本变化再算一次即可拿到服务器几何（否则首次设置目的地会永远拿不到几何，只能沿用旧参数）。**2026-09-23 收尾（有界重试）**：该「不标记 settled」的口子本身无退避无上限 —— 残缺航线永不标记 → 每次 DOM 抖动（拖滑块/打字停顿/游戏自身重渲染）都完整重算一次（全量网格扫描 + 蓝图缺失时 6s 阻塞）；且 T1（表格文本变化）与 T2（输入框 value 变化）会对同一 key 并发跑两次。现改为每磁贴一个纯状态机 `sfc-route-push-gate.ts`（2026-09-23 二次修订：删掉「试满 N 次放弃」——上限若在数据到达之后才生效会永久放弃该航线，与「永远等服务器下发」直接冲突）：①同键同签名在途只跑一次（`pending`）；②同键同签名已跑过一次（无论结果完整与否）不再重复计算（`settled`）；③新 key / 签名变化 → `run`。签名用**单调信息量计数**（`orbitStore.bodyCount` + 三张原生 STL 段表条数），**刻意不用 `bodiesVersion`**：拖滑块会触发服务器重算，每份新计划都带来新位置/时刻观测 → `bodiesVersion` 每次都自增 → 签名每次都变 → 界永远咬不住（等价于退回无上限）。签名变化（原生 STL 段入库 / 浏览星系数据增长）时**必定放行**，保证「服务器数据到了就一定算得出来」；同签名只算一次 ⟹ DOM 抖动不触发重算（防无上限重算）。FLEET 链式飞行时间（`chain-flight-time.ts`）原先两轮 `routeMetrics(route, {departMs, arriveMs})` 只为按预测时刻取回退几何；回退删除后已简化为单轮 `routeMetrics(route)`（几何与时刻无关 → 输出不变）。复现脚本：`scripts/verify-ftc-geometry-source.mjs`（真实 `routeMetrics`/`computeFtcPlan`/`sfc-route-push-gate` 在 Node 下驱动，**19 条**：记录键与持久化兼容 8 条；几何来源（记录 / 无记录负对照 / 跨星系回归）5 条；编排层 3 条（`browse:false` 不开窗、`browse:true` 开窗取几何、两条路径在**同一几何输入**下 `best.fuel` 一致、残缺不写滑块）；推送门 3 条（同键在途去重、同签名只算一次且永不放弃、签名变化必放行）。注意替身里 `browse` **不是** no-op：`showBuffer` 计数且只有开过窗的星系 `hasSystemData` 才为 true，故「开窗差异」是真断言；「两条路径一致」仅指相同几何输入 → 相同结果，**不**声称端到端一致。
- **系内「转移」（TRANSIT）段：距离不是航线常数 + 提示/日志降噪**（2026-09-23 第四轮，用户实机日志驱动）：
  - **旧「差 0.05%」已作废**：`101.7053M km` 从来不是原生值 —— 是已删除的自建轨道模型的估算行
    （FTC 面板「航线分段（模型估算）」的 68.0562M + 33.6491M，见 `scripts/lib/ftc-node-fixtures.mjs`）。
    旧文案把它硬编码进模板，于是同一条警告里既打印本次读数（实机日志为 88.87M）又说「差 0.05%」
    —— 两者实差 12.6%，自相矛盾。现规则：文案里的数字一律**现算**，禁止复用历史样本。
  - **`88.87M` 只能是运行时记录值**：该分支唯一数字来源是 `transitKm`
    （`sameSystemRecords['ZV-307A|ANT'].transit.distanceKm`；`recordStlSegments` 每份计划都覆盖该键，
    持久化在 `rprun.ftc.stl-segments.v1`）。仓库里没有任何 88.87M 常量（全仓搜索无命中），
    内置 `public/json/stl-segments.json` 只有 depart/approach 两节、ZV-307A 只有 `ZV-307A|*`
    = 74,327,215 —— 故它必然是某份**当时**的计划写下的值。
  - **同一航线的原生转移距离会随计划时刻变**（不是航线常数）：BTF 数据里同航线同船同 f 的点间漂移
    （`data/ftc-calibration/btf-load-sweep-2026-08-29.md`：HRT→VH-331g 报 520,267,630 → 522,220,425），
    且报告值**大于两体轨道半径之和**（46.81M + 440.95M = 487.8M km）⇒ 它是转移路径的弧长而不是两点
    直线距离。⚠️ 记录**没有时间戳**，故无法追溯某个值属于哪份计划（后续可选改进：记录 `recordedAt`）。
  - **文案预算**：SFC 侧一条提示 = ≤2 句 + 一句动作指引；口径细节（两口径互斥、时长偏快 1.0–1.4×）
    只放在本文件与 FTC 面板的「输入不完整」提示里（面板在系内转移段场景追加一句指向本条目）。
    实测：转移段口径未标定文案 96 字（旧 430+ 字），「系内 + 星系 id」两成因 229 字。
  - **降噪（T3 vs T1）**：tile ready（T3）首推时服务器计划尚未到达 → 判残缺是时序产物 →
    `console.debug`；只有 MissionPlan 表格刷新过（T1，服务器计划已到）仍残缺才 `console.warn`。
    实现：per-tile `planSeen` 标记（`sfc-auto-fuel-settings.ts`，与 `tileRoutes` 同形式的 WeakSet）
    + 纯函数 `sfc-route-push-gate.incompleteLogLevel`（`verify-ftc-geometry-source.mjs` ⑥ 锁定
    false→'debug' / true→'warn'）。「残缺不写滑块」的语义不变（仍由 `missingModelInputs` + 门控锁定）。
  - **只列成立的成因**：系内已从转移段拿到几何时，「星系 id 查表没命中」不成立 → 不再拼这条
    （旧日志里它与「几何已按转移段记录」并存 = 自相矛盾）；锁在 `verify-ftc-gap-guidance.mjs` ⑦。
- **FTC 输入完整性门控**（2026-09-23 修复「SFC 自动拉条 ≠ FTC 面板结果」，**几何来源口径已被上一条取代**）：同星系航线的 STL 燃料只有一个来源 `stlDistanceKm`，当时它只能回退 `liftOffKmAt(起点) + liftOffKmAt(终点)`（起终点到本星恒星的**轨道半径**，不是 `STL_EST_*` 常数，`legs` 为空的同星系航线也查不到任何记录）。**空间站轨道不在内置数据里**（`public/json/stations.json` 只内置归属星系，仅 HRT 带轨道），只能靠浏览星系（`browseSystems` → `DATA_DATA systems.celestialBodies`）在运行时积累（持久化 `rprun.fio.orbit.v1`）。于是：FTC 面板（`browse:true`，会浏览起终点星系）几何完整 → `f=0.2`；SFC 联动（`browse:false`，设计上不许开窗）`liftOffKmAt(空间站)=undefined` → 同星系分支 `stlFuel ≡ 0`（燃料无梯度、时间仍有梯度）→ `findBalanceOption` 退化 → 写成 `f=1`（修复前）/`f=0.05`（退化保护后），与面板不一致。修复（三层，`fuel-model.missingModelInputs` + `ftc-compute` + `sfc-auto-fuel-settings`）：①`missingModelInputs(ship, metrics)` 纯函数判定必需输入（**无条件**查 `stlDistanceKm`（undefined 或 =0）——两条分支都消费它（跨星系时它是 `stlHours` 的回退项，缺了时长被静默记 0）；跨星系再追加 `stlRemaining/stlFuelCapacity`）；②输入残缺时 `computeFtcPlan` **不写**共享参数（`setFtcFuelSlider/setFtcReactorUsage` 跳过），返回 `inputIncomplete` 列表 + 警告 message，SFC 联动据此打印警告并跳过滑块刷新（宁可不动，也不用残缺输入覆盖面板已算好的参数），`lastFtcCompute.complete=false` 让 `waitForFtcCompute` 返回 `'incomplete'`（DEPART 立刻沿用当前设置，不再等 8s 超时）；③证据口径（**不**声称「两条路径端到端一致」）：模型在**相同几何输入**下输出一致（单测锁定 ZV-307a→ANT 的 `best.fuel=0.2`），且**用面板实测 `d` 复算**与面板结果吻合（面板 `d=101.8808M km → f=0.2 / STL 580.7205u`；该 `d` 是当时模型自建几何——几何改为服务器下发优先后面板 `d` = 原生 101.7053M km → STL 579.72u）。SFC 联动路径本身不开窗、几何确实可能残缺，此时按 ② 拦下而非硬算。**不做几何缓存**：三条几何来源均为进程内共享且跨会话持久化的 store（`orbit.ts`→`rprun.fio.orbit.v1`、`system-bodies.ts`→`rprun.ftc.bodies.v1`、原生 STL 段→`rprun.ftc.stl-segments.v1`），面板与 SFC 联动同属一个 content script 的同一模块实例——面板补齐几何后 SFC 重算即可见，故「复用此前几何」分支不可达（2026-09-23 复核后删除；其缓存键用 `planRoutes` 原始输入文本、不含飞船、TTL 6h 亦无依据）。复现脚本：`scripts/verify-ftc-input-consistency.mjs`（含 `computeFtcPlan` 门控集成用例：stub loader 在 Node 里驱动真实编排层，断言残缺输入不写滑块）。
- **系内「转移」段几何 + 燃料口径标定 + 星系 id 反查**（2026-09-23 收尾，四个子项）：
  - **几何**：`system-bodies.recordStlSegments` 把**无 JUMP** 计划的 TRANSIT 段记进同星系表（独立 `transit` 字段，不伪造离港/进近），`routeMetrics().stlDistanceKm` 可回退到 `transitKm`。⚠️ 该值是**转移路径弧长**（大于两体轨道半径之和）且**随计划时刻（相位）漂移**，不是航线常数；记录无时间戳，无法追溯某值属于哪份计划。
  - **燃料口径 = 罐口径（已标定）**：`转移燃料 = 2 × 0.49 × 罐 × min(f, 0.5) = 0.98 × 罐 × min(f, 0.5)`，**与距离无关、与载重无关、f ≥ 0.5 饱和**。依据 BTF 三组控制实验（`data/ftc-calibration/btf-load-sweep-2026-08-29.md`：§1 距离漂移 0.7% 而燃料仅 74→76u、§2 f 扫描 74/147/293/439/731/731、§3 载重 3000 结果几乎相同）；`C_F×f×d` 口径被证伪（同航线罐 1500 高 10×）。系内分支已改用它，`transitCalibrationPending` 门**已删除** ⇒ **系内航线恢复写滑块**。**时长仍是模型估算**（未按加减速段标定，偏快 ~10%：模型 2395 s vs 原生 2639 s）。
  - **星系 id 反查**：SFC 地址框把空间站目的地规范化成**所属星系 id**，而服务器记录按**实际天体/空间站 id** 键控 → 查表前用 `route-model.lookupStationInSystem()` 反查（`public/json/stations.json` 6 个空间站分属 6 个不同星系 = **一一对应**；合并运行时 `stationsStore` 后**恰好 1 个候选才反查**，0 个或 ≥2 个一律拒绝——宁可不写也不猜）。只改**查表键**，不改 `route.toBody/fromBody` 的对外语义。复现：`scripts/verify-ftc-station-reverse.mjs`。
  - **⚠️ 罐容量来源存疑（未修）**：FTC 面板「罐 N」读的是**蓝图** `performance.stlFuelCapacity`，实船油罐容量在 `storagesStore`（`shipFuelRemainingFor().stlCap`）。用户船 AVI-06JVV 面板显示 3500，但其原生计划 2655u 只能由 **罐 8000 + f≈0.3386** 解释（`0.98×8000×0.3386 = 2654.6u`，误差 0.015%；3500 罐最大仅 1715u）。罐是**乘性因子**，**不影响**选出的最优 f，但影响燃料总量显示与缺口判断 → 待修。
- **FTC 最优参数按【航线】键控**（2026-09-23 由「按飞船」改为「按航线」；localStorage 键 `.v2`→`.v3`→`.v4` 逐次强制作废）：键 = `` `${ship}|${起}|${终}|${nat|gw}` ``（`ftc-fuel-settings.ftcRouteKey`，与 `lastFtcCompute.key` 是**同一个字符串变量**）。**为什么必须按航线**：只按船时，船换了目的地而新航线算不出几何 → 会拿**上一条航线**算出的值去写新航线滑块（独立的错误写入面）。**为什么必须换键作废**：`f=1`/`r=1` 本身是**合法**取值（f=1 是最快档；同星系航线反应堆网格恒为 `[1]`），**无法用数值校验区分脏值与合法值**，只能整体换 key（旧实现留下的 `.v2` 脏值 `f=1` 就是靠 `.v3` 作废的）。历史由来（按船键控）：`ftc-fuel-settings.ts` 的燃料/反应堆参数按 `ship registration` 存 map（`getFtcFuelSlider(ship)`/`setFtcFuelSlider(ship, v)` 等，localStorage 键带 `.v2`）。环线/多船并行时每船 SFC 面板（`OPEN_SFC` 是 `silent=false`，执行后面板留在屏幕不关闭）同时打开，每船 `pushRouteToFtc → computeFtcPlan` 都会写自己的最优值——若共用一个全局 ref，后算完的船会覆盖全部面板（`applyFtcSettings` watch 把全局值刷进每块滑块），导致飞船带错燃料起飞并反复抖动（控制台可见 `set 0.1 → 0.2 → 0.15 → 0.2` 抖动）。`DEPART.waitForFtcFuelSlider` 也须按 `registration` 读该船参数。setter 加同值短路，避免重复触发 watch/localStorage 写入。
- **STL 燃料/速度计入载重（2026-08-29 BTF 载重扫描实测，`fuel-model.ts`）**：着陆/起飞燃料 = 基线(距离模型) × `(1 + landingLoadCoef×载重吨)`，`landingLoadCoef` 按引擎（标准/advanced/glass/超推力 2.2e-4、节油 2.7e-4）；STL 段速度（转移/离港/进近）按 `(整备质量/当前质量)^loadExp` 减速，`loadExp` 逐引擎标定（节油 0.87、标准/advanced/glass 0.6、超推力 0.5），替代旧「推力受限 (a/G)^0.55」修正——旧模型对 G 受限船完全不减速，实测载重 600t（G 受限区）速度已降 19%。注意：`mass−operatingEmptyMass` 含燃料重量，实船空载满油时载重项略高估（可接受）。数据见 `data/ftc-calibration/btf-load-sweep-2026-08-29.md`。
- **STL 段燃料基准 = 当前 STL 罐余量**（2026-08-27 实测，`fuel-model.ts` `stlSegmentSpeedFor`/`computeFuelOption`）：跨星系段燃料 `Q = 0.49×余量×min(f, f_cap)`（离港）+ `0.49×余量×f + 8`（进近），段速度 = 各引擎 Weibull(Q)。**关键**：服务器用「段开始时当前 STL 罐余量」而非蓝图罐容量——罐不满（MTRA 转移油）时 Q 变小 → 段燃料少、段速度慢、时间/距离变。`ShipPerformance.stlRemaining` 由 `ftc-compute.ts` `shipFuelRemainingFor()` 从油罐 store（`Ship.idStlFuelStore`→`storagesStore`）实测；缺余量时回退 `stlFuelCapacity`（罐满时两者一致，历史标定仍成立）。实测对照：STL=500 离港 23u（新模型 24.5，旧罐模型 171.5 差 7 倍）；f=1.0 进近 1731u = 0.49×3500×1+8 精确吻合，离港 289u = 0.49×3500×0.164（f_cap=10.96×流量）饱和。
- **滑块改动必须用键盘，mousedown 拖拽是假象**（2026-08-27 测试教训）：rc-slider 的 mousedown 只改 DOM `aria-valuenow`，**不触发 React onChange**——表格显示陈旧计划，会得出「f/r 滑块无效」的错误结论。SFC 面板用键盘（focus + Home/End/方向键）才会触发重算（状态变「计算中」→「有效」）。自动化用 `setSliderValue`（`src/infrastructure/prun-ui/utils/set-slider-value.ts`）或真实 keydown 事件。
- FIO 公开端点可查轨道数据：`/planet/{id}`（半长轴 m/偏心率/倾角/升交点赤经/近拱点/质量）、`/systemstars/star/{id}`（恒星质量）、`/global/simulationdata`（`PlanetaryMotionFactor`=20，行星运动加速倍率）。FIO 不下发轨道相位——用一次带时间戳的观测反解（方向→真近点角→平近点角零点，半径比→米↔位置单位缩放）。实现见 `src/infrastructure/fio/orbit.ts`。
- **游戏不下发行星相位，但相位已从 bundle 逆向**（`DATA_DATA["systems", id]` 星系详情 / `["planets", id]` 行星详情只有轨道根数 `orbit{semiMajorAxis,eccentricity,inclination,rightAscension,periapsis}` + mass，无 M0/历元/当前位置；`SYSTEM_STARS_DATA` 仅 698 颗恒星含固定坐标）。客户端本地公式（已用日志观测验证，误差 <1%）：**M0 = 0**（世界时间 0 时平近角为 0）、`worldTime = 1451690603 + (t_s − 1451690603) × 20`（`SimulationInterval=86400`、`PlanetaryMotionFactor=20`）、`M = n·worldTime`（`n = √(G·M_center/a³)`，G=6.67384e-11）。`predictPosition` 直接用该公式，**无需观测**即可全量离线预测；输出与 transferEllipse 同一坐标系（km、x/y 交换、`R3(-Ω)·R1(-i)·R3(-ω)` 旋转）。历史 FTC 的 `orbitalToWorld` 用正角（等价逆旋转），方向与游戏相反，是旧相位标定不准的根源。
- **空间站也绕恒星公转**：星系详情 `DATA_DATA["systems", id]` 的 `celestialBodies` 数组含空间站（naturalId 全大写如 `HRT`，无 mass），`orbit` 轨道根数与行星同构（中心=所属星系恒星）。空间站的 `predictPosition` 靠 `resolveParent` 解析中心恒星，轨道积累走 DATA_DATA 被动监听。**游戏无卫星**（所有行星都是 `XX-XXX`+单个小写字母，直接绕恒星；FIO `allplanets` 4155 行星无一例外）。
- **FIO 无空间站数据端点**（`/planet/{空间站}`→204 空、`/system`/`/station`→404；`doc.fnar.net` 不可达）。空间站→星系映射与轨道只能从游戏内获取：`defaultStations` 内置 6 个站（MOR/HUB/ANT/ARC/HRT/BEN）→ 星系映射（无轨道）；空间站轨道根数需浏览含空间站的星系详情（DATA_DATA celestialBodies）积累。内置框架：`public/json/stations.json`（`{ "HRT": { "s":"VH-331", "a/e/i/o/p": 轨道 } }`，仅归属可省轨道）+ `orbit.ts` 的 `stationSystem`/`getStationSystem`/`exportStationOrbits`；FTC 面板「导出空间站」→ `scripts/build-station-data.mjs` 精简内置。FTC `resolveSystemId`/`resolveParent` 优先查内置映射；`liftOffKm`/`liftOffKmAt`（`predictPosition` 离线预测）已随「无回退」删除，不再参与 STL 几何（轨道数据仅剩浏览/导出/诊断用途）。
- **游戏原生命令可打开实体详情界面**（从游戏 bundle 逆向，EntityLink `_link` 用命令字符串拼接 `openBuffer(command)`）：`MS <systemId>`（Map: Star System，打开星系详情）、`PLI <planetId>`（行星信息）、`STNS <stationId>`（空间站）、`GTW <gatewayId>`（网关）、`SYSI <systemId>`（系统信息）、`CO <code>`/`CORPS <code>`/`USR <name>` 等。**执行这些命令会触发客户端自动请求对应实体的 DATA_DATA**（如 `MS VH-331` 打开星系地图并请求 `DATA_DATA["systems", VH-331]`，orbit.ts 即积累 celestialBodies 空间站轨道）。扩展用 `showBuffer("MS <systemId>", { autoClose, closeWhen })` 即可模拟"用户浏览星系"——FTC **计算时自动浏览**（无手动按钮）：对起终点所在星系（阻塞等待）+ 无轨道空间站的归属星系（后台渐进）依次打开星系详情，轮询 `hasSystemData`（orbit.ts 的会话级 Set，记录已打开过的星系）确认整个星系数据（恒星质量 + 行星/空间站轨道）积累后自动关窗。命令帮助文本在 bundle 的 `Command.*` i18n 消息表（如 `MS` = "Map: Star System"）。
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
- **购买时检测空间站库存**：两层检测。
  1. **空间站仓库库存抵扣**：生成采购清单时，出发地空间站仓库（`originStock`）已有的物资（含组内产物与普通补给）优先以「取货」装船（`originPickupByStop`），采购量在 `purchaseBill` 阶段扣除取货部分——仓库已有不重复购买。
  2. **订单簿供应检测**：按出发地交易所代码（`exchangeCode`）查 `cxobStore` 订单簿（key = `ticker.exchangeCode`）的 `supply`（卖单总量），供应不足的物资把采购量缩减至可用量、`cxBill` 装船量同步缩减并警告（「空间站库存不足（供应 X / 需 Y），采购量已缩减至 X」），防止执行时 `CX Buy` 因库存不足而整体失败。订单簿数据未加载（未打开过 CXOB）时跳过检测、不误报。
- **序 0 空间站行分开展示采购/取货**：装船物资按来源分两行——「采购」= `purchaseBill`（从 CX 购买），「取货」= `cxBill − purchaseBill`（从空间站仓库直接装船，含组内产出 `originPickup` 与仓库已有库存）。
- **进度与脚本**：执行时把计划快照持久化到 `userData.chainRuns.*.plan`，页面刷新后仍按规划样式显示各阶段载重/操作；生成的 ACT 操作包带阶段号（`0 Chain 船名`、`N 站点 Loop 船名`、`M Chain Return 船名`）。**环线主包/站点包/归航包不再 autoDelete**（保留完整脚本供状态列表/云端同步/手动清理），仅到港触发器仍 autoDelete；阶段完成由 `ExecuteActionPackage.vue` 在包执行成功后无条件调用 `markChainStageDone` 写回 `chainRuns` 持久化状态（**不能只依赖 `pkg.autoDelete` 分支**——环线包不 autoDelete 时该分支永不触发，站点/归航状态会永远停在 `arrived`，状态检查无法推进下一阶段）。
- **多船 = 并行分段（唯一方案，已废弃 A/B/C 三策略）**：`splitChainPlanAcrossShips(plan, ships, bases)` 按拓扑序把站点切为连续段，每船独立规划其段并同时出动，总耗时 ≈ 单环线 / 船数。切分按**剩余舱容逐站装箱**（当前船装不下重量或体积任一才换下一艘，最后一艘兜底），产物密度（大重量小体积 / 大体积小重量）自然决定段边界，避免某船段载荷超出其容量。跨段产物经出发地仓库接力。传全局 `groupProducedTickers` 保证跨段产物在任何段都不被误采。
- 无货舱（或剩余舱容 0）的船不参与分段。
- **多环线并行**：有环线运行中仍可规划其他环线。表格分「规划中」「运行中」两个页签（`C.Tabs` 样式，`chainTab` 持久化，带计数）：`planTables` 为当前选中配置的实时规划（跳过运行中的船，避免同船重复），`runningTables` 为正在执行的环线进度（优先计划快照 `planSnapshot`——按船合并、不覆盖其他运行中环线的快照；快照未覆盖的从 `chainRuns` 还原）。船名括号标注状态：执行中 `（运行中）`、已完成 `（已完成）`、纯规划 `（CX 代码）`。`execute` 跳过正在执行环线的船（防止 `removeShipChainScripts` 误删运行中脚本），全部被跳过时提示先清理或等待归航。
- **断线恢复（状态检查 + 自动恢复）**：环线各阶段靠到港 FLIGHT_ENDED 告警触发器驱动，网页关闭期间到港告警错过会导致环线卡在当前阶段。`ChainView.vue` 以「船当前停靠位置 + 持久化阶段状态 + 操作包是否仍存在」判断当前阶段（执行成功即 `markChainStageDone` 持久化 `done`，不会重复执行），经 `queueTriggerRun` + 隐藏 ACT 窗口（与触发器引擎同通道）静默执行下一步操作包，`hasPendingTriggerRun` 防重复入队。`runProgress` 按环线顺序执行假设，把**船当前停靠站点之前的所有站**推导为完成（`dockedStopIndex` 前推），旧记录（autoDelete 时代遗留的 arrived/pending）也能被状态检查推进。「状态检查」按钮手动触发；「自动恢复」开关（默认开）在船数据就绪后自动执行，且**服务器重连（页面未刷新）也能再次触发**：模块级 `CLIENT_CONNECTION_OPENED` 监听重置「已恢复」标志（状态放普通 `<script>` 块承载、跨组件实例共享，切换页签卸载/重挂载不丢失），store 重置后重新推送即自动再次检测断线阶段。状态检查无匹配步骤时输出诊断（每船停靠位置 vs 预期阶段），便于核对位置/脚本差异。
- **多端同步（跨浏览器/设备）**：仅同步**各艘船的飞行配置**（`chainRuns` + 该船环线 ACT 包/触发器）；环线面板的**全局配置（分组/基地/船勾选/自动开关）仅本地保存、不参与云同步**（`src/features/XIT/FLEET/chain-sync.ts` + `src/infrastructure/org-api/chain-sync.ts`，后端 `/chain-sync` 端点）。命名空间 = 公司代码（JWT `company_code`）：同账号跨设备共享、多账号天然隔离。**无自动轮询、无启动拉取**——仅在本地环线状态改变（`ChainView.vue` 深 watch：`userData.chainRuns` + 环线 ACT 包/触发器 → `markDirtyShip`）时**防抖 5s 推送**（`pushNow` 串行执行批次）；覆盖方向仅由手动「云端同步」对话框按每船逐项选择（上传=本地覆盖云端 / 下载=云端覆盖本地）。冲突用 payload `updatedAt` LWW + PUT `baseUpdatedAt` 乐观锁（服务端 `updated_at`；409 时重取最新并提示「云端较新，先下拉」，force 覆盖以最新 base 重试一次）；推送前以**内容签名**（剔除 `updatedAt` 与触发器本地 `id`）比对，未实际变化即跳过且不推进时间戳（避免粗粒度 watch 误报把未变化内容以新时间戳推上去、架空 LWW）；应用远端时 `suppressDirty` 抑制由此引发的 markDirty，避免「应用远端 → 重推 → 远端更新」无限循环；手动「清理计划」后显式标脏推「空快照」清除远端陈旧记录；同步基准（CAS base / LWW 时间 / 推送签名）按公司隔离持久化到 localStorage（合并写，忽略并丢弃历史遗留的 `__config__` 基准），页面重载后恢复乐观锁/LWW/签名语义，陈旧本地不再静默覆盖云端。应用远端**只恢复列表与状态、不自动执行**（执行仍由本端状态检查/触发器引擎驱动）。网络不可达 / 未登录（401）静默降级，本地照常。
