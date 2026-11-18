# 原生 RT 循环执行（XIT FLEET）

> 状态：方案（未实现）。

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

- `cycleHours = estimateChainFlightTimes(...).totalHours`（已包含归航段，`../../src/features/XIT/FLEET/chain-flight-time.ts`）。
- `cycleDays = cycleHours / 24`。循环模式把所勾选基地的 `days` 覆盖为 `cycleDays`，不写回 `base.config`；规划界面的天数输入只读，显示「本轮周期」。
- 现有 `planChainRoute` 按 `days` 计算 `need`/`avail`；覆盖后每轮运量等于一轮消耗/产出。
- 质量变化影响飞行速度：计划 → 质量 → 飞行估时 → 计划，迭代最多 3 次，变化 <5% 收敛；不收敛保留最后一次并给 warning。
- 基地仓储上限仍会钳制天数；若 `supplies-cap` 把某基地压到小于周期，提示「该基地供不上这个周期」。
- 慢基地会拖长整圈：`本轮装载量 / 基地日产量 > cycleDays` 时警告。
- 周期只含飞行，不含装卸停留；界面按「飞行周期」展示，不用它冒充精确到港时刻。

### 备货

- 每轮出发地清单 = `cxBill` + `SF`/`FF` 每轮消耗（优先用现有燃料模型；算不出时用油箱容量上限）。
- 备货轮数 N：默认 1，范围 `1..Nmax`；`Nmax = max(1, floor(min(weightCap / cycleW, volumeCap / cycleV)))`，即最多备到装满船，不允许超过。
- 采购包只含出发地 CX 可买的物料；基地端不采购，只显示本轮卸货/装载与当前库存的差额。
- 船离港后出发地仓库空出，正好补下一轮；运行中的卡片也提供「补货」，按当前库存算缺口，不再只在未运行时显示。
- 显示「出发地库存可支撑 N 轮」，按清单里最先耗尽的物料计算。

### Loop 开关

- `RouteData` 增加 `repeats?: boolean`（服务端响应已带该字段，当前类型未声明）。
- 先实采开关报文：创建航线 → 手动切换 Loop → 对比 `SHIP_ROUTES_GET_ROUTES`。预计是 `SHIP_ROUTES_EDIT_ROUTE` 携带 `repeats`，未确认前不硬编码。
- `socketSetRouteRepeats` 写入后必须用响应或重新 GET 校验 `repeats`；失败回退界面路径：打开 RT、点击 LOOP、读回状态。
- 关闭循环在下一轮结束生效；删除航线前必须先解除分配。
- 循环开关与补货仍由向导/卡片点击触发。

### 执行与 ACT 关系

- 循环模式不调用 `buildChainActionPackages`，不创建 `FLIGHT_ENDED` 触发器。
- 生成前检查该船是否仍有旧环线 ACT/触发器；有则要求先清理，避免同一次到港执行两遍装卸。
- 原 ACT 路径保留给单趟、需要 CX 买卖或需要每轮重新规划的场景。

### 监控与异常

- `RouteExecutionRow` 扩展出状态（Step blocked / Blocked / Waiting）。中文/英文文案需从游戏 RTE 实采；读不到时保留「—」。
- 只在面板打开、点「运行中」页签或向导写入后校准；不轮询。
- 卡片显示：Loop 徽标、飞行周期、当前轮/总站数、阻塞状态、出发地可支撑轮数。
- 告警：步骤阻塞、飞行阻塞、循环停止（船已解除分配且 Loop 仍为开）、船况 <80%、出发地库存 <1 轮、非计划货物占用舱容、基地仓储将满。
- 飞行阻塞提示手动解除分配并重新分配；PRO 失效只能由玩家续费后重新分配。

### 分配前预检

- 船在出发地，或剩余燃料足够飞到出发地。
- 货舱为空，或剩余舱容足够装下本轮计划；非计划货物必须列出。
- 出发地库存 ≥1 轮（含 SF/FF）。
- 至少 2 个不同目的地。
- Loop 已确认打开。
- 无同船旧环线 ACT/触发器。
- 玩家有 PRO（无法可靠读取时只提示）。

## 数据与接口

- `NativeRouteRecord` 增加 `loop?: boolean`、`cycleHours?: number`。
- `RouteData` / `NativeRouteView` 增加 `repeats?: boolean`，以游戏定义覆盖本地快照。
- 新纯函数建议放 `native-route-loop.ts`：周期换算、每轮账单、备货轮数上限、可支撑轮数。
- 复用 `native-route-purchase.ts` 的缺口算法，输入改为 N 轮账单。

## 实现步骤

1. 实采 Loop 开关报文，更新 `native-route-socket.ts`；补 `RouteData.repeats`。
2. 新增 `native-route-loop.ts`（周期、每轮账单、N 轮备货、资格校验）。
3. `use-chain-planning.ts` 支持 `cycleDays` 覆盖与迭代；`ChainView.vue` 暴露循环模式。
4. `NativeRouteDialog.vue` 增加循环选项、写后开 Loop、N 轮备货与警告。
5. `native-route-registry.ts` / `native-route-game.ts` 记录并合并循环状态。
6. `ChainView.vue` 运行中卡片显示循环状态、补货与预检。
7. 更新 `../feature-patterns.md` 的 Chain Planner 一节和 `../architecture.md`（模块边界）。

## 不采用

- **直接给现有单趟计划打开 Loop**：运量按目标天数计算，与飞行周期不一致；也没有按轮备货。
- **Loop + ACT 触发器并存**：原生步骤已经装卸，触发器会重复搬运。
- **多船共用一条循环航线**：每艘船都按同一组绝对量装卸，实际流量按船数倍增，计划失效。

## 验证

- 回归脚本（`../../scripts/verify-fleet-contracts.mjs`）：每轮账单、周期迭代、备货轮数上限、循环资格、循环模式不生成 ACT、`repeats` 合并。
- 实机：2 基地 1 船跑满两轮；抽掉一种输入验证步骤阻塞后恢复；航行中补货；关闭 Loop 在下一轮生效。
- 浏览器关闭后循环仍继续；关闭期间不产生扩展请求。
- 打开/点页签才发 `SHIP_ROUTES_GET_ROUTES` / RTE 读取，符合 ToS 例外清单。

## 待实采

- Loop 开关的 messageType 与 payload（是否可在 `CREATE_ROUTE` 时直接带 `repeats`）。
- RTE 各状态的界面文案（中/英）。
- Wait 步骤的 socket 协议（后续把周期拉长到目标天数时使用）。
