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

- rc-slider 滑块（SFC「燃料消耗/反应堆使用量」）用共享工具 `setSliderValue`（`src/infrastructure/prun-ui/utils/set-slider-value.ts`）写入。后台自动设置滑块的功能（如 `sfc-auto-fuel-settings`）与主动扫描（FTC）会互相覆盖参数——写入前先 `reserveTile(tile.anchor)` 独占，结束时 `releaseTile`；后台功能用 `isTileReserved` 跳过被独占的 tile。
- 滑块写入依赖 `getBoundingClientRect` 计算百分比坐标：离屏自动化窗口必须用 `transform: translate(-200vw, -200vh)` 移出屏幕，**不能**用 `display:none`（矩形为 0，写入永远失败）。
- 只填目的地/滑块、不点「开始」时，服务器仍会重算并下发 `SHIP_FLIGHT_MISSION`——用 `getPrunId` 从 `C.MissionPlan.table` 拿 mission id，再从 `flightPlansStore` 读精确计划（时长/燃料/损伤），无需自行建模。以 `C.MissionPlan.stats` 文本内容变化作为「重算完成」信号。
- `SHIP_FLIGHT_MISSION` 的 TRANSIT 段 `transferEllipse.startPosition/targetPosition` 是出发/目标天体在出发/到达时刻的**绝对坐标**（带时间戳的观测）；MS 星系地图**不**下发行星绝对坐标（行星按轨道根数渲染）。飞行计划首段 `departure.timestamp - Date.now()` 可标定游戏世界时钟偏差。
- **FTC 最优方案（平衡点）无需设置档位**（2026-08-27）：`fuel-model.ts` 的 `autoFuelGrid()`（燃料 0.05–1 步长 0.05）与 `autoReactorGrid()`（反应堆 minReactorUsage–1 步长 0.05，滑块下限来自蓝图性能）自动扫描全范围，玩家不再手动输入档位组合。最优=平衡点：设了时间价值（₳/h）时按总成本（燃料费+时间价值）最优（经济平衡）；未设时用 `findBalanceOption()` 的 **Pareto 拐点**——把「最快」（时间最短/燃料最多）与「最省油」（燃料最少/时间最长）连成线，前沿上距线最远的点即折衷平衡点（尽量快同时耗油少，两端都不极端）。**退化保护**（2026-09-23 修复实测 bug）：燃料或时间在全部候选方案中无差异时（`fSpan`/`tSpan` 退化，例如燃料模型拿不到 STL 距离使 `stlFuel` 恒为 0）拐点无意义，**绝不返回最快方案（f=1 拉满）**，改为返回最省油方案（燃料最小 → 反应堆最小 → 滑块最小）；也**不允许**用极小 span 归一化（旧代码的 `Math.max(1e-9, span)`）把浮点噪声放大成全量程——那正是「同星系飞空间站时滑块被写成 1」的放大机制（同星系 `stlFuel = C_F×f×d`，`d = departKm + approachKm` 只要一段缺失即 undefined → 燃料无梯度）。结果只显示最佳方案单行（燃料滑块/反应堆/总时长/STL+FTL 燃料/燃料费/时间成本/总成本）。**全程系内/纯网关飞行（无自然跃迁）不扫描反应堆**（`reactorRelevant` = natPc/jumpCount 为 0 时网格固定为 [1]），反应堆列显示 `--`、提示语不含反应堆。面板另给最优燃料滑块**前后各 5 档**的邻档对比表（`fuel-model.nearbyFuelOptions`，**同反应堆**固定为最优值 + `Δ总时长`/`Δ总成本` 差额列，越界截断），便于评估边际代价。
- **FTC 几何只用「服务器下发的原生 STL 段记录」（2026-09-23 用户拍板；同日二次修订取消回退）**：STL 起降几何（`routeMetrics()` 的 `departKm`/`approachKm` → `stlDistanceKm`）**只取服务器下发的原生 `stlDistance`**；自建轨道模型 `liftOffKmAt` 与统计中位数常数 `STL_EST_*` **已删除**（用户原话「不需要回退，永远等服务器下发」—— 宁可不动、不写滑块，也不写假值）。做法：`system-bodies.recordStlSegments` 对**无 JUMP** 的计划（同星系直飞）按 (出发天体, 目标天体) 记录 DEPARTURE/APPROACH 两段原生距离（键全大写，独立于按跳键控的跨星系表，互不污染）；`routeMetrics` 在 `legs` 为空（同星系）时查该表。**⚠️ 2026-09-23 复核更正（重要）**：这条路径在真实数据里**从未命中** —— 系内计划的段结构是「转移」（TRANSIT）（实测用户 SFC 原生计划 ZV-307a → ZV-307/Antares Station = 单段 101,655,808 km / 43分59秒 / 2655 单位 STL），不含 DEPARTURE/APPROACH，故 `sameSystem` 表此前恒为空（内置 `public/json/stl-segments.json` 的 `sameSystem` 仍是 `[]`；**2026-09-23 起运行时会把该段记进去**，见下）。此前记作「实测」的 `zv-307a → ANT = 离港 68.0562M + 进近 33.6491M` 其实是**本模型自己的估算行**（FTC 面板该区块标题写明「航线分段（模型估算）」），不是服务器原生值 —— 由此推出的「同星系直飞带原生 DEPARTURE/APPROACH」**不成立**。**系内航线的路程与是否勾选「使用跃迁点」无关**：勾选态原生 101,655,808 km vs 直飞口径几何 101.7053M km 与「直飞口径」101.7053M 的 0.05% 比法是**跨样本无效**的（后者是已删除的自建模型估算行，不是原生值）—— 已作废，见下方第四轮条目；`planRoutes` 对同星系航线两种模式都返回 `natural`（legs 为空，gateway 候选恒空）。因此 `missingModelInputs` 对系内航线统一给出「该航线是系内飞行（同一星系）：服务器计划用的是「转移」（TRANSIT）段…换模式无用」，不再建议「取消勾选改走直飞」（无效操作），也不再让系内航线去「生成一次计划等下发」（等不到）。**2026-09-23 第三轮（本项）**：段名/字段核实完成（`PrunApi.SegmentType` 含 `'TRANSIT'`、字段就是 `FlightSegment.stlDistance`，只有一个候选段名）→ `recordStlSegments` **现在会记录这一段**（同星系表的独立字段 `transit`，不伪造离港/进近），`routeMetrics` 给出 `transitKm`（整段原生路程；⚠️ **该值随计划时刻变**，不是航线常数，见下方第四轮条目）供面板展示/诊断；因此「生成一次计划」对系内航线又变成**有效**操作（数据到了就有几何）。**但 `missingModelInputs` 仍判缺、不写滑块** —— 转移段的**燃料与时长口径都未标定**，不能拿未标定口径去写玩家的 f。**交叉验证（夹具船：标准引擎 / 罐 3500 / 质量 2140t → 载重因子 0.7315；原生计划 ZV-307a → ZV-307：d = 101,655,808 km / 2639 s / 2655u，原生平均速度 38,521 km/s）**：① 燃料：`C_F×f×d` 要 f ≈ 0.9164 才能给 2655u（档位 f=0.90 给 2607.5u / −1.8%，f=1.0 给 2897u / +9.1%），而罐口径 `0.98×罐×min(f,0.5)` 最大只到 1715u（−35.4%）—— 两口径互斥；BTF 另一条原生转移段（罐 1500、d = 520.38M km、f=0.05、74u）则是罐口径 −0.7% 精确、`C_F×f×d` 高 **10.0×**。⇒ **燃料口径不可信**（单样本无法判定，必须实测）。② 时长：模型 v(f) ∈ [39,239, 55,012] km/s（载重因子已含），**恒高于**实测平均速度 38,521 km/s（f=0.05 快 1.02×，f≥0.2 饱和后快 1.43×；忽略载重因子时 1.95×）⇒ 原生的 (2655u, 2639s) 不落在模型曲线上（要匹配时长只能 f≈0.05，此时燃料差 95%）。**已知局限：系内航线的时长是模型估算（巡航式 d/v(f)），未按加减速段标定** —— 误差 1.02–1.43×，方向恒为模型偏快；未消费记录里的原生 `transitSeconds`（它绑定记录当时那条计划的 f/质量，按当前 f 复用会把时长钉死、把最优解带偏）。**待办（解锁自动写滑块的前置）**：一次受控实测 —— BTF 固定航线 + 固定 f、**只换 STL 罐容量**：燃料随罐变 = 罐口径（同星系改成 `0.98×罐×min(f,f_sat)` 结构），不随罐变 = `C_F×f×d` 口径（维持本式）；测完删掉 `fuel-model.missingModelInputs` 里的 `transitCalibrationPending` 那一条即可放开。几何来源（**无回退**）：同星系 → 按 (出发天体, 目标天体) 的原生记录（DEPARTURE/APPROACH 拆分，或真实结构「转移」（TRANSIT）的整段路程 — 存于同记录的 `transit` 字段；查得到时仍因口径未标定而不写滑块，见上）；跨星系 → 按跳键的原生记录；查不到 → `undefined` → `missingModelInputs` 判缺 → 不写滑块，等服务器下发该航线的原生段记录（SFC 推送门按几何签名放行重算）。**代价（用户知情取舍）**：从未预览过 / 服务器从未算过的航线，SFC 不再写滑块（FTC 面板仍显示结果但带 `inputIncomplete` 警告、不写共享参数），直到该航线的原生 STL 段入库；三条几何来源仅剩一张表（`rprun.ftc.stl-segments.v1`）。持久化 `rprun.ftc.stl-segments.v1` 为旧格式超集（旧 `depart/approach` 原样保留 + 新增 `sameSystem`），旧缓存/旧内置 JSON 可读；写入有 1000ms 防抖（与 `rprun.ftc.bodies.v1` 同口径，批量采集时避免每条记录都全量 `JSON.stringify` + `setItem`）；面板「导出 STL 段数据」与 `build-stl-data.mjs` 同步带上 `sameSystem` —— 后者会拒绝把**自己的输出**当输入（入口形状校验 + 非空输入但三类解析结果全空则报错退出，否则会把条目值 `[key, number]` 全当无效跳过、静默写出空表覆盖内置数据）。**首次预览时序**：SFC 联动由「目的地输入框 value 变化」（先于服务器重算）与「`C.MissionPlan.table` 文本变化」（服务器重算完成，`SHIP_FLIGHT_MISSION` 的 store 监听同步执行、先于 DOM 刷新）两个信号触发；前者先到时同星系记录尚未入库 → 判 `incomplete` 不写滑块，此时**不**标记该航线 settled，等表格文本变化再算一次即可拿到服务器几何（否则首次设置目的地会永远拿不到几何，只能沿用旧参数）。**2026-09-23 收尾（有界重试）**：该「不标记 settled」的口子本身无退避无上限 —— 残缺航线永不标记 → 每次 DOM 抖动（拖滑块/打字停顿/游戏自身重渲染）都完整重算一次（全量网格扫描 + 蓝图缺失时 6s 阻塞）；且 T1（表格文本变化）与 T2（输入框 value 变化）会对同一 key 并发跑两次。现改为每磁贴一个纯状态机 `sfc-route-push-gate.ts`（2026-09-23 二次修订：删掉「试满 N 次放弃」——上限若在数据到达之后才生效会永久放弃该航线，与「永远等服务器下发」直接冲突）：①同键同签名在途只跑一次（`pending`）；②同键同签名已跑过一次（无论结果完整与否）不再重复计算（`settled`）；③新 key / 签名变化 → `run`。签名用**单调信息量计数**（`orbitStore.bodyCount` + 三张原生 STL 段表条数），**刻意不用 `bodiesVersion`**：拖滑块会触发服务器重算，每份新计划都带来新位置/时刻观测 → `bodiesVersion` 每次都自增 → 签名每次都变 → 界永远咬不住（等价于退回无上限）。签名变化（原生 STL 段入库 / 浏览星系数据增长）时**必定放行**，保证「服务器数据到了就一定算得出来」；同签名只算一次 ⟹ DOM 抖动不触发重算（防无上限重算）。FLEET 链式飞行时间（`chain-flight-time.ts`）原先两轮 `routeMetrics(route, {departMs, arriveMs})` 只为按预测时刻取回退几何；回退删除后已简化为单轮 `routeMetrics(route)` —— **「几何与时刻无关 → 单轮即可」成立，但「输出不变」只在有原生记录的航线上成立**：~~回退删除后输出不变~~（**⚠️ 2026-09-24 复核更正**）对**没有**原生 STL 段记录的航线（典型是系内航线），被删掉的那一轮回退就是**唯一**几何来源 —— 输出从「模型估算值」变成**静默 0 小时**（`stlDistanceKm === undefined` → `totalHours === 0`），而旧实现**只要拿到 option 就标 `ok = true`** ⇒ 0 被当成「算出来了」的真值（面板 `--`、`elapsedMs` 不推进、多船时间均衡与到港库存预测消费 0）—— 这正是 2026-09-24 用户报的 FLEET 环线 bug。本轮已按「判缺 + 反方向记录近似」修复，见下方 FLEET 环线预估条目。复现脚本：`scripts/verify-ftc-geometry-source.mjs`（真实 `routeMetrics`/`computeFtcPlan`/`sfc-route-push-gate` 在 Node 下驱动，**19 条**：记录键与持久化兼容 8 条；几何来源（记录 / 无记录负对照 / 跨星系回归）5 条；编排层 3 条（`browse:false` 不开窗、`browse:true` 开窗取几何、两条路径在**同一几何输入**下 `best.fuel` 一致、残缺不写滑块）；推送门 3 条（同键在途去重、同签名只算一次且永不放弃、签名变化必放行）。注意替身里 `browse` **不是** no-op：`showBuffer` 计数且只有开过窗的星系 `hasSystemData` 才为 true，故「开窗差异」是真断言；「两条路径一致」仅指相同几何输入 → 相同结果，**不**声称端到端一致。
- **⚠️ 上一条（2026-09-23 第三轮）的「口径未标定 → 仍判缺、不写滑块」「燃料与时长口径都未标定」、其「交叉验证 ② 时长」段落（模型 v(f) 恒高于实测平均速度、时长快 1.02–1.43×）以及旧「模型 2395 s vs 原生 2639 s」的对比，均已被 2026-09-23 收尾的 BTF 标定取代**：燃料口径 = 罐口径、时长口径 = 转移段速度式（数字见下方「系内「转移」段几何 + 燃料口径标定 + 星系 id 反查」条目）；`transitCalibrationPending` 门已删除，`missingModelInputs` 对系内航线**只剩两条**判缺理由（「口径未标定」这一条确实已删除）：① 原生转移段记录还没到（`fuel-model.ts` 第 938 行 `const dMissing = metrics.stlDistanceKm === undefined || !(metrics.stlDistanceKm > 0);`）；② STL 罐容量/余量缺失（同文件第 1048 行 `const tank = ship.stlRemaining ?? ship.stlFuelCapacity;`，为 undefined 或 ≤0 即判缺）。同一条里的「0.05% 比法」已作废（见下条），但**「系内航线的路程与是否勾选「使用跃迁点」无关」这一结论成立** —— 判据是 `planRoutes()` 对同星系两种模式都返回 `natural`（`legs` 为空），不是那两个数。 → **已于 2026-09-23 第四轮修正**（见下条）：`isJump` 已扩为 `'JUMP' || 'JUMP_GATEWAY'`，故上文「无 JUMP 的计划（同星系直飞）」应读作「无 `JUMP`/`JUMP_GATEWAY`」（网关航线段结构同构，走跨星系 `#gw` 表）；`missingModelInputs` 对跨星系网关航线的强制判缺（`gatewayMissing`）已删除。
- **FLEET 环线预估：系内航段显式判缺（A）+ 反方向原生记录近似（C）**（2026-09-24，用户报「环线系内航段除首段外全 `--`」）：
  - **症状**：环线各站全在同一星系时（例 `HRT` = `VH-331` 星系的空间站，见 `public/json/stations.json`），面板「飞行」列除首段外全部 `--`（到达时刻 = 出发时刻），汇总「飞行时长」只等于首段。**根因链**：系内 STL 几何唯一来源是服务器原生「转移」（TRANSIT）段记录（`system-bodies.sameSystemRecords`，按 `出发天体|目标天体` **方向**键控）→ 记录缺失 → `routeMetrics().stlDistanceKm === undefined` → `fuel-model.computeFuelOption` 的 `totalKm = 0` → `stlHours = 0`，系内又无自然跃迁（`ftlHours = 0`）⟹ `totalHours === 0`；而旧 `chain-flight-time.ts` **只要拿到 option 就标 `ok = true`**（从不调用现成的 `missingModelInputs`）⇒ 0 小时被当成「算出来了」（`formatFlightDuration(0)` 显示 `--`、`est.ok` 仍为 true、循环里 `elapsedMs` 原地不动 → 后续段都在「出发时刻」算几何）。
  - **缺失估时**：多船分配跳过包含缺失航段的候选分段。到港库存预测只接受所有航段均可估时的整船计划，避免前一航段判缺导致后续到港时间偏早。
  - **A 诚实判缺**：每段先跑 `missingModelInputs(perf, metrics)`，非空 → `leg.ok = false`、`leg.error = '缺原生 STL 段记录'`、`leg.missingInputs = [成因全文]`、`hours = 0`、`arriveAtMs = departAtMs` 且**不推进** `elapsedMs`；`est.ok = legs.every(l => l.ok)` 语义不变。**C 反向近似**（只服务环线预估）三条同时成立才用：① 系内航线（`route.legs.length === 0`）② 前向几何确实缺失（`stlDistanceKm` undefined 或 ≤0）③ `stlSegmentsStore.getSameSystem(to, from)?.transit?.distanceKm > 0`（查表键优先 `metrics.toLookup/fromLookup`，即星系 id 反查后的实体键）；用**近似后的 metrics** 重算 option，补上几何后**再判一次** `missingModelInputs`（罐容量/余量缺失时仍判缺 —— **近似不得掩盖残缺**）。
  - **契约字段**：`leg.approximated = { kind: 'reverse-record', from, to, distanceKm }`、`leg.missingInputs`、`est.approximatedLegs`。**近似只影响时长**：系内转移段燃料是**罐口径** `0.98 × 罐 × min(f, 0.5)`（与距离无关）⟹ 逐 f 的燃料值与原生记录下逐位相同。
  - **可用性与局限**：转移段弧长由两体轨道几何主导，同航线同船同 f 的点间漂移**不到 1%**（`btf-load-sweep-2026-08-29 扫描`：HRT→VH-331g 报告 520,267,630 → 522,220,425 km）；⚠️ 计划时刻不同 ⇒ 相位不同 ⇒ 只是**近似值**。
  - **UI（`ChainView.vue`）**：判缺段「飞行」列 `--（缺原生 STL 段记录）` + `data-tooltip`（成因全文，不截断、不改写；无文案必须 `undefined` 而非 `''`，见 `docs/contributing.md` §Tooltips）；近似段时长加 `≈` 前缀 + tooltip 说明来源；汇总在 `approximatedLegs > 0` 时追加「（含 N 段反向近似）」，`est.ok === false` 时显示「（部分航段无法计算）」。
  - **⚠️ 边界：近似不得用于写滑块** —— FTC 路径（`ftc-compute.computeFtcPlan` / SFC 联动）仍按 `missingModelInputs` 严格判缺、宁可不写（2026-09-23 用户拍板**不变**）。
  - **回归**：`scripts/verify-chain-flight-time.mjs`（**10 条** check，真源驱动：夹具走真实 `SHIP_FLIGHT_MISSION` → `recordStlSegments`；含负向断言「不存在 `ok=true && hours=0` 的段」、跨星系不得误用近似、近似不得掩盖残缺、`elapsedMs` 只推进 ok 段）+ `scripts/lib/chain-flight-time-*.mjs`（loader/stub/fuel-model shim）。**变异验证**：把判缺分支改成 `if (false && unresolved.length > 0)` → 立刻 `PASS 5/10`、退出码 1（原文写在脚本头）。
- **网关航线 STL 几何：段结构同构 + `#gw` 键口径**（2026-09-23 第四轮，实机日志「SFC 选择地址后没有计算燃料」：`AVI-06JVV ZV-194h → VH-331（网关）` 被判「输入不完整（缺 起终点轨道距离）」→ 跳过滑块写入）：
  - **四层串联 bug**：① `recordStlSegments` 的 `firstJump`/`lastJump` 只匹配 `s.type === 'JUMP'`，**漏掉 `'JUMP_GATEWAY'`** → 网关航线的原生离港/进近段一条都不写；② `routeMetrics` 查 `departRec`/`approachRec` 时多加 `!firstLeg.viaGateway` / `!lastLeg.viaGateway` → 表里有记录也查不到；③ `missingModelInputs` 的 `gatewayMissing = context.usesGatewayTransfer === true && isCrossSystem` 强制判缺，其理由「网关结构没有按跳键」**是错误认知**（**已作废，禁止该字样复活**）；④ `fromStar`/`lastLeg.from` 取「末跳**起点**星系」，应取「末跳**到达**星系」。
  - **正确事实**：网关航线**有** DEPARTURE/APPROACH 段（否则飞船到不了网关），在**纯网关**航线上段结构与自然航线**同构**（`DEPARTURE → JUMP|JUMP_GATEWAY → APPROACH`）—— ⚠️ **混合航线不成立**，见下一条（第 5 轮）；`JUMP_GATEWAY` 段的 origin/destination 各含一条 SYSTEM 行 = 网关两端星系（见 `src/infrastructure/fio/routes.ts` 文件头）。首/末跳的键后缀**各自**判定（混合航线可能同时含自然跳与网关跃迁）。
  - **为什么要加 `#gw`**：同一对 (出发天体, 目标星系) 的自然/网关几何**不同** —— 自然离港 = 飞船→跃迁点（在起终点恒星连线上）；网关离港 = 飞船→网关（绕行星轨道、星系内，实测比自然低 **35-50%**）。故网关键加 `GW_KEY_SUFFIX`（`#gw`），自然键保持原样 ⇒ 内置 `public/json/stl-segments.json` 与 localStorage 缓存**零失效**。
  - **网关禁用通配回退**：`getDeparture`/`getApproach` 在 `viaGateway = true` 时只认精确键 `…|…#gw`，**不**回退 `BODY|*` / `*|BODY`（通配是自然口径，用于网关必然高估）；查不到即 `undefined` → 判缺（宁可不动，也不写不准的值）。自然口径「精确键 → 通配回退」不变。
  - ~~**进近键的星系分量 = 末跳【到达】星系**~~ **已于第 5 轮回退（见下条）**：该改动无真实数据依据（真实混合航线的 APPROACH 段在中间、其 destination ≠ 最终目标，该键无论如何都命不中）。写入端恢复 `lastJump.origin`、查询端恢复 `lastLeg.from`；该键降级为**回退**口径（内置通配 / 单跳自然航线），几何首选来源改为航线级 `routeRecords`。
  - **本轮修正的副作用**：localStorage 里旧语义的 approach 精确键会 miss → 自然航线回退内置通配 `*|BODY`（无害）；网关航线需重新生成一次计划（`#gw` 是新键空间，无历史包袱）。
  - **网关拿不到几何现在只剩一种成因**：服务器还没为该航线下发原生 STL 段记录 → 文案给「在 SFC 里为该航线生成一次飞行计划并等服务器算完」。
  - **第 5 轮（2026-09-23）：几何改用「航线级」记录（`routeRecords`）—— 按「首跳/末跳」拼键是错的**。铁证 = 用户 FTC 面板「航线明细（服务器原生飞行计划）」的真实 16 段表（`AVI-06JVV ZV-194h → HRT`，勾「启用网关」）：`0 起飞 / 1 离港 69.1655M / 2 跃迁(自然) / 3 充能 / 4 跃迁(自然) / 5 进近 67.4728M / 6 转移 0.01M / 7 锁定 / 8 网关跃迁 / 9 衰变 / 10 转移 0.01M / 11 锁定 / 12 网关跃迁 / 13 衰变 / 14 转移 0.01M / 15 转移 93.4251M`。⇒ **段结构同构只对纯网关成立**：混合航线里 APPROACH 段（#5）**在中间**且 `destination = Antares I - Hephaestus` ≠ 最终目标 `Hortus Station`；真正到站的 STL 段是 #15 的 TRANSIT；首跳是自然 JUMP、末跳是 JUMP_GATEWAY（⇒ 旧代码拼出 `departGw=''` + `approachGw='#gw'` 的混合后缀）。因此按 (出发天体, 首跳星系) / (末跳星系, 目标天体) 拼的键**必然失配** → `stlDistanceKm` 永远 `undefined` → 判缺 → 跳过滑块写入（用户症状的根因）。
  - **新口径**：`system-bodies` 新增第四张表 `routeRecords`（`stlSegmentsStore.getRoute(from, to, viaGateway)`、计数 `routeCount`）：键 = (首段 origin 实体, 末段 destination 实体[, `#gw`])，`#gw` 按**整条航线是否含 `JUMP_GATEWAY`** 判定（混合航线首末跳类型不同，逐跳判定没有意义）；值 = 该航线**所有**带 `stlDistance` 的段之和（距离与时长）。`routeMetrics` 的 `stlDistanceKm` **首选**它（`routeKm`/`routeSeconds` 同时回传供诊断），取不到才退回「`departKm + approachKm` / `transitKm`」。对系内 / 纯自然 / 纯网关 / 混合**四种形态统一适用**（实测该 16 段航线 STL 总和 ≈ 230.2M km）。持久化随 `rprun.ftc.stl-segments.v1` 的 `route` 字段（旧缓存无该字段 → 跳过，靠服务器重新下发重建）；`exportStlSegments()` 同步导出。`sfc-auto-fuel-settings.geometrySignature()` 追加 `routeCount`（否则新记录入库不改变签名 → 推送门误判 settled）。
  - 回归：`scripts/verify-ftc-gateway-stl.mjs`（16 段混合计划驱动：航线级记录命中 + Σ≈230.2M、自然键零污染、同星系表不被污染、纯网关回退键 / `#gw` 禁通配、`routeMetrics` 首选航线级记录、端到端写滑块、记录未到时判缺且文案可操作）。
- **时间/成本口径修正（2026-09-24，用户实测「FTC 结果与服务器 SFC 不一致」）**：同一份 16 段原生计划（`AVI-06JVV ZV-194h → vh-331` 勾网关：STL 起降 221.1562M km、FTL 50、STL 503、**总时长 20h16m40s、网关费 12,000 ICA**）暴露四处口径错误，四处均已修：
  - **原生计划匹配必须用反查后的实体键**：`FTC.vue` 原先用 `route.fromBody ?? from` / `route.toBody ?? to`（**输入原文**）匹配 —— SFC 把空间站目的地规范化成所属星系 id（`vh-331`），而原生计划目标端是不可变实体 id（`HRT`）⇒ 永远命不中，面板退化成「模型估算」分段（用户症状：16 段原生 → 7 段估算）。现改用 `metrics.fromLookup ?? route.fromBody ?? from`（反查键）。
  - **STL 时长 = 离港段 + 进近段 + 其余（按航线总路程分配）**：旧实现只累加 `departKm + approachKm`，而混合航线有 6 个 STL 段（起飞/离港/进近/3 个转移），且末跳是网关段时 `getApproach` 的键（「末跳起点星系|目标天体」）命不中 ⇒ 进近 1h29m 与到站 TRANSIT 3h59m **静默丢失**（4 小时差的来源）。现按 `stlDistanceKm`（航线级 Σ 全部 STL 段）分配余量，余量走转移段速度式（`stlIntraTransitSpeedFor` = 参考速度 × 质量幂律 × 引擎 f 曲线，锚定 f=0.05）；纯自然（depart+approach === 总路程）与系内（只有总路程）的**段分配**与旧公式一致，但时长数值随转移段速度口径变化（现依赖 f，不再与旧公式逐位相同）。
  - **充能次数 = 跳数 − 1**：充能只为**下一跳**充电，末跳后直接进近（用户计划里 2 次自然跃迁只有 1 个充能段）；旧实现按跳数多算一次。分段估算行同步：只为**自然跃迁**前的下一跳插充能段（网关跃迁不需要）。
  - **网关锁定/衰变 = 各 **10 分钟**（= **20 分钟**/网关段，服务器 BTF 实测，与 f、载重无关）**；旧值 `20/60` 本来就对 —— **当日曾据误读的截图（「各 10 秒」）改为 `20/3600`，现已回滚**。证据来源：CDP 驱动游戏 BTF「蓝图试航模拟」直采 `ZV-194h → HRT`，两组参数（f≈0.03/载重 0 与 f≈0.05/载重 3000t）读数**完全一致**：段 7/11「对锁」10 分钟 0 秒、段 9/13「场衰」10 分钟 0 秒（BTF 的「对锁」/「场衰」即 LOCK/DECAY）；**网关费 = 6,000 ICA/段**（旧实现硬编码 `gatewayCost = 0`，`totalCost` 漏掉这 12,000；它不随 f 变，故不影响最优 f）。常数唯一定义在 `fuel-model.ts`（`GW_PC_PER_H` / `GW_LOCK_HOURS` / `GW_COST_PER_JUMP`，route-planner 反向导入，避免两份副本再次漂移）。
  - **估算分段表的网关跃迁行改用固定 `GW_PC_PER_H`（3.0 pc/h）**（第五处，属**展示层**而非口径）：`buildEstimatedSegmentRows` 旧写法对网关段也用 `vFtl`（自然 FTL 速度，r=1 时 ≈2.84 pc/h）→ 17.08 pc 段显示 6h01m，而服务器原生是 5h41m（用户截图里肉眼可见的不一致）。自然跃迁行**仍**用 `vFtl` —— 回归 ⑭ **双向**锁定（网关行必须 ≠ `vFtl` 口径、自然行必须 ≠ 3.0 口径，防两类段一起改错），并经**变异测试**验证：把该行改回旧写法 → 立刻 `FAIL ⑭`（`expected=20495999.999999996 actual=21650704.225352112`）。
  - 回归：`scripts/verify-ftc-gateway-stl.mjs` ⑨~⑬（三段分配逐位值 + 纯自然/系内等价性 + 残缺不归零、充能次数 = 跳数−1、网关时长 = `gwPc/3 + gwCount×20/60`（反例锁的是已回滚的 `20/3600` 误值）、网关费 6,000/段计入 `totalCost`、反查键匹配 16 段原生计划且输入原文命不中）；`scripts/verify-ftc-balance-degenerate.mjs` 场景 i 的 `totalHours` 当日一度由 4.6667 改为 4.0111，已随本次回滚改回 **4.6667**（4.0111 锁的是错常数）。注：⑬ 断言里锁定/衰变行的 `10,000 ms` 是**夹具**里那次误读的转写值（待按原生表重新抄录为 600,000），它只证明夹具→段行一致，不构成游戏口径断言。
  - **残余偏差（未解决，需标定）**：段速模型对到站 TRANSIT 段偏快 —— 模型 f=0.5 给 ≈58.9k km/s，而用户计划里 93.4251M km 走了 3h59m（≈6.5k km/s，同口径的 BTF 样本是 101.66M km / 2639s ≈ 38.5k km/s）。⇒ 即便段不再丢失，FTC 总时长仍短于服务器（量级小时级），待实测标定到站转移段速度。
  - **待核实（用户证据内部不一致，2026-09-24）**：① 用户给的 16 段时长**之和** = 21h32m29s，与同表「总时长 20h16m40s」差 1h15m49s ⇒ 该总时长不是段表之和（是另一个口径/另一次读数？未经证实，不得当基准引用）；② 网关费只在段 7（锁定）的费用列明示 6,000 ICA，段 11（第二次网关前的锁定）转录为空 —— 12,000/2 段推得 6,000/段，但「每段都收」尚未单点核实。
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
    （`btf-load-sweep-2026-08-29 扫描`：HRT→VH-331g 报 520,267,630 → 522,220,425），
    且报告值**大于两体轨道半径之和**（46.81M + 440.95M = 487.8M km）⇒ 它是转移路径的弧长而不是两点
    直线距离。⚠️ 记录**没有时间戳**，故无法追溯某个值属于哪份计划（后续可选改进：记录 `recordedAt`）。
  - **文案预算**：SFC 侧一条提示 = ≤2 句 + 一句动作指引；口径细节（罐口径与距离无关、转移段时长
    标定式及其误差量级）只放在本文件与 FTC 面板的「输入不完整」提示里（面板在系内转移段场景追加
    一句指向本条目）。实测：口径标定前的「口径未标定」版文案 96 字（旧 430+ 字），「系内 + 星系 id」
    两成因 229 字；标定后该版本文案已不存在（回归 `verify-ftc-gap-guidance.mjs` ⑦ 禁止该字样复活）。
  - **降噪（T3 vs T1）**：tile ready（T3）首推时服务器计划尚未到达 → 判残缺是时序产物 →
    `console.debug`；只有 MissionPlan 表格刷新过（T1，服务器计划已到）仍残缺才 `console.warn`。
    实现：per-tile `planSeen` 标记（`sfc-auto-fuel-settings.ts`，与 `tileRoutes` 同形式的 WeakSet）
    + 纯函数 `sfc-route-push-gate.incompleteLogLevel`（`verify-ftc-geometry-source.mjs` ⑥ 锁定
    false→'debug' / true→'warn'）。「残缺不写滑块」的语义不变（仍由 `missingModelInputs` + 门控锁定）。
  - **只列成立的成因**：系内已从转移段拿到几何时，「星系 id 查表没命中」不成立 → 不再拼这条
    （旧日志里它与「几何已按转移段记录」并存 = 自相矛盾）；锁在 `verify-ftc-gap-guidance.mjs` ⑦。
- **FTC 输入完整性门控**（2026-09-23 修复「SFC 自动拉条 ≠ FTC 面板结果」，**几何来源口径已被上一条取代**）：同星系航线的 STL 燃料只有一个来源 `stlDistanceKm`，当时它只能回退 `liftOffKmAt(起点) + liftOffKmAt(终点)`（起终点到本星恒星的**轨道半径**，不是 `STL_EST_*` 常数，`legs` 为空的同星系航线也查不到任何记录）。**空间站轨道不在内置数据里**（`public/json/stations.json` 只内置归属星系，仅 HRT 带轨道），只能靠浏览星系（`browseSystems` → `DATA_DATA systems.celestialBodies`）在运行时积累（持久化 `rprun.fio.orbit.v1`）。于是：FTC 面板（`browse:true`，会浏览起终点星系）几何完整 → `f=0.2`；SFC 联动（`browse:false`，设计上不许开窗）`liftOffKmAt(空间站)=undefined` → 同星系分支 `stlFuel ≡ 0`（燃料无梯度、时间仍有梯度）→ `findBalanceOption` 退化 → 写成 `f=1`（修复前）/`f=0.05`（退化保护后），与面板不一致。修复（三层，`fuel-model.missingModelInputs` + `ftc-compute` + `sfc-auto-fuel-settings`）：①`missingModelInputs(ship, metrics)` 纯函数判定必需输入（**无条件**查 `stlDistanceKm`（undefined 或 =0）——两条分支都消费它（跨星系时它是 `stlHours` 的回退项，缺了时长被静默记 0）；跨星系再追加 `stlRemaining/stlFuelCapacity`）；②输入残缺时 `computeFtcPlan` **不写**共享参数（`setFtcFuelSlider/setFtcReactorUsage` 跳过），返回 `inputIncomplete` 列表 + 警告 message，SFC 联动据此打印警告并跳过滑块刷新（宁可不动，也不用残缺输入覆盖面板已算好的参数），`lastFtcCompute.complete=false` 让 `waitForFtcCompute` 返回 `'incomplete'`（DEPART 立刻沿用当前设置，不再等 8s 超时）；③证据口径（**不**声称「两条路径端到端一致」）：模型在**相同几何输入**下输出一致（单测锁定 ZV-307a→ANT 的 `best.fuel=0.2`），且**用面板实测 `d` 复算**与面板结果吻合（面板 `d=101.8808M km → f=0.2 / STL 580.7205u`；该 `d` 是当时模型自建几何——几何改为服务器下发优先后面板 `d` = 101.7053M km → STL 579.72u —— ⚠️ **该 `d` 同样是已删除的自建轨道模型的估算行、不是原生值**，见下方第四轮条目）。SFC 联动路径本身不开窗、几何确实可能残缺，此时按 ② 拦下而非硬算。**不做几何缓存**：三条几何来源均为进程内共享且跨会话持久化的 store（`orbit.ts`→`rprun.fio.orbit.v1`、`system-bodies.ts`→`rprun.ftc.bodies.v1`、原生 STL 段→`rprun.ftc.stl-segments.v1`），面板与 SFC 联动同属一个 content script 的同一模块实例——面板补齐几何后 SFC 重算即可见，故「复用此前几何」分支不可达（2026-09-23 复核后删除；其缓存键用 `planRoutes` 原始输入文本、不含飞船、TTL 6h 亦无依据）。复现脚本：`scripts/verify-ftc-input-consistency.mjs`（含 `computeFtcPlan` 门控集成用例：stub loader 在 Node 里驱动真实编排层，断言残缺输入不写滑块）。
- **系内「转移」段几何 + 燃料口径标定 + 星系 id 反查**（2026-09-23 收尾，四个子项）：
  - **几何**：`system-bodies.recordStlSegments` 把**无 JUMP** 计划的 TRANSIT 段记进同星系表（独立 `transit` 字段，不伪造离港/进近），`routeMetrics().stlDistanceKm` 可回退到 `transitKm`。⚠️ 该值是**转移路径弧长**（大于两体轨道半径之和）且**随计划时刻（相位）漂移**，不是航线常数；记录无时间戳，无法追溯某值属于哪份计划。
  - **燃料与时长口径（均已标定）**：燃料 = 罐口径 `2 × 0.49 × 罐 × min(f, 0.5) = 0.98 × 罐 × min(f, 0.5)`，**与距离无关、与载重无关、f ≥ 0.5 饱和**，28 点最大误差 **3.3%**（§2 逐点 ≤0.7%）。
    依据 BTF 三组控制实验（`btf-load-sweep-2026-08-29 扫描`：§1 距离漂移 0.7% 而燃料仅 74→76u、§2 f 扫描 74/147/293/439/731/731、§3 载重 3000 结果几乎相同）；`C_F×f×d` 口径被证伪（同航线罐 1500 高 10×）。
    时长**已标定**（不再是「模型估算」）：`t = d / (V_SAT(引擎) × (min(f, 0.5)/0.5)^k(引擎) × (整备质量/当前质量)^0.75 × 3600) / 状况`，实现于 `fuel-model.ts` 的 `computeFuelOption()` 内 `else if (d !== undefined && d > 0)` 分支（第 583–590 行，走 `stlTransitSpeedFor()`）。
    ⚠️ **2026-09-24 已被取代；2026-10-12 又以「比值」形式回归**：该引擎拟合式**不再被 `computeFuelOption` 当绝对速度消费**（它在 500M km 量级被证伪，高估 ~2×），但经 `stlIntraTransitSpeedFor` **以 `curve(f)/curve(0.05)` 的比值**重新用于表达 f 依赖（锚定下方 f=0.05 的「参考速度 + 质量幂律」）。系内转移段时长 = **「参考速度 + 质量幂律」× 引擎 f 曲线**：`v = 27,512 × (1,271 / 质量_t)^0.78 × (min(f,0.5)/0.5)^fExp / (0.05/0.5)^fExp` km/s（标准引擎 fExp=0.84，节油 0.59；f ≥ 0.5 饱和）。常数与指数来自 CDP 直采 BTF（`btf-scan-2026-09-24 落盘数据`）：`VH-331g → HRT` = 599,220,390 km / 21,780 s（**质量 1,271 t**）= 27,512 km/s；用户实测 `VH-192B → VH-192C` = 619,312,100 km / 40,781 s（**质量 2,727 t**）= 15,186 km/s，模型给 15,168（**差 0.1%**）。⚠️ 教训：27,512 **不是船无关常数** —— 曾按「船无关」落地，被用户实测立刻证伪（同距离量级下 FTC 报 6h15m 而游戏 11h25m，比值 1.81 = 质量比 2.145 的 0.78 次方）。下方「误差 8.8%/9.4%/7.8%」是**旧式**在其标定族内的误差，不代表当前口径。
    误差：§2 标准引擎 12 点最大 **8.8%**（k=0.84，v(0.05)=11,580 → v(≥0.5)=87,036 km/s）、§1 质量曲线最大 **9.4%**（指数 0.75）、§3 交叉检验 ≤**7.8%**；f ≥ 0.5 与燃料同点饱和。旧「巡航速度」模型形状全错（只有 1.4× f 跨度、f≈0.2 就饱和，实测是 7.5× 跨度到 f=0.5）—— 旧文案「模型 2395 s vs 原生 2639 s，偏快 ~10%」是**旧模型**的对比，不是当前标定式的误差。
    两口径就绪后 `transitCalibrationPending` 门**已删除** ⇒ **系内航线恢复写滑块**（回归 `scripts/verify-ftc-gap-guidance.mjs` ⑥/⑦ 已断言不再因口径判缺）。
    残余局限：**未实测引擎**（advanced/glass/hyperthrust）回退标准引擎参数（形状可信、量级未标定）；距离只在一个族上标定，跨距离（101.66M vs 520M km）靠用户原生样本交叉校验；罐容量读数存疑（见本条目末项）。
  - **星系 id 反查**：SFC 地址框把空间站目的地规范化成**所属星系 id**，而服务器记录按**实际天体/空间站 id** 键控 → 查表前用 `route-model.lookupStationInSystem()` 反查（`public/json/stations.json` 6 个空间站分属 6 个不同星系 = **一一对应**；合并运行时 `stationsStore` 后**恰好 1 个候选才反查**，0 个或 ≥2 个一律拒绝——宁可不写也不猜）。只改**查表键**，不改 `route.toBody/fromBody` 的对外语义。复现：`scripts/verify-ftc-station-reverse.mjs`。
  - **⚠️ 罐容量来源存疑（未修）**：FTC 面板「罐 N」读的是**蓝图** `performance.stlFuelCapacity`，实船油罐容量在 `storagesStore`（`shipFuelRemainingFor().stlCap`）。用户船 AVI-06JVV 面板显示 3500，但其原生计划 2655u 只能由 **罐 8000 + f≈0.3386** 解释（`0.98×8000×0.3386 = 2654.6u`，误差 0.015%；3500 罐最大仅 1715u）。罐是**乘性因子**，**不影响**选出的最优 f，但影响燃料总量显示与缺口判断 → 待修。
- **FTC 最优参数按【航线】键控**（2026-09-23 由「按飞船」改为「按航线」；localStorage 键 `.v2`→`.v3`→`.v4` 逐次强制作废）：键 = `` `${ship}|${起}|${终}|${nat|gw}` ``（`ftc-fuel-settings.ftcRouteKey`，与 `lastFtcCompute.key` 是**同一个字符串变量**）。**为什么必须按航线**：只按船时，船换了目的地而新航线算不出几何 → 会拿**上一条航线**算出的值去写新航线滑块（独立的错误写入面）。**为什么必须换键作废**：`f=1`/`r=1` 本身是**合法**取值（f=1 是最快档；同星系航线反应堆网格恒为 `[1]`），**无法用数值校验区分脏值与合法值**，只能整体换 key（旧实现留下的 `.v2` 脏值 `f=1` 就是靠 `.v3` 作废的）。历史由来（按船键控）：`ftc-fuel-settings.ts` 的燃料/反应堆参数按 `ship registration` 存 map（`getFtcFuelSlider(ship)`/`setFtcFuelSlider(ship, v)` 等，localStorage 键带 `.v2`）。环线/多船并行时每船 SFC 面板（`OPEN_SFC` 是 `silent=false`，执行后面板留在屏幕不关闭）同时打开，每船 `pushRouteToFtc → computeFtcPlan` 都会写自己的最优值——若共用一个全局 ref，后算完的船会覆盖全部面板（`applyFtcSettings` watch 把全局值刷进每块滑块），导致飞船带错燃料起飞并反复抖动（控制台可见 `set 0.1 → 0.2 → 0.15 → 0.2` 抖动）。`DEPART.waitForFtcFuelSlider` 也须按 `registration` 读该船参数。setter 加同值短路，避免重复触发 watch/localStorage 写入。
- **STL 燃料/速度计入载重（2026-08-29 BTF 载重扫描实测，`fuel-model.ts`）**：着陆/起飞燃料 = 基线(距离模型) × `(1 + landingLoadCoef×载重吨)`，`landingLoadCoef` 按引擎（标准/advanced/glass/超推力 2.2e-4、节油 2.7e-4）；STL 段速度（转移/离港/进近）按 `(整备质量/当前质量)^loadExp` 减速，`loadExp` 逐引擎标定（节油 0.87、标准/advanced/glass 0.6、超推力 0.5），替代旧「推力受限 (a/G)^0.55」修正——旧模型对 G 受限船完全不减速，实测载重 600t（G 受限区）速度已降 19%。注意：`mass−operatingEmptyMass` 含燃料重量，实船空载满油时载重项略高估（可接受）。数据见 `btf-load-sweep-2026-08-29 扫描`（⚠️ 本文引用的 `btf-*` / `grid-*` / `matrix-*` 标定数据集已于 26.10.15 清理出仓库，可从 git 历史取回）。
- **STL 段燃料基准 = 当前 STL 罐余量**（2026-08-27 实测，`fuel-model.ts` `stlSegmentSpeedFor`/`computeFuelOption`）：跨星系段燃料 `Q = 0.49×余量×min(f, f_cap)`（离港）+ `0.49×余量×f + 8`（进近），段速度 = 各引擎 Weibull(Q)。**关键**：服务器用「段开始时当前 STL 罐余量」而非蓝图罐容量——罐不满（MTRA 转移油）时 Q 变小 → 段燃料少、段速度慢、时间/距离变。`ShipPerformance.stlRemaining` 由 `ftc-compute.ts` `shipFuelRemainingFor()` 从油罐 store 实测（`Ship.stlFuelStoreId ?? Ship.idStlFuelStore` → **`storagesStore.getById`**；⚠️ 2026-09-25：原先误用 `getByAddressableId`——键是**仓库可寻址地址**（siteId / warehouseId / ship.id），与油罐 **store id** 键类型不同 → 永远查不到 → 面板「当前油量：STL 0/0 ｜ FTL 0/0」+ 假缺口，且余量 0 会连带污染转移段燃料/速度基准 0.49×余量×f；回归 `verify-ftc-input-consistency.mjs` ⑤，黄金样本 = 用户实测 3,238/3,500 与 1,974/2,000）。缺余量时回退 `stlFuelCapacity`（罐满时两者一致，历史标定仍成立）。实测对照：STL=500 离港 23u（新模型 24.5，旧罐模型 171.5 差 7 倍）；f=1.0 进近 1731u = 0.49×3500×1+8 精确吻合，离港 289u = 0.49×3500×0.164（f_cap=10.96×流量）饱和。
- **滑块改动必须用键盘，mousedown 拖拽是假象**（2026-08-27 测试教训）：rc-slider 的 mousedown 只改 DOM `aria-valuenow`，**不触发 React onChange**——表格显示陈旧计划，会得出「f/r 滑块无效」的错误结论。SFC 面板用键盘（focus + Home/End/方向键）才会触发重算（状态变「计算中」→「有效」）。自动化用 `setSliderValue`（`src/infrastructure/prun-ui/utils/set-slider-value.ts`）或真实 keydown 事件。该共享写入器现在的顺序是「点击轨道定位 → 边界用 Home/End 补齐 → 方向键消除剩余档位偏差」（先按一次量出步长，越过目标即放弃），载重这类任意值用 `setSliderValueNearest` 接受最近可达档（仍返回实际读到的值，调用方自行容忍）。
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

让 ACT/FLEETACT 执行窗口「不弹出、后台自动跑」，参考 `ChainView.vue` 环线自动执行（`chainAutoTrigger`）：

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

- **生成原生 RT（单船单趟）**：从一艘未运行旧环线的船的计划生成出发仓库、各基地、归航仓库。出发装载用 `cxBill`，每站先卸货后提取，归航按 `finalUnload` 卸货，物料步骤的最小和最大数量均为计划量。出发地默认写入补满 STL 与 FTL（不做线路检测——自动流程没有勾选时机，循环几圈后任何一箱油耗尽都会阻塞航线），仍可手动取消（燃料计算开始后选项锁定，避免写出与时长不一致的补油步骤）采购包仅含现有 `CX Buy`，沿用仓库取货库存保留量。中断时保留已写入的 RT，显示已知航线 ID。分配前核对 Loop、备货和飞行参数，随后在 RT 手动分配，在 RTE 查看进度。
- **RT 窗口识别**：在 `showBuffer` 返回的窗口内读当前磁贴命令并定位控件。创建时同一窗口可从 `RT` 切换为 `RT <id>`，磁贴注册信息可能仍是旧命令。RT 控件按界面语言匹配，简体中文创建按钮显示「创建航线」，装载编辑器的限量行显示「至少」「至多」，数值行显示「最少单位数」「最大单位数」，容量选项显示「最大容量」。同名控件仍须唯一才可点击。打开窗口或填写当前步骤失败可以重试，创建结果不明确时先核对游戏里的航线列表。
- **RT 步骤定位**：原生 `Waypoint.commandsSteps` 在航点下始终挂载，默认仅在悬停时由 CSS 显示。`rt-show-waypoint-actions` 在 RT 内让该操作栏常显。向导按 `Waypoint.destination` 找到航点，再在该航点的 `commandsSteps` 中匹配并点击按钮，简体中文的卸货按钮显示「卸船」。若已点击添加但结果不明确，先核对原生 RT。
- **RT 自动填写**：**默认走 socket 直写**（`native-route-socket.writeNativeRouteBySocket`：建航线 → 逐站加航点/写燃料与反应堆档位/加装卸步骤/写数量 → 按产业链名改名），不开窗口、不点 UI，秒级完成；socket 不可用或接口报错时**回退界面填写**（下面这套原生控件流程，警告里会提示可能残留未完成航线）。**自动启动（2026-11-13）**：FLEET 点「生成原生 RT」时给 `stagedNativeRoute.autoStart` 置位，向导挂载后立即自动跑「算燃料（FTC/BTF 实测）→ socket 直写」全流程，不需要再点「自动填写」；向导发 `started` 后由 `NativeRouteWindow` 清掉标记，同一个窗口重开不会重复建航线（`routeId` 已存在或已离开 `scan-fuel` 阶段也不重跑）。**向导状态**：key 用每次暂存递增的 `sessionId`，同船重新生成会重建组件；socket 写入中途停止后保留已创建的服务端 id，重试前先删半成品再重写、关闭向导时尽力删除（删除失败则保留半成品 id 并停止重试，不再创建新航线）（建航线响应晚于窗口关闭时在创建回调里补删），不会留下重复/无主航线。socket 响应按「响应类型 + 航线 id」匹配，游戏里其它窗口的航线响应不会串位；界面创建的记录只有 RT 号，FLEET 校准与删除都按 RT 号反查服务端 id。界面路径：点击「自动填写」后按顺序创建航线、添加航点、填写并保存每条步骤；停止时等待已提交操作返回，再停在下一项；继续使用同一向导可从当前进度接着做；手动逐步按钮仍可使用。**校准只由玩家点击页签触发**：恢复上次停在「运行中」页的磁贴时不自动发 `SHIP_ROUTES_GET_ROUTES` / 不开隐藏 RTE 窗口（服务端通信必须点出来），切页签与向导写入后才校准。**窗口与运行方式（2026-11-12）**：① 向导跑在**独立窗口** `XIT RTWIZ`（`native-route-staged` 暂存候选船/航点/产业链名），FLEET 只提供入口；原生 RT 展示在**「运行中」页**（页签始终可见，不依赖是否已有环线/规划；进入时自行发现游戏里正在执行的航线），航点/步骤/档位以**游戏航线定义**为准（玩家在原生 RT 改过后卡片随之刷新，本地快照只沿用**燃料档位与上一站都仍匹配**的预计时长（本地记录过反应堆时反应堆也要匹配；系内/纯网关航段不记反应堆，不参与判定；**上游装卸步骤、上游档位、换站或补油步骤变化也会作废下游时长，直到受影响的油罐补满；航线改派给别的船则全部时长作废**（时长是按生成时那艘船的质量/引擎/状况/罐容量算的）。换站的航点即使本站补满也作废「飞到它」与「从它起飞」两段；边界只认**补满**（`CAPACITY`）——玩家把补油改成固定数量后（记录里的 `limited`）出发油量仍与上游消耗有关，不作为边界；航点的「使用跃迁点」偏好（`useGateways`）换了路、或着陆改飞掠（`landing`）都整段作废——着陆改的是「飞到它」与「从它起飞」两段）），沿用运行表的同一套样式（序/星球·空间站/操作/飞行/载重）并带逐站状态标记与 `当前/总站数` 进度（飞行列的「预计」时长来自生成时的 `flightHours`，玩家手改燃料/反应堆档位后该段时长清空）——进度由飞船当前航班目的地（`flightsStore`）或在港位置匹配航点得出（游戏 UI 手动创建的航线只有编码地址，用 `waypoint.encoded` 与 `encodeAddress(flight)` 直接比对；首站与归航站同址时用「上一站 → 目的地」的连续航段定位，归航不会回落到第 0 站；到港后航班消失、只剩在港位置时按「上一次确定的航段位置」取之后的第一个匹配点，`routeStopStates`/`routeProgressText` 因此不会把跑完的归航重置成 1/N）；卡片头部有「查看原生 RT」（`showBuffer('RT <naturalId>')`）与「删除」（确认后 socket 删游戏航线 + 移除记录 + 从缓存的航线定义里摘掉该 RT，卡片即从运行中消失；同 `naturalId` 的重复记录一起清）；「运行中」页签计数含原生 RT 卡片。**显示范围（2026-11-13，2026-11-13 晚改为「全部创建过的航线」）**：`collectNativeRoutes` 先列出**所有本地记录**（创建时间倒序，点页签立刻有内容），再把**游戏里的航线定义**（`SHIP_ROUTES_GET_ROUTES` 的完整列表，含还没分配船只/已经跑完的）与执行状态覆盖到同一条航线的卡片上（`routeIdentity` 按 RT 号去重，执行中的在前；没刷新过的第一次先只显示本地记录）；RTE 只补充「哪艘船在跑」与最新航点，读不到也不影响列表——所以玩家建过的航线还没开跑、或游戏 UI 里改过，都照样显示。校准由**点页签**触发：先发 `SHIP_ROUTES_GET_ROUTES` 取航线定义，再后台打开原生 `RTE`（`native-route-rte`：`showBuffer` 时 `autoClose` 全程隐藏、读完即关；已有的 RTE 磁贴直接复用），按行里的航线号 `RT-XXXX-NNNN` 与船注册号/船名配对（船名要求完整词边界且唯一命中，多个候选视为未解析交给航班推断）；行里没有航线号时按航线名，或按该船当前航班（连续航点，含循环末站→首站）唯一命中推断，多个航线同时命中则不猜（计为 `unresolved`）。**RTE 读不到、或整页执行行都无法配对时列表不变**（本地记录本来就在），不猜也不清空面板。RTE 数据不在 socket 报文里，只能读执行窗口——这是「游戏 UI 手动创建的航线也要显示在运行中」的唯一数据源。数据来源：`native-route-game` 把 `RouteData` 转成展示记录（**航点 `destination` 在响应里不是字符串**——写入请求才是 `{系统}|PLA|STA,{天体}` 编码；响应可能是地址对象/实体字段，统一走 `resolveDestination`，只有真正的字符串才写入 `encoded` 供航班比对，否则 `x.encoded.trim` 会崩；位置按已知星级/空间站/基地/仓库实体 id 反查 naturalId，换不出来保留末段/字段值；`minimum/maximum` 为 `CAPACITY` 的步骤不按 0 吨计算，显示为「×满/×全部」，载重列从该站起显示未知（—）不再累计）。**写航线期间跳过校准**——socket 响应没有 actionId，插入请求会让向导的 FIFO 对位错乱（RTE 窗口自身也可能发请求，因此航线请求与 RTE 读取严格串行）；校准只按**发起请求前已存在的记录**判定「游戏里已删除」——期间向导刚建好的航线不在那份响应里，删掉它就丢掉了本地产业链名与预计时长；记录本体在 `native-route-registry`（服务端 `routeId`、游戏内 `naturalId`、名称、各段档位、步骤；**打开窗口必须用 `naturalId`**，`RT <hash>` 会显示「未找到航线」；localStorage 键按**公司 id** 分（`rprun.fleet.native-route.v2.<companyId>`）——同浏览器换账号后旧记录不属于当前公司，会被校准当成「已删除」清掉；旧的无公司维度键在首次加载时一次性迁到当前公司并删除）；② 界面路径运行期间原生 RT 窗口用 `parkWindow` 移到屏外（属性 + `!important` 的 transform，不影响 `getBoundingClientRect`），结束时 `unparkWindow` 恢复；③ 界面路径提速：`waitForRt` 轮询 20ms，`dismissSuccess` 去掉固定 `sleep(150)`，改为「等成功/失败提示出现 → 点掉」，无反馈时 250ms 防抖。
- **航线命名**：航线名取 FLEET 顶部选中的**产业链分组名**（BSN 的「供应链分组」）。创建后 `nameNativeRoute` 尝试改游戏里的航线名（点 `[class*="Route__name"]` → 出现输入框 → 写入 + Enter）；没有输入框出现就返回 false，由对话框提示玩家手动改名，并在 FLEET 摘要里保留计划名称。
- **原生 RT 的 socket 接口（2026-11-12 从游戏实采捕获，`prun-client-log.json` + `prun-log.json`）**：航线写入**都是单条 action 消息**，`payload.actionId` 为 UUID、`contextId` 在顶层；没有批量接口。**响应有两种**：变更类请求回 `SHIP_ROUTES_ROUTE`（单条完整航线：`{ id, naturalId, name, created, repeats, waypoints: [{ id, destination, landing, fuelUsageFactor, reactorUsageFactor, preferences, steps: [{ id, type, material: { id, ticker }, minimum: { type: 'ABSOLUTE', units }, maximum, retain }] }] }`），删除/拉取回 `SHIP_ROUTES_ROUTES`（`{ routes: [...] }`）。新增的航点/步骤都在数组末尾 —— 后续请求的 `waypointId`/`stepId` 从这里取。服务端不回 `actionId`，所以按「一次请求一份响应」FIFO 串行 await，并且**全局只允许一条航线请求在飞**（`native-route-socket` 内的 promise 队列 `serialize`）——FLEET 的航线校准（`SHIP_ROUTES_GET_ROUTES`）与向导写入因此不会互相抢响应。**建航线的响应无法对位**（请求里没有 routeId，其它窗口的变更同样回单条 `SHIP_ROUTES_ROUTE`）：`socketCreateRoute` 先拉一份现有航线 id，只接受不在快照里的那一条，否则会把别人的航线当成本次新建、后续航点/改名写到它上面、取消时还会把它删掉。同理，**变更类 action 只接受单条 `SHIP_ROUTES_ROUTE`**——其它窗口的列表响应哪怕带着本条航线也只是变更前的状态，认成自己的会让后续步骤改错航点；`writeRoute` 再用「航点数是否增加」复核。实现：`native-route-socket.ts`。
  | 动作 | messageType | payload |
  |---|---|---|
  | 拉取航线 | `SHIP_ROUTES_GET_ROUTES` | `{ actionId }` |
  | 建航线 | `SHIP_ROUTES_CREATE_ROUTE` | `{ actionId }` |
  | 加航点 | `SHIP_ROUTES_ADD_WAYPOINT` | `{ routeId, destination: "{systemId}\|PLA\|STA,{bodyId}", actionId }` |
  | 设航点档位 | `SHIP_ROUTES_EDIT_WAYPOINT` | `{ routeId, waypointId, destination, landing: true, fuelUsageFactor, reactorUsageFactor, preferences: { ftlPreference: 'LEAST_JUMPS', useGateways }, actionId }` |
  | 加步骤 | `SHIP_ROUTES_ADD_STEP` | `{ routeId, waypointId, type: 'LOAD' \| 'UNLOAD' \| 'REFUEL', actionId }` |
  | 设装卸步骤 | `SHIP_ROUTES_EDIT_LOAD_STEP` / `SHIP_ROUTES_EDIT_UNLOAD_STEP` | `{ routeId, waypointId, stepId, material, minimum: { type: 'ABSOLUTE', units }, maximum: {…}, retain: 0, actionId }` |
  | 改名 | `SHIP_ROUTES_RENAME_ROUTE` | `{ routeId, name, actionId }` |
  | 补油步骤 | `SHIP_ROUTES_ADD_STEP`（`type: 'REFUEL'`）+ `SHIP_ROUTES_EDIT_REFUEL_STEP` | `{ routeId, waypointId, stepId, fuel: 'STL' \| 'FTL', source: 'LOCAL_STORE', minimum: { type: 'CAPACITY', units: 0 }, maximum: { type: 'CAPACITY', units: 0 }, actionId }`（`CAPACITY` = 补满；游戏 UI 会先写一次 `ABSOLUTE` 再切 `CAPACITY`，socket 直接写终态即可） |
  | 删航线 | `SHIP_ROUTES_DELETE_ROUTE` | `{ routeId, actionId }`，回 `SHIP_ROUTES_ROUTES`（列表里已无该 `routeId` 才算成功）；FLEET「运行中」的「删除」按钮用它，成功后移除该航线及**同船同产业链**的历史记录（一条船只跑一条航线，旧记录只是历史，否则删掉最新那条会露出上一轮的记录）；游戏里仍有船只使用该航线时服务端会拒绝，错误提示里带说明 |
  游戏写航点的默认偏好是 `useGateways: true`（BTF 试飞也用同一偏好）。地址编码与 BTF 试飞同口径（`flight-test-collector.encodeAddress`），材料 id 用 `materialsStore.getByTicker()`。**航点档位语义（官方手册确认）**：`fuelUsageFactor`/`reactorUsageFactor` 描述「**飞到该航点**」的那一段（首个航点也是目的地，船从当前所在地飞过去），所以第 i 段（1 起）写在 `waypoints[i]` 上；FLEET 卡片「飞行」列展示的是「这一站 → 下一站」，因此取 `waypoints[i+1]` 的档位显示。


- **RT 航点燃料消耗**：按段先算 FTC（`native-route-fuel` → `ftc-compute.computeFtcPlan` 传 `valueOptimal: true`，与 FTC 面板同一套模型与全档扫描，但**选点口径不同**：`pickBestValueOption` 逐档比较「每 +1 个百分点燃料换回多少小时」，边际收益跌破首档的一半就停——临近饱和段速度提升很小、燃料继续涨，正是该停的位置；FTC 面板仍是 Pareto 拐点；向导的三处调用都传 `publish: false`——规划载重、未来出发油量与封顶后的固定档都属于**假设性**结果，同键发布会覆盖玩家当前 SFC 航班正在用的滑块参数与完成信号），**FTC 按「规划出发油量」计算**（`computeFtcPlan` 的 `stlFuelOverride`：出发地有 STL 补满步骤时从罐容量开始，**多段之间按上一段实耗递减，只有存在补油步骤的航点才重置**——BTF 单段试飞同样传入当前剩余油量；油量算到 0 时保留显式 0（不回退罐容量假装满油）；档位被离港饱和点封顶时按**实际写入的最高档**重算消耗与时长（公式兜底的段保持 `estimateGeometry`，重算仍判残缺则不采用并清空时长））；**复用服务器原生 TRANSIT 样本时按 (样本质量 / 规划质量)^0.78 换算速度**（`nativeTransitMassT`），否则补了计划载重时长也不会变化；**样本侧的出发油量同样取「测这份计划时的余额」**（`sampleStlTank`，在应用 `stlFuelOverride` 之前取）——规划 override 只影响候选侧，顶掉样本侧会把样本速度按另一个档位重标定；**样本质量取「测这份计划时的质量」**：游戏按飞船当前状态下发的原生计划就是当前质量，试飞计划则由 `native-route-btf` 用 `setTestFlightSample` 记下测量条件（`massT` = 船质量 + 计划载重、`stlFuel` = 试飞时的出发油量）——试飞响应同样进 `flightPlansStore`，按实时质量/余额换算会把货舱与油量惩罚各算两次；取最优 `fuel`×100 与 `reactor`×100 写入目的航点（含归航）；**所有段最后按「离港燃料饱和点」硬封顶**（`stlDepartureFuelCapPercent` = `10.96×STL 流量`，节油引擎≈8%、标准≈16%），截断会在对话框说明，被截断段的预计时长一并清空（原时长是按更快档位算的）；**FTC 用严格模式（不传 `estimateGeometry`）**——缺服务器原生 STL 段记录（`missingModelInputs` 判缺）或航线不可达的段一律回退 BTF 实测（`native-route-btf`：直接走 socket 发 `SHIP_FLIGHT_CALCULATE_TEST_FLIGHT` —— 与 BTF 面板同一个服务器计算，**不开窗口、不碰滑块**，载重 `payload`/`stlFuel`/`condition`/`fuelUsageFactor`/`reactorUsageFactor` 都是请求参数（`payload` = 该段计划离站舱载 `legLoadWeight` + 船上现有货物 `cargoStore.weightLoad`——`loadOnDeparture` 从空舱起算，现有货物只用于压减可用舱容，服务器试飞只认 `payload`）；每档一次请求（间隔 250ms），试飞 5%–100%（5% 是游戏滑块下限，1% 会被服务器拒绝），**扫完整档位**（不做提前停止：截断样本会把拐点推到截断点上，正是之前给出 25–30% 的原因），用 `pickBestValueOption` 选值（**按反应堆分组**后在同一序列内比较燃料边际收益，避免把反应堆带来的时间差算成燃料收益；边际时间收益跌破首档一半即停；燃料各档无差别时取最快，避免退化到 5%；**跨反应堆按实际时间与油耗比较**——先剔除被严格支配的候选，再取 Pareto 折衷。自然跃迁航线上反应堆给的是常数时间，序列内「时间/燃料」比值会把它抵消掉，旧做法可能选出「更慢又更费油」的劣解），反应堆使用量取 `max(50%, 蓝图 minReactorUsage)`（高下限船不能用低于下限的值试飞），并回传实测时用的反应堆档；**同时把这档位的总飞行时长（小时）带回**（`BtfLegFuel.hours`）——FTC 分支也取 `best.totalHours`，全程不额外请求；FLEET 航点记录存为 `flightHours`，「飞行」列在燃料档位下方显示「预计 X天 X小时」；试飞的油量基准用**罐容量**（航线每站都 REFUEL 补满，用当前余量会让高档位因油不足失败），被服务器拒绝的档位会计入警告；响应里的 `SHIP_FLIGHT_MISSION` 顺带写入原生 STL 段记录）。BTF 也没结果的段才用公式估算补算，再不行保留 25%，都在对话框逐段列出原因，不中断整条生成。首航点无规划入站航段，预填 25%，生成前可逐站修改。**写入的档位一律向上取整且不低于蓝图下限**（`percentAtLeast`：下限 0.653 若四舍五入成 65%，航线就低于下限、自然跃迁段飞不动；BTF 试飞与写入、FTC 重算都用同一个百分比）；**取整改了档位就等于换了档，必须重算**——`applyDepartureCap` 在燃料被封顶**或**反应堆百分比与选中值不同时都走重算，否则时长/油耗还是旧档位的；**出发余量不足的航段只警告不改档**（模型不校验油量，`consume` 会把余量夹到 0；`reportShortfall` 在每段写入前比对 STL/FTL 消耗与已知余量，提示「航线会中途停下」）；**反应堆只在存在自然跃迁时写**（`reactorRelevant`；全程系内/纯网关飞行反应堆不影响时长与燃料，对话框留空即不改游戏原值）：航点编辑器按 `REACTOR USAGE`/「反应堆使用量」定位滑块，找不到或留空就只写燃料消耗，保存前把两个档位一起读回校验。
- **FTC 缺原生记录时的公式估算**：`route-planner.estimateRouteStl()` 给出跨星系 STL 起降距离（离港 70M / 进近 68M km，内置 2018 条离港 + 1082 条进近实测中位数；网关/系内段改用天体到本星系恒星的轨道距离）。**只有** `computeFtcPlan({ estimateGeometry: true })` 消费它，而且现在**只是原生 RT 生成里 BTF 试飞也失败后的兜底**（`native-route-fuel` 的 `estimateLegs`）——系内段用「到恒星的轨道距离」代替真实 STL 距离是粗估，曾导致所有档位算出同样时长、平衡点退化到 5%（用户实测报障），所以不再作为主路径；FTC 面板与 SFC 联动仍按 `missingModelInputs` 严格判缺、绝不写估算值。只有时间受影响——跨星系 STL 燃料是罐口径，与距离无关。

- **FTC「转移速度查询表超出可靠范围」的自愈**：`public/json/transit-speed-table.json` 的 aEff 覆盖极窄（`STL_ENGINE_FUEL_SAVING` / `STL_ENGINE_HYPERTHRUST` 各只有**单一** aEff 行），质量比不同的船会让 `stlTransitTableReliableFor` 对整个燃料网格判「超出可靠范围」→ 整段跳过 FTC（用户实测：某船三段全跳过）。原生 RT 生成的 BTF 试飞顺带把每条 OK 计划的 TRANSIT 段转成 `(q, aEff, v)` 样本写进查询表：`q = 0.98×罐×min(f,0.5)`、`aEff = 加速度×空重/(船质量+计划新增载重)`（`ship.mass` 已含船上现有货物，只叠加 `legLoadWeight`；试飞请求的 `payload` 另加现有货物交给服务器；速度**除以** `conditionFactor` 还原成健康船速度（乘回去等于把惩罚算两次：40% 船况的 2.78h 会被放大到 11h）），段时长 <60s 或距离 <1000km 不入表（噪声大）；样本由 `transit-speed-samples`（`native-route-btf` 调用）落盘 `rprun.ftc.transit-samples.v1`，`fuel-model` 在远端表加载后再叠加（`addTransitSpeedSample` / `restoreTransitSpeedSamples`）。采到该船自己的 aEff 行后，同船后续的 FTC 计算就能通过可靠区间检查——BTF 本来就是因为 FTC 算不了才跑的，等于自我修复。

FLEET 基地规划在拖放分配船只后，按剩余载重、容积和维修占用重算同船基地的补给天数。
基地规划和环线补给都计算消耗品和原料，顶部「CX 购买」控制两种规划生成的采购步骤。
环线规划使用自身勾选的船只和基地试算补给天数，并按分段结果检查每艘船的舱容。
两种规划都应用各基地的仓储上限，环线试算不写回主页面的天数。

环线单船规划入口在 `chain-planner.ts`，`chain-data.ts` 采集输入快照，`chain-plan-core.ts` 负责计算；多船分配在 `chain-allocation.ts`，ACT 构造在 `chain-actions.ts`，`use-chain-planning.ts` 编排响应式规划与异步估时，`chain-commands.ts` 写入运行记录和脚本，UI 在 `ChainView.vue`。模块边界见 `docs/architecture.md` 的 FLEET 小节。

- 单路线由 `planChainRoute` 规划：拓扑排序定航线 → 按目标天数平衡链上运量 → 沿航线模拟舱容。
- **链上装船按下游优先度逐条装载（不按比例缩放）**：装载到下游站点的链输送（`chainPickup`）走 `pushItemsPrioritised`（`src/features/XIT/FLEET/chain-fit.ts`），按 dest 的 daysLeft 升序逐条装填，可装多少装多少，超载 item 跳过；缺货的下游留待下一航次。**关键**——按比例缩放会让每个下游都被裁到一半、谁都拿不到足额，按下游优先度则保证最急的下游拿满。出发地装载 CX 采购物资（`initialItems`）仍用 `pushItemsProportional`（整批按同一比例缩放，超载则让用户减少天数或换大船）。
- **卸货后强制校验货舱再开船**：每个站点包在 MTRA 卸载+提取之后、OPEN SFC/DEPART 之前注入 `Verify Ship Cargo` 动作（chain-actions 写进 `pkg.actions`）；ACT 侧必须注册为**动作**才能被执行——`StepGenerator.generateSteps` 只按 `pkg.actions` 查 `getActionInfo`，只调 `addActionStep` 的步骤会被静默跳过（`src/features/XIT/ACT/actions/verify-ship-cargo/verify-ship-cargo.ts` 用 `addAction` 承载，`generateSteps` emit `src/features/XIT/ACT/action-steps/VERIFY_SHIP_CARGO.ts` 的步骤）。该步骤轮询飞船货舱 `storagesStore.getByAddressableId(ship.id)`，直到本站卸货 ticker 的余量不超过该阶段计划余量（包含后续站配送及本站提取，30s 超时失败）。这是因为 MTRA 用 `waitActionFeedback` 等游戏面板反馈但**底层货运跨客户端→服务器全链路完成有窗口**，若不强制等货舱真正清空就 DEPART，会出现「卸载包没卸完船就出发」。归航包同样校验 `finalUnload` 已离舱，保留计划之外原有货物；该校验不直接读取目的地仓库。
- **组内产出的闭环**：BSN 白名单 + output>0 的 ticker 为「组内产出」，一律不进 CX 采购清单；缺口优先由出发地空间站仓库库存以「取货」（`originPickup`）补足，仍不足则警告。
- 自动适配天数时允许交换船只接段顺序。合并规划按仓库去重汇总库存，分段子计划按各船实际出发仓库验证供给，空子计划也参与检查。裁减下游交付会使候选不可行。返航货物使用本站到归航全程的剩余舱容，为后续必需交付留出空间。分段容量校验只计卸货与必需装载（取两者较大值），可选返航货物可裁剪、不参与校验；站点尺寸会把同一批链货在装、卸两端各算一次，因此候选取不出来时改为逐段重规划，按子计划的峰值必需载荷（无裁减、无缺口）判定可行。
- **购买时检测空间站库存**：两层检测。
  1. **空间站仓库库存抵扣**：生成采购清单时，出发地空间站仓库（`originStock`）已有的物资（含组内产物与普通补给）优先以「取货」装船（`originPickupByStop`），采购量在 `purchaseBill` 阶段扣除取货部分——仓库已有不重复购买。
  2. **订单簿供应检测**：合并规划不传 `exchangeCode`，保留候选站点供分船；分船后每艘船按自身出发地交易所代码（`exchangeCode`）查 `cxobStore` 订单簿（key = `ticker.exchangeCode`）的 `supply`（卖单总量），供应不足时在舱容模拟之前按航线顺序分配可购数量，使采购、分站卸货、载荷快照同步缩减并警告（「空间站库存不足（供应 X / 需 Y），采购量已缩减至 X」），防止执行时 `CX Buy` 因库存不足而整体失败。订单簿数据未加载（未打开过 CXOB）时跳过检测、不误报。
- **序 0 空间站行分开展示采购/取货**：装船物资按来源分两行——「采购」= `purchaseBill`（从 CX 购买），「取货」= `cxBill − purchaseBill`（从空间站仓库直接装船，含组内产出 `originPickup` 与仓库已有库存）。
- **采购执行保留装船库存**：环线的采购组使用净采购量 `purchaseBill`，同时把计划取货量 `originPickup` 传给 ACT 作为库存保留量。只有超过该保留量的仓库库存才能抵扣采购，包括重试前已经买到的物资。
- **本站发船**：`OPEN SFC` 等待本船的目的地输入框出现。共享的地址建议列表同一时间只处理一次选择；紧接自动发船时，必须匹配并选定计划目的地。
- **进度与脚本**：执行时把计划快照持久化到 `userData.chainRuns.*.plan`，页面刷新后仍按规划样式显示各阶段载重/操作；生成的 ACT 操作包带阶段号（`0 Chain 船名`、`N 站点 Loop 船名`、`M Chain Return 船名`）。**环线主包/站点包/归航包不再 autoDelete**（保留完整脚本供状态列表/云端同步/手动清理），仅到港触发器仍 autoDelete；阶段完成由 `ExecuteActionPackage.vue` 在包执行成功后无条件调用 `markChainStageDone` 写回 `chainRuns` 持久化状态（**不能只依赖 `pkg.autoDelete` 分支**——环线包不 autoDelete 时该分支永不触发，站点/归航状态会永远停在 `arrived`，状态检查无法推进下一阶段）。
- **多船并行分段**：`planFastestChainSegments` 沿拓扑序切连续站段，每艘船都可以接任意一段。候选段用该船出发地到段首、段内相邻站、段尾回出发地的方向估时，优先最小化最慢船的闭环时长，同样快时最小化总飞行时长。大船队限制每个站点前缀保留的船只组合数。缺少可用估时时沿用容量分配。逐船子计划按航线顺序扣减共享仓库和交易所供应，跨段产物归航后可供下一轮使用。
- 无货舱（或剩余舱容 0）的船不参与分段。逐船应用库存和订单簿供应限制后，无剩余操作站点的子计划不返回；执行按钮仅在存在非空逐船计划时启用，避免为空计划生成运行记录和脚本。
- **多环线并行**：有环线运行中仍可规划其他环线。表格分「规划中」「运行中」两个页签（`C.Tabs` 样式，`chainTab` 持久化，带计数）：`planTables` 为当前选中配置的实时规划（跳过运行中的船，避免同船重复），`runningTables` 为正在执行的环线进度（优先计划快照 `planSnapshot`——按船合并、不覆盖其他运行中环线的快照；快照未覆盖的从 `chainRuns` 还原）。船名括号标注状态：执行中 `（运行中）`、已完成 `（已完成）`、纯规划 `（CX 代码）`。`execute` 跳过正在执行环线的船（防止 `removeShipChainScripts` 误删运行中脚本），全部被跳过时提示先清理或等待归航。
- **断线恢复（状态检查 + 自动恢复）**：环线各阶段靠到港 FLIGHT_ENDED 告警触发器驱动，网页关闭期间到港告警错过会导致环线卡在当前阶段。`use-chain-recovery.ts` 经 `chain-recovery.ts` 先归一化位置推导进度，再以「船当前停靠位置 + 持久化阶段状态 + 操作包是否仍存在」判断当前阶段（执行成功即 `markChainStageDone` 持久化 `done`，不会重复执行），经 `queueTriggerRun` + 隐藏 ACT 窗口（与触发器引擎同通道）静默执行下一步操作包，`hasPendingTriggerRun` 防重复入队。`runProgress` 按环线顺序执行假设，把**船当前停靠站点之前的所有站**推导为完成（`dockedStopIndex` 前推），旧记录（autoDelete 时代遗留的 arrived/pending）也能被状态检查推进。「状态检查」按钮手动触发；「自动恢复」开关（默认开）在船数据就绪后自动执行，且**服务器重连（页面未刷新）也能再次触发**：模块级 `CLIENT_CONNECTION_OPENED` 监听重置「已恢复」标志（状态放 `use-chain-recovery.ts` 模块作用域、跨组件实例共享，切换页签卸载/重挂载不丢失），store 重置后重新推送即自动再次检测断线阶段。状态检查无匹配步骤时输出诊断（每船停靠位置 vs 预期阶段），便于核对位置/脚本差异。
- **多端同步（跨浏览器/设备）**：仅同步**各艘船的飞行配置**（`chainRuns` + 该船环线 ACT 包/触发器）；环线面板的**全局配置（分组/基地/船勾选/自动开关）仅本地保存、不参与云同步**（`src/features/XIT/FLEET/chain-sync.ts` + `src/infrastructure/org-api/chain-sync.ts`，后端 `/chain-sync` 端点）。命名空间 = 公司代码（JWT `company_code`）：同账号跨设备共享、多账号天然隔离。**无自动轮询、无启动拉取**——仅在本地环线状态改变（页面级 `chain-runtime.ts` 深 watch：`userData.chainRuns` + 环线 ACT 包/触发器 → `markDirtyShip`）时**防抖 5s 推送**（`pushNow` 串行执行批次）；覆盖方向仅由手动「云端同步」对话框按每船逐项选择（上传=本地覆盖云端 / 下载=云端覆盖本地）。冲突用 payload `updatedAt` LWW + PUT `baseUpdatedAt` 乐观锁（服务端 `updated_at`；409 时重取最新并提示「云端较新，先下拉」，force 覆盖以最新 base 重试一次）；推送前以**内容签名**（剔除 `updatedAt` 与触发器本地 `id`）比对，未实际变化即跳过且不推进时间戳（避免粗粒度 watch 误报把未变化内容以新时间戳推上去、架空 LWW）；应用远端时 `suppressDirty` 抑制由此引发的 markDirty，避免「应用远端 → 重推 → 远端更新」无限循环；手动「清理计划」后显式标脏推「空快照」清除远端陈旧记录；同步基准（CAS base / LWW 时间 / 推送签名）按公司隔离持久化到 localStorage（合并写，忽略并丢弃历史遗留的 `__config__` 基准），普通待推送修改也持久化，关闭页签不取消同步，上传完成仅确认对应修改版本；页面重载后补推未完成修改并恢复乐观锁/LWW/签名语义，陈旧本地不再静默覆盖云端。应用远端**只恢复列表与状态、不自动执行**（执行仍由本端状态检查/触发器引擎驱动）。网络不可达 / 未登录（401）静默降级，本地照常。
- **分段返回值**：`ranges` 和 `hours` 与输入船只逐位对齐，非空半开区间 `[start, end)` 表示该船负责的站点。瓶颈站的相邻分段按站点下标确定。视图层用 `stopIds.slice(start, end)` 将区间转换为站点 ID。
