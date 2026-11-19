# 原生 RT 循环执行（XIT FLEET）

> 状态：已实现（待浏览器验收）。纯数据/计算层（步骤 1–3、4 核心、6 数据、8 文档）、向导/规划 UI（步骤 4b、5）与运行中卡片循环状态/补货/预检（步骤 7）均已落地。UI 均需浏览器验收；RTE 阻塞/等待中文文案、min=0 运行语义待实采校准。

给 XIT FLEET 生成的原生 RT 增加可选「循环执行」：写完航点与装卸步骤后打开游戏自带的 Loop，由游戏服务端反复执行同一闭环。循环不依赖浏览器内的 ACT 触发器，关掉页面仍继续跑。

## 目标

- 单船、单航线：出发地 → 各基地（先卸后装）→ 出发地，Loop 打开后自动进入下一轮。
- 循环模式按**一轮**重算运量，按轮数备货，并在 FLEET「运行中」展示循环状态与阻塞。
- 循环模式不生成 ACT 包/触发器，避免同一次到港重复装卸。
- 默认关闭；单趟路径行为不变。

## 非目标

- 不自动在 CX 买卖、不自动维修、不自动处理船况。
- 不做后台轮询；所有服务端请求仍由点击触发（`../contributing.md` 的 ToS 规则）。
- v1 不支持多船分配到同一条循环航线，也不支持多船各自生成循环 RT。
- v1 不支持用 Wait 步骤拉长周期；周期等于飞行周期。

## 现状与约束

- 生成器已写出闭环航点与全部装卸/补油步骤（`../../src/features/XIT/FLEET/native-route-plan.ts` 的 `buildNativeWaypoints`）。
- 当前向导在写完后要求确认 Loop 关闭（`../../src/features/XIT/FLEET/NativeRouteDialog.vue`），执行靠 `FLIGHT_ENDED` 触发器跑 ACT（`../../src/features/XIT/FLEET/chain-actions.ts`）。
- 游戏规则（[官方航线手册](https://handbook.apex.prosperousuniverse.com/wiki/routes/)）：
  - 循环航线在末站步骤完成后从首站重来；Loop 开关在下一轮结束生效。
  - 装卸步骤按最小/最大量移动；不足最小值或目标仓库无空间时原地等待，没有超时。
  - 飞行段阻塞不会自动重试，只能解除分配后重新分配。
  - 循环在 PRO 失效或不同目的地少于 2 个时停止。
  - 同一条航线可被多艘船同时执行；船沿用开始执行时的航线版本，编辑在下一轮生效。
- 航线只能装卸/补油，不能买卖。
- 基地缺料只能等生产；出发地 CX 采购与产物出售必须另行处理。

## 设计

### 模式与资格

- 向导增加「循环执行」复选框，默认关闭。
- 循环模式要求：恰好 1 艘船、至少 1 个基地、至少 2 个不同目的地。
- 航线形状保持 `出发地 → 基地… → 出发地`。首站是目的地，船从当前位置飞过去；循环从首站重新开始。
- 写入顺序：建航线 → 写航点/档位/步骤 → 校验航点数与步骤数 → 打开 Loop → 读回确认。Loop 打开失败时保留单趟航线并提示手动开启。

### 周期与运量

**周期估算（生成时快照）**

- `cycleHours = estimateChainFlightTimes({ ship, origin, stops, legPayloads, refuelAtOrigin: true }).totalHours`。`legPayloads` 取计划的 `legLoadWeight(plan, i, legCount)`（逐段离站载重）；首段按出发地补满油罐、后续段按上一段余油递推（与原生 RT 只在出发地补满一致，`../../src/features/XIT/FLEET/chain-flight-time.ts`）。
- `est.ok === false`（任一段判缺）时不得进入循环模式：得不到可靠周期，列出缺数据段并退回单趟。
- `cycleDays = cycleHours / 24`。循环模式把所勾选基地的 `days` 覆盖为 `cycleDays`，不写回 `base.config`；规划界面天数输入只读，显示「本轮周期」。
- **每轮补给天数 = 周期天数，另给「满载可至」参考**：稳态每轮只送一个周期的量，所以界面的「每轮补给 X 天库存」恒等于周期天数，与基地数量、船舱容量无关（周期短的单基地环线 X 很小）。为避免被当成算错，旁边给出 `ChainPlan.supplyCapacityDays`（一船满载补给能撑几天 = 舱容 ÷ 各基地日耗的重量/体积，只算补给、不含链上输送与返航货占舱；消耗物资缺重量/体积时不出数）。每轮装满这个天数会让基地逐轮囤积、仓储满后 UNLOAD 永久等待，故它只是参考上界。
- **周期逐轮漂移**：估时按出发时刻的天体位置推算，循环每轮实际出发时刻不同，实际周期 ≠ 生成时 `cycleDays`。`cycleDays` 只是写步骤时的快照；不做后台重算（不轮询），运行中卡片的周期标「预计」。

**迭代收敛**

- 闭环：计划 → 逐段载重 → 估时（`totalHours` + 各站 `arriveAtMs`）→ 到港时刻排产库存（`projectedStock`，槽位事件）→ 计划。
- 初值用当前手填天数跑一遍计划取载重；估时得 `cycleDays` 后覆盖天数重规划，并把各站 `arriveAtMs` 折算成 `arrivalHoursByNaturalId` 传入（取货按到港预计库存，`../../src/features/XIT/FLEET/chain-data.ts`）。
- 最多 3 次，`|ΔcycleHours| / cycleHours < 5%` 收敛；不收敛保留最后一次并 warning。载重改时长、时长改到港排产，必须整条闭环迭代，不能只迭代 `totalHours`。

**稳态运量（关键口径）**

- 原生步骤是固定绝对量、每轮重复执行。输入配送量按**稳态流量** = `cycleDays × 日耗（原料+消耗品）`，**不减当前库存**——基地保留原有缓冲，每轮恰好补上一轮消耗。沿用 `need`（`ceil(days×日耗 − 库存)`，`chain-plan-core.ts`）会让固定步骤逐轮少送、基地饿死。
- loop 模式给 `computeChainPlan` 单独的稳态 need 口径；`avail` 仍按到港预计库存 − 自用预留。当前库存只用于首轮可行性与仓储余量警告，不进入重复写入的绝对量。
- **账单天数与 need 同口径**：`collectChainPlanningSnapshot` 在 loop 模式先把 `base.config.days` 覆盖成 `cycleDays` 再交给 `combinedBaseBill`（`chain-data.ts` 的 `billDays`）。只把快照里的 `days` 字段改成周期、账单仍按手填天数算，是错的：手填 10 天、周期 2 天时每轮送 5 倍量，直接超舱抛「环线缺少可执行站点、超出舱容或有未满足的产业链需求。」或顶满基地；反过来手填 2 天、周期 10 天则基地饿死。
- 链上产物提取（基地 LOAD）= 平衡后的 flow，best-effort：减产轮少提、不阻塞。

**步骤 min/max（出发站装载保留背压，其余机会式）**

- 出发站（航点 0）**装载**（`cxBill` 采购/消耗品）：LOAD `min=max=Q`（缺料在出发地阻塞，船不发，「缺料停跑」背压保留）；出发站**卸货**（归航 `finalUnload`）`min=0, max=Q`。
- 其余站点：装/卸都 `min=0, max=Q`——基地提取 LOAD、下游/链上 UNLOAD 均机会式，上游减产时船上货不足 Q 也不阻塞（用户 2026-11-19 定：出发站只改卸货，其他站点装货也 min=0）。
- `min=0` **socket 可写已实采**（2026-11-19）：`EDIT_LOAD_STEP` 与 `EDIT_UNLOAD_STEP` 写 `minimum:{type:'ABSOLUTE',units:0}` 均被服务端接受并回显 `units:0`（**UNLOAD 对称性成立**；新建步骤默认 `min=1`，需显式改 0）。「不足不等待、只按现有量搬运」由手册规则推导（min=0 永不触发「不足最小值」），实机执行行为待确认。目标仓库无空间仍原地等待（仓储背压保留）。

**仓储与慢基地**

- 循环模式**不**按基地 cap 把 `cycleDays` 往下钳（钳了会与其他基地/周期失同步）。改为校验余量：基地当前库存 + 本轮配送量 > 仓储上限，或 cap < `cycleDays` 时，警告「该基地装不下/供不上这个周期」，由玩家缩短周期（减基地/换快船）或扩仓。
- 慢基地：`本轮提取量 / 基地日产量 > cycleDays` 时警告（产出追不上周期）。
- 周期只含飞行，不含装卸停留；界面按「飞行周期」展示，不用它冒充精确到港时刻。

### 备货

**每轮出发地账单**

- `roundBill = cxBill + 每轮 SF/FF 消耗`。`cxBill` = 航点 0 的 LOAD 步骤汇总（`nativeRouteOriginBill`，`../../src/features/XIT/FLEET/native-route-purchase.ts`）。
- 每轮 SF/FF = 整圈消耗：v1 只在出发地补满（REFUEL `CAPACITY`），每轮补油量 = 罐容量 − 归航到港余量 = 逐段消耗之和。由收敛后的估时取逐段 `stlUsed/ftlUsed` 求和（需给 `ChainFlightLeg` 增加油耗字段）；算不出时回退罐容量上限（偏保守）。
- 基地端不采购，只显示本轮卸货/装载与当前库存的差额。
- 罐容量是「吨 → u」换算：`weightCapacity` 单位是吨，要除以燃料单重（SF 0.06 / FF 0.05 t/u）换回 u 并向下取整（`210 / 0.06 = 3499.999…` 的小数尾巴会顺着备货账一路进 CX 采购包）。把吨直接当 u 会把 3500 u 的罐读成 210 u，逐段余油假判缺——单趟估时与 FTC 判缺同样按 u 吃这个值。
- 「该交易所不可买」必须区分「确认无卖单」与「订单簿没下发」：`cxobStore` 只由 `COMEX_BROKER_DATA` 推送填充，而该推送要先打开过对应 CXOB 窗口。所以循环模式下对话框按账单静默打开隐藏窗口（`CXOB SF.AI1`，`autoClose` + `closeWhen` 读到即关）把数据拉回来；仍读不到按未知处理——燃料照进备货包、不报警；只有订单簿存在且 `sellingOrders` 为空才算不可买（排除并提示手动补给）。

**备货轮数 N**

- 默认 1，范围 `1..Nmax`；`Nmax = max(1, floor(min(weightCap / cycleW, volumeCap / cycleV)))`，`cycleW/cycleV` = `roundBill` 的重量/体积（含 SF/FF）。即备货总量不超过一船满载。
- 输入框原样保留键入内容（允许清空），只在 `change` 与计算时钳到 `1..Nmax`。逐键回写会把「清空后输入 5」变成「15 → 钳成上限」，用户输的 5 悄悄变成 Nmax。
- 物料重量/体积没下发（`materialsStore` 缺 ticker）时算不出 `cycleW/cycleV`，`Nmax` 直接取 1：宁可少备一轮，也不按偏小的体积报出偏大的轮数、装不下。
- 采购包只含出发地 CX 可买的物料；SF/FF 若该交易所不可买，只提示缺口、不下单。
- 复用 `billShortfall`，输入 `N × roundBill` 对 `originStock` 算缺口，生成 `CX Buy`（`useCXInv: false`，避免重复抵扣）。

**支撑轮数与运行中补货**

- 「出发地库存可支撑 N 轮」= `min over roundBill 物料 floor(stock / 每轮量)`（含 SF/FF），最先耗尽者决定。
- **燃料只认生成时快照**（`record.fuelPerRound`，`loopSustain`）：游戏 UI 手建的循环航线没有快照，按罐容量估会把整圈当成耗满一罐（支撑轮数偏少、误报「不足 1 轮」），完全不估又会把 SF/FF 从账单里漏掉（支撑轮数偏高）。没有快照时一律不给数字：卡片显示「—」、不报「不足 1 轮」、补货包只含物料。
- 船离港后出发地仓库空出，正好补下一轮。运行中卡片也提供「补货」：按 `N × roundBill − 当前 originStock` 算缺口（不再只在未运行时显示）；出发地非交易所或已备齐时置灰。

### Loop 开关

- `RouteData` 增加 `repeats?: boolean`（服务端响应已带该字段，当前类型未声明）。
- **开关报文已实采**（`prun-client-log.json` / `prun-log.json`，2026-11-19）：`SHIP_ROUTES_SET_REPEAT`，payload `{ routeId, repeats: boolean, actionId }`；响应是单条 `SHIP_ROUTES_ROUTE`（完整航线，`repeats` 已翻转）。与现有变更类请求同口径，套用 `native-route-socket` 的 FIFO 串行 + 按 routeId 匹配单条响应。
- `socketSetRouteRepeats(routeId, repeats)` 写入后直接用响应里的 `repeats` 校验（必要时重新 GET）；失败回退界面路径：打开 RT、点击 LOOP、读回状态。
- Loop 开关与航点/步骤独立：实采时航线只有 3 航点、0 步骤即可切 `repeats:true`。写入顺序仍按「建航线 → 航点/档位/步骤 → 开 Loop → 读回」，但开关不必等步骤写完。
- 关闭循环在下一轮结束生效；删除航线前必须先解除分配。
- 循环开关与补货仍由向导/卡片点击触发。

### 执行与 ACT 关系

- 循环模式不调用 `buildChainActionPackages`，不创建 `FLIGHT_ENDED` 触发器。
- 守卫绑的是「循环已生效」（`loopActive`），不是「勾了循环模式」：估时失败/资格不足时按上面「退回单趟」处理，此时「生成原生 RT」是禁用的，若 ACT 一起禁掉玩家就没有任何可执行路径。两个出口（按钮置灰、`execute()` 早退）共用 `actBlockedReason`，不各写一份文案。
- 生成前检查该船是否仍有旧环线 ACT/触发器；有则要求先清理，避免同一次到港执行两遍装卸。
- 原 ACT 路径保留给单趟、需要 CX 买卖或需要每轮重新规划的场景。

### 监控与异常

**状态来源**

- `RouteExecutionRow` 增加 `status`（从行文本解析 Step blocked / Blocked / Waiting 等，`../../src/features/XIT/FLEET/native-route-rte.ts`）；中/英文文案需从 RTE 实采，读不到保留 `undefined` → 显示「—」。
- `RouteData.repeats` 以服务端为准（见 Loop 开关）。
- **轮次号不可读**：RTE 与 `RouteData` 都不暴露「第几轮」。卡片显示「当前站/总站数」（`routeStopStates`/`routeProgressText`），不伪造轮次计数；页面关闭期间的轮次无法累计。

**校准触发**：面板打开停在「运行中」、点页签、向导写入后各校准一次；不轮询（沿用 `collectNativeRoutes` 现有触发口径）。

**卡片显示**：Loop 徽标、飞行周期（标「预计」）、当前站/总站数、阻塞状态、出发地可支撑轮数。

- 循环模式开着但周期没算出来（没选船/0 个基地/缺载重数据/估时抛错）时，横幅给出具体原因，不留空色条；同时「生成原生 RT」置灰。
- 阻塞/等待告警只挂在循环航线上：关键字是从手册候选词推的，未实采前不外溢到单趟卡片。

**告警（含数据源）**

- 步骤阻塞 / 飞行阻塞：RTE 行 `status`。飞行阻塞提示手动解除分配再重新分配。
- 循环停止：`ship.assignedRoute` 已无该航线但 `repeats` 仍为开。PRO 失效只能由玩家续费后重新分配。
- 船况 <80%：`ship.condition`。
- 出发地库存 <1 轮：支撑轮数 <1。
- 非计划货物占用舱容：`cargoStore` 与计划载重的差额。
- 基地仓储将满：`daysUntilFull` 偏小，或库存 + 本轮配送 > cap。

### 分配前预检

- 恰好 1 艘船、至少 1 个基地、至少 2 个不同目的地。
- 船在出发地，或剩余燃料足够飞到出发地。
- 货舱为空，或剩余舱容足够装下本轮计划；非计划货物必须列出。
- 出发地库存 ≥1 轮（含 SF/FF）。
- 各基地仓储余量够本轮配送（不足则警告，运行中可能阻塞）。
- Loop 已确认打开（`repeats` 读回）。
- 无同船旧环线 ACT/触发器。
- 玩家有 PRO（无法可靠读取时只提示）。

## 数据与接口

- `ChainFlightLeg` 增加 `stlUsed?/ftlUsed?`（每段油耗，供每轮 SF/FF 账单）。
- `ChainPlan` 增加 `supplyCapacityDays?`（一船满载补给能撑几天；界面「满载可至」参考）。
- `NativeRouteRecord` 增加 `loop?: boolean`、`cycleHours?: number`。
- `RouteData` / `NativeRouteView` 增加 `repeats?: boolean`，以游戏定义覆盖本地快照。
- `computeChainPlan` 增加稳态 need 口径开关（loop）；`buildNativeWaypoints` 写 min/max：出发站装载 `min=max`（背压），出发站卸货与其余站点装/卸 `min=0`。
- 新纯函数建议放 `native-route-loop.ts`：周期换算、稳态每轮账单、每轮 SF/FF 消耗、备货轮数上限、可支撑轮数、资格校验。
- 复用 `native-route-purchase.ts` 的缺口算法，输入改为 N 轮账单。

## 实现步骤

1. `native-route-socket.ts` 补 `RouteData.repeats` 与 `socketSetRouteRepeats`（`SHIP_ROUTES_SET_REPEAT`）；装卸步骤支持 `min=0`（报文均已实采，实机执行语义待验证）。
2. `ChainFlightLeg` 补逐段油耗；新增 `native-route-loop.ts`（周期、稳态每轮账单、SF/FF 消耗、N 轮备货、资格校验）。
3. `computeChainPlan` 加稳态 need 口径；`buildNativeWaypoints` 按装载端写 min/max。
4. `use-chain-planning.ts` 支持 `cycleDays` 覆盖与整闭环迭代；`ChainView.vue` 暴露循环模式。
5. `NativeRouteDialog.vue` 增加循环选项、写后开 Loop、N 轮备货与警告。
6. `native-route-registry.ts` / `native-route-game.ts` 记录并合并循环状态；`native-route-rte.ts` 解析阻塞状态。
7. `ChainView.vue` 运行中卡片显示循环状态、补货与预检。
8. 更新 `../feature-patterns.md` 的 Chain Planner 一节和 `../architecture.md`（模块边界）。

## 不采用

- **直接给现有单趟计划打开 Loop**：运量按目标天数计算，与飞行周期不一致；也没有按轮备货。
- **按 need（减库存）写循环绝对量**：固定步骤重复执行会逐轮少送、基地饿死；循环必须按稳态流量写。
- **按基地 cap 钳短循环周期**：各基地共用一个周期，单独钳短会失同步；改为余量警告。
- **Loop + ACT 触发器并存**：原生步骤已经装卸，触发器会重复搬运。
- **多船共用一条循环航线**：每艘船都按同一组绝对量装卸，实际流量按船数倍增，计划失效。

## 验证

回归脚本能覆盖纯模块，覆盖不到的写明归属，不把「有断言」说成「有验证」：

- `../../scripts/verify-fleet-contracts.mjs`：稳态每轮账单、**账单天数随周期**（`combinedBaseBill` 桩按传入 `config.days` 回值：loop + 2 天周期得 2、单趟仍是手填 10 天，CX 采购量 4 而非 20）、**满载补给天数**（舱容 ÷ 日耗，重量先到；缺物料重量/体积时不出数）、周期闭环迭代、备货轮数上限、支撑轮数、循环资格、min/max 按装载端、`repeats` 合并、`fuelPerRound` 的逐段求和与缺段回退（字面量腿，只测消费端）、**真实 `shipFuelRemainingFor`** 的吨→u 罐容量（0.06 t/u × 210 t → 3500 u，向下取整，余量 100）。
- `../../scripts/verify-chain-flight-time.mjs`：真实公式模型下的**生产端**逐段 SF/FF 实耗（`stlUsed = 出发油量 − 到达余量`，系内为 0 而非回退），并与 `fuelPerRound` 对账。
- 循环模式不生成 ACT 的**守卫在 `ChainView.vue`**（按钮置灰 + `execute()` 早退）：脚本只核对两处共用 `actBlockedReason` 的同一文案、没有各自硬编码；置灰与拦截行为本身属浏览器验收。
- 浏览器：循环模式下「执行环线」置灰、tooltip 指向「生成原生 RT」；点不可用按钮不产生 ACT 包/触发器。
- 实机：2 基地 1 船跑满两轮；基地有初始缓冲时多轮不饿死、不溢仓；上游减产轮链上提取/卸载不阻塞；抽掉一种出发地输入验证在出发地阻塞、补货后恢复；航行中补货；关闭 Loop 在下一轮生效。
- 浏览器关闭后循环仍继续；关闭期间不产生扩展请求。
- 打开/点页签才发 `SHIP_ROUTES_GET_ROUTES` / RTE 读取，符合 ToS 例外清单。

## 待实采

- `min=0` 的**实机执行**语义：不足时是否「不等待、只搬现有量」（LOAD/UNLOAD 协议均已确认可写且回显，2026-11-19）；减产轮链上提取/卸载不阻塞需实机验证。
- 界面回退路径写 `min=0`：socket 侧已实采（LOAD/UNLOAD 对称回显），但编辑器「至少」输入框对 0 的反应未知——若被钳制或拒绝，`setLimit` 会在写入中途抛「Minimum 数量未写入。」并留下半成品航线。需实机确认 0 能写入并保存。
- RTE 各状态的界面文案（中/英）。
- 对话框隐藏 CXOB 窗口能否在真实会话里及时回推 `COMEX_BROKER_DATA`（脚本以桩替代）。读不到按「未知即可买」处理，代价是订单簿确实为空时会多下一单燃料。
- LOAD 步骤 `retain` 字段语义（实采回显 46，RPrun 不写不读）。
- 未知步骤类型（`UNLOAD_ALL`/`UNLOAD_FUEL`/`WAIT`/`LOAD_SHIPMENT`/`UNLOAD_SHIPMENT`）目前被 `toStep` 丢弃：手动增删 `UNLOAD_ALL`/`UNLOAD_FUEL` 不触发下游时长作废，是否纳入签名待扩展。
- （可选）`CREATE_ROUTE` 是否能直接带 `repeats`：已有独立 `SET_REPEAT`，非必需。

> 已实采（2026-11-19，prun-client-log / prun-log）：WAIT 协议 `EDIT_WAIT_STEP {amount, unit:'MINUTES'}`、REFUEL `source:'LOCAL_STORE'`+CAPACITY、UNLOAD_FUEL 协议、LOAD/UNLOAD `min=0` 对称回显。详见 feature-patterns socket 表。
