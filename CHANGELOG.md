# 更新日志

## [Unreleased]

> 本节内容在下次发布时会被移入版本号段。当前为空时不发布。

---

## [26.9.2.5] - 2026-09-02
### 🐛 Bug Fixes

- **`build`**：为 Firefox manifest 补充 `data_collection_permissions`（`required: ["none"]`）—— AMO 自 2025-11-03 起要求新扩展在 `browser_specific_settings.gecko` 中声明数据收集/传输类型（旧扩展的新版本后续也将强制）；本扩展自身不收集、不传输任何数据（见 PRIVACY.md），声明 `none` 即可通过校验。

---

---

## [26.9.2.4] - 2026-09-02
### 🐛 Bug Fixes

- **`XIT/FLEET`**：修复环线「规划中/运行中」页签与下方船卡重叠 —— 游戏 `.Tabs__component` 子元素脱离常规流，`height:auto` 会塌缩为 0 使页签文字溢出盖住船卡；页签容器改为显式 `height:29px`（页签行实测高度）。

---

---

## [26.9.2.3] - 2026-09-02
### 🐛 Bug Fixes

- **`build`**：修复 Firefox AMO 首次 listed 提交仍被拒 —— AMO 首次创建上架条目除 `version.license` 外还要求 `summary` 与按应用分组的 `categories`；在 `scripts/amo-metadata.json` 补全（`summary` 含 en-US/zh-CN，`categories.firefox` 取 `other`），web-ext `--amo-metadata` 即可一次通过创建校验。

---

---

## [26.9.2.2] - 2026-09-02
### 🐛 Bug Fixes

- **`XIT/FLEET`**：修复环线进度表右侧留白 —— 环线表格改用 `table-layout: auto`（其余列固定 px 宽、多余宽度全部进入 auto 的「操作」列）；Chromium 下 `table-layout: fixed` 不会把剩余宽度分给 auto 列（实测 Chrome 152 中最后一列「载重」右侧留白约 620px，对列显式设 `calc` 宽度也无效），auto 布局能正确铺满且各船表格列宽保持一致。
- **`XIT/FLEET`**：修复环线「规划中/运行中」页签下方的大片空白 —— 页签容器复用游戏 `.Tabs__component` 样式自带固定高度（实测约 359px，为整套页签面板设计），仅展示页签头时将其收拢为内容高度。
- **`build`**：修复 Firefox AMO 提交失败 —— `firefox` 发布 job 未 checkout 代码仓库，导致 `web-ext sign --amo-metadata scripts/amo-metadata.json` 找不到元数据文件（AMO 对 listed 版本要求 `version.license`）；补充 `actions/checkout` 使 license 元数据可被读取并随版本提交。

---

---

## [26.9.2.1] - 2026-09-02
### 🐛 Bug Fixes

- **`build`**：为 Firefox manifest 补充 `license` 字段，满足 AMO 公开渠道（`--channel=listed`）签名校验要求，避免提交返回 Bad Request。

---

---

## [26.9.2] - 2026-09-02
### ✨ Features

- **`release`**：新增 Firefox 浏览器构建与发布支持 —— 新增 `build-firefox.mjs` 从 Chrome 构建产物生成 Firefox 扩展包（删除 `minimum_chrome_version`、`host_permissions` 补 `/*`、加入 gecko `browser_specific_settings`）；发布流程新增 Firefox AMO 自动提交（`web-ext sign`）；扩展更新检查兼容 `moz-extension://`。
- **`XIT/FLEET`**：基地行点击快速填入地址 —— 点击行星行时，若当前有打开/聚焦的游戏原生地址选择器（如 SFC 目的地框），直接把该基地填入该框；否则维持原有打开 BS 命令。

### 🔧 Improvements

- **`XIT/FLEET`**：行星行名称改用基地编号（naturalId）显示，移除 planetName。
- **`build`**：移除 Firefox 打包产物（dist-firefox.zip）的本地打包与上传步骤 —— Firefox 分发统一由 CI 提交 AMO 处理，简化发布流程。

### 🐛 Bug Fixes

- **`prun-api`**：修复 createMap/getGroupMap 转换崩溃 —— 选择器返回空/未定义键时跳过该条目，避免 `upperCase(undefined)` 报错。

---

---

## [26.8.29.3] - 2026-08-29
### 🔧 Improvements

- **`XIT/FLEET`**：运行中环线可折叠 —— 每艘运行中/已完成环线的船名行左侧新增折叠箭头，点击可收起/展开该船的航线、进度表与汇总（多环线并行时节省纵向空间）；折叠状态按船持久化，切换页签后保持。

---

---

## [26.8.29.2] - 2026-08-29
### 🚀 发布

- 扩展上架 **Microsoft Edge 加载项商店** —— 发布流程新增 Edge 商店自动提交（Edge Add-ons API v1.1），Edge 用户可直接从 Edge 商店安装并自动更新。

---

---

## [26.8.29.1] - 2026-08-29
### ✨ Features

- **`XIT/FLEET`**：环线取货量按到港时预计产出计算 —— 飞行期间基地继续生产，到港时可提取量 = 当前库存 + 飞行期间新增产出 − 飞行期间消耗；新增产出按生产线订单起止时间精确推算（并行槽位填满、排队订单接力、循环订单循环添加，到港前连续多批都计入），使取货包装满到港时实际可提取的产出，不再把飞行期间产出的货物留在基地。

### 🐛 Bug Fixes

- **`XIT/FTC`**：修复环线多船并行时最优燃料互相覆盖 —— FTC 最优燃料/反应堆参数改为按飞船（registration）键控存储与读写，各船 SFC 面板只应用自己算出的最优值；此前单一全局值会被后算完的船覆盖，导致其他船（如 LCB-1）带着错误燃料起飞并反复抖动。

### 🔧 Improvements

- **`XIT/FTC`**：燃料模型计入飞船载重（BTF 蓝图试航载重扫描 60+ 点实测）—— 着陆/起飞燃料按载重乘性增加（系数按引擎：标准 2.2e-4/吨、节油 2.7e-4/吨，标准引擎 40→66u @3000t、节油 14→23u）；STL 段速度（转移/离港/进近）按质量比 (m0/m)^loadExp 减速（逐引擎标定：节油 0.87、标准 0.6、超推力 0.5，跨星系复测验证），替代旧「推力受限」修正（G 受限船此前完全不减速，实测载重 600t 已减速 19%）。

---

---

## [26.8.29] - 2026-08-29
### ✨ Features

- **`XIT/FLEET`**：环线多环线并行 —— 表格分「规划中 / 运行中」两个页签（带计数、状态持久化），有环线运行中仍可规划其他环线；执行中/已完成的环线在船名括号标注（运行中/已完成）；「执行环线」跳过正在执行环线的船，防止误删运行中脚本。
- **`XIT/FLEET`**：空间站行分开展示采购/取货 —— 序 0 把装船物资按来源分为「采购」（CX 购买）与「取货」（从空间站仓库直接装船）两行。
- **`XIT/FLEET`**：购买时检测空间站库存 —— 生成采购清单时，空间站仓库已有库存的物资优先以「取货」装船（不重复购买）；CX 订单簿供应不足的物资缩减采购量并警告，防止执行时 CX Buy 因库存不足而失败。
- **`XIT/FLEET`**：每段飞行前自动计算 FTC 最优燃油 —— 出发（DEPART）前等待本次航线 FTC 最优方案计算完成并应用到 SFC 燃料/反应堆滑块，确保用最优方案出发；SFC 自动联动计算不再打开星系窗口（避免干扰环线自动执行）。

### 🔧 Improvements

- **`XIT/FLEET`**：预计到达时间改为本地时区显示（跨天带 MM-DD 前缀）。
- **`XIT/FLEET`**：飞行信息显示在对应到达阶段行 —— 序 0 出发地显示「出发」，各站行显示飞往本站的航段，归航行显示飞回出发地的航段（含在途剩余/预计到达/已完成）。

### 🐛 Bug Fixes

- **`XIT/FLEET`**：修复环线阶段状态不推进 —— 环线包不再 autoDelete 后完成状态未持久化（站点/归航停在 arrived），状态检查与自动恢复无法推进下一阶段；执行成功即写回持久化状态，并按船停靠/飞行目的站/归航前推已完成站。
- **`XIT/FLEET`**：修复中断恢复后上一阶段不显示完成 —— 船已在途飞往后续站时，按飞行目的站前推之前的站为完成。
- **`XIT/FLEET`**：修复规划中的环线显示错误时间 —— 船正在执行其他环线时，规划中的预估时间被真实在途飞行覆盖；在途时间仅对执行中的环线显示。
- **`XIT/FLEET`**：修复自动出发失效 —— OPEN_SFC 不再等待 FTC 计算（避免浏览星系窗口干扰 SFC 面板），改由 DEPART 出发前统一等待 FTC 最优滑块应用。
- **`XIT/FLEET`**：修复归航段重复显示飞行时间。

---

---

## [26.8.28] - 2026-08-28
### ✨ Features

- **`XIT/FLEET`**：环线多端同步 —— 跨浏览器/设备经 org-api 服务器同步环线（按船独立快照：配置/运行状态/操作包/触发器互不覆盖）；无自动轮询，仅在本地环线状态改变时推送；「云端同步」对比对话框按配置与每艘船逐项「上传/下载」。
- **`XIT/FLEET`**：刷新后脚本一致性校验 —— 未完成阶段的环线脚本缺失时提示差异且不自动恢复；刷新后不再自动执行出发（显示「未开始」，出发由用户手动触发）。
- **`XIT/FLEET`**：完成的环线保留在状态列表显示「已完成」（不再自动清理）；「清理计划」移到各计划卡片（按船，确认后删除该船环线记录与相关 ACT 脚本/触发器）。
- **`XIT/TRIGGER`**：触发器分「环线自动 / 自定义」两页，「删除全部」仅删环线自动触发器（自定义不受影响）；全局执行模式改为「自动 / 手动」切换；触发器模式统一为 AUTO，操作列提供「执行」按钮。

### 🔧 Improvements

- **`XIT/FLEET`**：环线操作包不再随执行自动删除（保留完整脚本，供状态列表/云端同步/手动清理）。
- **`XIT/FLEET`**：移除「导出 / 导入配置」按钮（云端同步与按船手动清理替代）。

### 🐛 Bug Fixes

- **`XIT/FLEET`**：修复多端同步时间戳基准混乱（LWW 比较用 payload 时间戳、乐观锁用服务器时间戳分离）与按船「上传」无响应（本地无记录时以空快照清空云端）。

---

---

## [26.8.27.1] - 2026-08-27
### ✨ Features

- **`XIT/FLEET`**：环线进度表显示各段飞行时间预估 —— 按 FTC 最优燃油口径（自动扫描燃料/反应堆滑块 + 平衡点）逐段估算飞行时长，显示在各站「飞行」列与「飞行时长」汇总行；下游基地用飞船到达时的未来预计位置计算航程。
- **`XIT/FLT`**：舰名按耐久分级变色 —— 耐久 80%~83% 显示黄色警示，低于 80% 显示红色告警（原为 83% 以下一律红色）。

### 🐛 Bug Fixes

- **`XIT/FTC`**：改变 SFC 目的地时自动重新推送航线给 FTC —— 以 MissionPlan 重算信号 + 直接读表单起终点（含「使用跃迁点」状态），改目的地/滑块后即重新计算最优燃料。
- **`XIT/FTC`**：消除自动调整燃料的重复响应 —— 滑块已是目标值时跳过点击、重试改用最新滑块节点、计算完成校验航线未变、写滑块 60ms 防抖合并，避免重复写滑块与重复计算。

---

---

## [26.8.27] - 2026-08-27
### ✨ Features

- **`XIT/FTC`**：飞行计算器重写为飞船性能驱动模型 —— 按引擎类型、油箱大小、船体条件、FTL 最大航速与反应堆功率计算 STL/网关/自然 FTL 各段时间与燃料，支持自然与网关航线的综合成本计算。
- **`XIT/FTC`**：最优燃料方案一键计算 —— 无需手动设置档位，自动扫描全范围燃料/反应堆滑块并计算 Pareto 拐点平衡点，只展示最佳燃料方案。
- **`XIT/FTC`**：SFC 与 FTC 双向联动 —— SFC 飞行计划自动推送飞船与起终点给 FTC，计算最优燃料/反应堆使用量并写回 SFC 滑块，无需打开面板。
- **`XIT/FTC`**：内置全量轨道与环境数据 —— 4155 颗行星轨道与半径/气压、空间站轨道（含 HRT 46.8M km）、恒星跃迁连接全部内置，离线解析起终点并预测天体位置。
- **`XIT/FTC`**：STL 段数据自动采集与内置 —— 游戏内自动采集 4155 行星起降段数据并内置（4073 离港 + 1857 进近），原生路程精确复现，明细标注数据来源。
- **`XIT/FTC`**：完整 STL 分段模型 —— 起飞/离港/进近/着陆四段独立建模（行星半径/气压/重力修正），油箱大小决定段速度（Weibull 拟合），引擎决定饱和速度。
- **`XIT/FTC`**：计算时自动浏览星系 —— 无需手动按钮，计算时自动打开起终点星系积累轨道数据（恒星质量 + 行星/空间站轨道）。
- **`XIT/FTC`**：网关数据检查与导出 —— 内置恒星跃迁连接、在线网关读取，支持导出星球环境与空间站数据。
- **`XIT/FTC`**：时长显示精确化 —— 总时长 ≥1 天显示 天/小时/分钟，<1 天显示 小时/分钟/秒（中文单位）。
- **`XIT/FLEET`**：链规划补充 started 订单的日产/日耗 —— 避免运行中产线物料遗漏。

### 🔧 Improvements

- **`XIT/FTC`**：航线明细严格按 SFC 表格展示完整分段 —— 原生飞行计划优先，模型估算回退。
- **`XIT/FTC`**：STL 起降数据回退改用内置统计（离港 70M/进近 68M），明细显示离港+进近与来源。
- **`XIT/FTC`**：全程系内/纯网关飞行不计算反应堆 —— 无自然跃迁时反应堆不影响结果。

### 🐛 Bug Fixes

- **`XIT/FTC`**：段速度改为段燃料 Q 驱动 + 逐引擎标定 —— 油箱大小决定段速度，修复小油箱船段速度异常。
- **`XIT/FTC`**：段速度推力受限修正 —— 载重使加速度低于 G 上限时按 (a/G)^0.55 减速。
- **`XIT/FTC`**：记录秒数合理性校验 —— 记录速度偏离本船巡航过远判为异船记录并回退模型（修复 71.6Mkm 进近 2h58m 异常）。
- **`XIT/FTC`**：着陆/离港流量模型增加引擎流量回退 —— 飞船数据缺 stlFuelFlowRate 时不失效。
- **`XIT/FTC`**：原生飞行计划匹配改用解析后实体 —— 别名输入（如 Euu）也能命中。
- **`XIT/FTC`**：OOG LCB 省油船时间/燃料修正 —— 蓝图等待、航线段结构、着陆流量系数、离港饱和。
- **`XIT/FTC`**：轨道 inclination 旋转符号修正 —— 与服务器 transferEllipse 实测一致。
- **`XIT/FTC`**：修正网关计数的变量名匹配错误。
- **`XIT/FLEET`**：链规划防御性修复 —— 船材未定义时不中断规划。

---

---

## [26.8.25] - 2026-08-25
### ✨ Features

- **`XIT/FLEET`**：环线 ACT 脚本按阶段编号并自动删除 —— 主包（阶段 0）与各站/归航包统一带阶段号，主包执行成功后与站点包一样自动删除，ACT 列表按序展示阶段脚本。
- **`XIT/FLEET`**：环线列表全局状态持久化 —— 站点、操作内容与阶段进度（出发/各站/归航）以 JSON 快照保存到运行记录，删除 ACT 脚本或触发器后执行列表仍完整展示；导出/导入环线配置时同时包含 ACT 脚本、触发器与列表全局状态。

### 🔧 Improvements

- **`XIT/FLEET`**：环线进度表列宽统一 —— 使用固定表格布局与固定列宽，多船进度表不再因内容长短不同导致列宽不一致。
- **`XIT/FLEET`**：旧版/导入环线载重列还原 —— 无计划快照时从现有 ACT 包反推阶段载重，载重列显示各阶段规划载重而非实时舱载。

### 🐛 Bug Fixes

- **`XIT/FLEET`**：环线进度「序」列补全空间站出发与归航完成标记，环线完成后短暂保留记录展示 ✓ 再自动清理。
- **`XIT/FLEET`**：清空全部 ACT 脚本与触发器后移除孤立预留列表，并过滤内存快照中已删除船舶的旧进度表。

---

---

## [26.8.24] - 2026-08-24
### ✨ Features

- **`XIT/FLEET`**：新增基地供应链分组 —— 在 BSN 面板为各基地配置分组（逗号/空格分隔录入分组名），环线规划按分组载入基地；新增组内产出自产自销闭环与出发地取货补缺口。
- **`XIT/FLEET`**：实现多船并行分段执行 —— 按飞船容量将环线计划切成连续段并行执行（无货舱或剩余舱容为 0 的船不参与分段）；暂存调度支持一次性暂存多艘船的操作包，FLEETACT 窗口批量展示并自动按顺序执行，飞行阶段并行不抢占窗口。
- **`XIT/FLEET`**：环线视图重构，实时展示运行中航线进度 —— 以归航触发器的星球作为出发地标记，运行中环线显示实时进度（替换原静态计划列表），站点状态文案统一管理，区分展示运行中与未执行的环线计划。
- **`XIT/FLEET`**：环线运行数据还原 —— 页面刷新或旧版本环线（无计划快照）时，从历史操作包逆推还原站点装卸货、采购、归航卸货与航线信息，并实时显示船舶当前载重；所有环线执行完成后自动清空计划快照，避免数据残留。

### 🔧 Improvements

- **`XIT/FLEET`**：统一环线规划与执行中的表格展示逻辑 —— 合并规划模式与执行中的表格渲染代码，新增执行计划快照，环线运行期间保持规划时的表格样式并叠加进度状态。
- **`XIT/TRIGGER`**：移除导入/导出配置按钮 —— 简化代码（该功能在 26.8.23 引入）。

### 🐛 Bug Fixes

- **`XIT/FLEET`**：修复逆推模式下实时舱载获取逻辑 —— 载货数据改从 storagesStore 读取正确舱存，并添加空值判断避免渲染报错。

---

---

## [26.8.23.1] - 2026-08-23
### 🐛 Bug Fixes

- **`XIT/TRIGGER`**：修复触发器执行的 ACT 弹出执行面板 —— 环线到港等由触发器引擎自动执行的包改为后台静默执行（隐藏窗口 + 执行结束自动关窗），不再弹出执行页面。

---

---

## [26.8.23] - 2026-08-23
### ✨ Features

- **`XIT/FLEET`**：环线新增执行进度面板 —— 以飞船为键持久化运行记录，环线页签展示「正在执行的环线」（船名、开始时间、X/N 站进度、各站操作包执行状态与归航卸货状态）；环线结束前无法再次生成新计划。
- **`XIT/FLEET`**：环线「自动执行」改为后台静默执行 —— 执行环线时不再弹出 FLEETACT 页面，主包经触发队列自动执行，结束后自动关闭隐藏窗口（成功/失败/取消均触发关闭）。
- **`XIT/TRIGGER`**：新增导入/导出配置按钮 —— 导出全部触发器及其引用的操作包为自包含 JSON（便于备份/分享/换设备迁移）；导入时操作包按名称覆盖或新增，触发器按「名称 + 操作包 + 事件 + 模式」去重后追加，避免重复导入。

### 🐛 Bug Fixes

- **`XIT/ACT`**：修复发船（DEPART）需要二次确认的问题 —— 点击「开始」后游戏弹出的「需要确认」覆盖层现由程序自动点击「开始」确认，发船不再需要手动二次点击。
- **`XIT/FLEET`**：修复 ACT 命令参数解析失败 —— 操作包名仅保留 ASCII（字母/数字/连字符），中文与 `()'"&` 等符号折叠为空格，船名净化后为空时回退注册号，避免 `XIT ACT_...` 命令在 PrUn 端解析失败。
- **`XIT/FLEET`**：修复环线完成后状态未重置 —— 运行记录在完成后自动清除，进度面板隐藏、该飞船恢复可重新规划。
- **`core/game-lookups`**：修复行星排序死代码分支 —— 命名行星恒排在未命名行星之前（BURN 等面板行星列表排序的边缘修正）。

---

---

## [26.8.22.1] - 2026-08-22
### ✨ Features

- **`XIT/FLEET`**：新增产业链环线模式 —— 由各基地产出/消耗/库存推断上下游链关系并拓扑排序定航线（循环依赖断链并警告），按目标天数平衡链上物资运量（多上游按库存比例分摊、缺口回落 CX 采购），沿航线模拟舱容、超载按比例缩减提取量；一键生成主包（采购+装船+飞首站）与各站「卸货→提取→飞下一站」操作包 + 到港一次性触发器 + 归航包。
- **`XIT/FLEET`**：环线产物提取支持 BSN 白名单 —— 在 BSN 面板为各基地配置「可提取产物」列表，仅白名单内且无下游边的 ticker 运回出发地；有下游边的白名单产物走链上输送（完整产业链供给，即使下游当前不缺也按上游可提取量均分输送）。
- **`XIT/FLEET`**：环线新增「自动发船」与「自动执行」开关 —— 自动发船在每步 OPEN SFC 后追加 DEPART 动作（主面板与环线各自独立开关）；自动执行使生成的到港触发器为 AUTO 模式（受 TRIGGER 全局总开关管控），否则为 CONFIRM 通知确认。
- **`XIT/FLEET`**：环线列表改为详细行程表 —— 按「序 / 星球/空间站 / 操作（采购、卸货、取货）/ 飞行目的地 / 载重」分步展示，末行显示归航卸货。
- **`XIT/FLEET`**：派遣新增「到港卸货」开关 —— 执行时同步在 TRIGGER 面板创建一次性到港触发器（指定飞船 + 基地），飞船到达该基地自动执行卸货包，成功后触发器自动删除。
- **`XIT/TRIGGER`**：新增一次性触发器（autoDelete）—— 其操作包执行成功后触发器自动删除；飞船到港（FLIGHT_ENDED）触发器新增目的地星球过滤，仅指定基地到港才触发。
- **`XIT/TRIGGER`**：新增 MANUAL 手动模式与操作列 —— 表格新增「操作」列：AUTO 显示 auto 徽章、CONFIRM 显示 confirm 徽章、手动模式显示「执行」按钮；点击执行按钮直接打开 XIT ACT 运行对应操作包，手动触发器不参与自动触发引擎。
- **`XIT/BSN`**：基地别名面板新增「产物」列 —— 逗号/空格分隔的 ticker 白名单，占位符自动读取 BURN 本基地产出；供 FLEET 产业链环线读取可提取产物。
- **`XIT/ACT`**：新增 DEPART 动作 —— 静默定位 SFC 面板指令表单并点击「开始」按钮发船（携带 `registration`），需显式开启（ToS）。

### 🔧 Improvements

- **`XIT/FLEET`**：移除全部加油功能（Plan/Chain 均不再生成 Refuel 动作）—— 加油统一由 XIT TRIGGER 内置「自动加油」管理。
- **`XIT/FLEET`**：新增 `supplies-cap.ts` 共享模块 —— 统一 4 处 `suppliesCapDays` 读取/钳制逻辑（PlanetRow 输入框、chain-planner、computeResupplyBill、fitDaysForShip），行为不变仅去重。
- **`XIT/FLEET`**：环线补天数钳制修正 —— `cap <= 0` 时不再把用户天数强制改 0（保留输入），避免仓储堆满时天数被锁死无法恢复。
- **`XIT/TRIGGER`**：新增触发器默认模式改为 AUTO（自动执行，受全局总开关管控）。
- **`XIT/ACT`**：MTRA 空组视为完成而非失败、Manual 材料组空组返回空账单（警告而非错误），保证程序生成包中无货可移的动作不中断后续动作（如 OPEN SFC）。
- **`XIT/CXOS` / `XIT/ACT`**：挂单价位步长与挂单限价计算提取到 `core/orders` 共享；CXPO 价格输入改用无千分位分组格式（`fixed02ng`），修复游戏输入框无法解析带分组数字导致的下单失败。

---

---

## [26.8.21.2] - 2026-08-21
### ✨ Features

- **`XIT/TRIGGER`**：新增内置自动化区块 —— 集中管理「自动加油」与「NX 自动补油」开关：自动加油展示低油飞船计数（`lowFuelShips`），NX 自动补油提供「设置」按钮跳转 NX 面板；移除 SET 加油选项卡（`REFUEL.vue`）与 NX 面板内的自动补油开关（保留目标设置与一键补油），加油设置统一在 TRIGGER 面板管理。

### 🔧 Improvements

- **`XIT/TRIGGER`**：飞船到港（FLIGHT_ENDED）触发器新增飞船下拉选择器 —— 按注册码排序并显示船名，可筛选指定飞船或选择任意飞船；重构通知权限获取逻辑（computed 暴露 `Notification` 权限，避免模板直接访问全局导致渲染报错）；触发器 ID 改用 `createId` 生成。
- **`XIT/ACT`**：预览静默执行时临时 CXPO 窗口全程隐藏 —— 取价临时窗口改用 `autoClose` + `closeWhen` 机制并在 `finally` 中兜底关闭，执行期间不再闪现窗口。
- **`XIT/FLT`**：恢复本地燃料列与状态图标重构 —— 燃料/维修状态在表格内直接渲染，删除 `StatusCell.vue` 与 `ship-status-icons.ts` 死代码。

---

## [26.8.21.1] - 2026-08-21
### ✨ Features

- **`XIT/ACT`**：新增 BRA Repair 操作 —— 静默打开 BRA 面板，勾选状况低于阈值的建筑，轮询「维护」按钮从禁用变为可用（材料到位信号）后自动提交；BRA 生成器默认追加该操作，形成「采购→转移→提交维修」闭环。
- **`automation-triggers`**：新增触发器引擎 —— 到港/物资告急/生产完成挂游戏告警（按告警 ID 去重），建筑状况/定时为电平+冷却条件源（冷却下限 15 分钟）；CONFIRM 模式桌面通知确认后执行，AUTO 模式需全局开关（默认禁用）。
- **`XIT/TRIGGER`**：新增自动触发器面板 —— 触发器增删改、启用开关、触发历史，AUTO 全局总开关（含 ToS 风险提示）与桌面通知授权入口。
- **`XIT/PLAN`**：JH 计划一键生成建造购材 ACT 包 —— 按 FIO 建筑成本 + 星球环境建材（与 BPLAN 同规则）汇总需求，生成「CX Buy → MTRA 转基地」操作包。

### 🐛 Bug Fixes

- **`refined-prun-prepare`**：修复脚本序列化的双重执行缺陷 —— 无 src 守卫 + `data-rp-serialized` 标记保证幂等（此前另一副本/二次运行会把已序列化的 URL 清空）；改用 `removeAttribute('src')` 替代 `src = ''`（空 src 会解析为页面 URL，浏览器把 HTML 当脚本执行，即控制台 `（索引）:1 Unexpected token '<'` 报错）；原始 `type` 存入 dataset 供反序列化还原。
- **`shell/config`**：配置元素为空时报清晰错误（提示可能启用了重复的扩展副本），替代难以定位的 `Unexpected end of JSON input`。

---

---

## [26.8.21] - 2026-08-21
### 🔧 Improvements

- **`XIT/FLEET`**：补给账单对齐 BURN 算法 —— `computeResupplyBill` 改为按「总目标天数」计算物料需求（`max(0, targetDays × dailyConsume − inventory)`），与 BURN `Resupply` 组运行时的物料生成口径一致；同时库存口径改为纯 `inventory`（不再混入 `remainingAllocation`），消除之前派遣包比 BURN 补给包多买的问题。`suppliesCapDays` 上限钳制保留，目标天数超出时按上限截断。
- **`XIT/FLEET`**：天数输入改为「总目标天数」 —— PlanetRow 输入与 `fitDaysForShip` 搜索上界同步改为 `min(targetDays, suppliesCapDays)`，与 BURN 行为一致。
- **`XIT/FLEET utils`**：`getBaseInventoryDays` 同步改用纯 `inventory` 计算库存可用天数，使饱和点搜索与账单一致。

---

---

## [26.8.20.2] - 2026-08-20
### ✨ Features

- **`XIT/NX`**：快捷买油新增自动补油 —— 事件驱动实时监听四大空间站（ANT/BEN/HRT/MOR）仓库油量，低于目标自动购买。
- **`XIT/PROFIT`**：新增物料搜索过滤 —— 在利润配方表上方加入输入/输出物料 ticker 搜索框，支持按物料名筛选配方；空结果显示提示。
- **`XIT/CXOS`**：批量压价改为组间并发执行 —— 不同材料同时压价，提升多物料压价吞吐。
- **`XIT/SET/REFUEL`**：SET 面板新增加油标签页 —— 提供自动加油开关设置入口。
- **`auto-refuel`**：缺油自动加油 —— 停靠且燃料低于 95% 时静默加油；星球无油则放弃直至飞船状态改变再重试。

### 🔧 Improvements

- **`XIT/NX utils`**：补充 `vue` 的 `ref` 工具函数导入，修复缺失依赖。
- **`XIT/PROFIT`**：简化物料搜索的监听逻辑 —— 将 `materialSearch` 监听器合并到组合监听中，减少重复的 `rowsKey` 更新。
- **`sfc-auto-fuel-settings`**：写入失败自动重试（最多 3 次，间隔 500ms）；最大值改用点击轨道末端提升稳健性；校验容差放宽至 0.01。

---

---

## [26.8.20.1] - 2026-08-20
### 🔧 Improvements

- **CI**：同一天二次发布时，release 版本号改为在日期后追加序号（26.8.19.1、26.8.19.2 …），不再顺延到次日。

---

---

## [26.8.20] - 2026-08-19
### ✨ Features

- **`XIT/FLEET`**：新增补给容量上限（suppliesCapDays）—— 按「下次到港前仓储不超过 (1−reserve)」反算最大补给天数（含产出累积），防止补给填满仓库导致产出无处存放（卡线）。
- **`XIT/FLEET`**：维修账单扣除基地现成库存，只计算实际缺口。

### 🔧 Improvements

- **`XIT/FLEET`**：补给天数输入重构 —— 输入改为「追加天数」，与库存可用天数叠加后不得超过补给容量上限；移除对全局推荐补给天数的耦合，统一钳制输入与账单。
- **`XIT/FLEET`**：适配（fitDaysForShip）二分搜索上界改用各补给基地饱和点，替代固定 999 天。
- **`NumberInput`**：改用 `inputmode=decimal` 文本输入，优化移动端输入体验。

---

---

## [26.8.19] - 2026-08-19
### ✨ Features

- **`XIT/PROFIT`**：新增配方利润扫描器 —— 扫描全部产线配方，按 CX 实时价格计算利润率，找出最赚钱的产线。
- **`XIT/LMSCAN`**：新增 LM 价差扫描 —— 对比本地市场广告与 CX 交易所价格，发现搬运/倒卖机会。
- **`XIT/CONTSS`**：新增合同截止预警 —— 合同列表新增「截止」列，基于条件 deadline 计算最近截止时间，3 天内橙色、已过期红色预警。
- **CI**：release 版本号自动按当天日期生成（tag 冲突顺延）并同步回 package.json。

### 🔧 Improvements

- **`XIT/PROFIT`**：利润计算扣除生产手续费，只展示正利润；利润率改用 margin（利润/收入）计算，并用建筑图标替换文本显示。
- **`XIT/LMSCAN`**：完善广告数据处理与价格计算逻辑 —— 优先使用交易所 Bid 买价（依次回退 VWAP7D / 均价 / Ask），对比距离最近的交易所与全市场最高买入价，按价差百分比降序排列。
- **`XIT/PROD`**：CO/Q 按钮限制生产线 ID 长度为 8 个字符。
- **`XIT/BURN/MaterialRow`**：简化 DaysCell 的渲染逻辑。

### 🐛 Bug Fixes

- 修复多个文件末尾缺少换行符的问题。

---

---

## [26.8.18] - 2026-08-18
**日期**: 2026-08-18
**说明**: 清理大量冗余废弃代码，简化 eslint 配置

### 🗑️ Removed

- 删除多个废弃功能模块：SFC 自动关闭、ADM 按钮样式、聊天翻译、FXPO 增强、舰队存储分析、任务卡片、`CargoBar.vue` 等（净删 1300+ 行）。
- 移除未使用的 `inboundShipInventoryEnabled` 相关函数、`tslib` 依赖，以及 `buildings.ts` / `storage-analysis.ts` / `org-api tasks` 等模块的废弃导出。
- 简化 eslint 忽略配置，删除测试/调试专用的重置会话密钥函数。
- 更新贡献文档，添加死代码清理说明。

**日期**: 2026-08-17
**说明**: 移除 REPP 功能模块并将维修预测逻辑重构进 FLEET；BURN 启用 MCB/VSC 箱型；统一 Tooltip 实现；CI 发布工作流重构

### ✨ Features

- **`XIT/BURN`**：启用 MCB 与 VSC 的箱型配置参数，补充可选装箱规格。
- **footer**：`rprun-version-label` 合并显示现金余额 —— 与余额展示统一在同一个 footer 订阅回调中渲染，保证 DOM 渲染顺序确定。
- **CI**：release 工作流重构 —— 触发条件改为 CHANGELOG.md 变更（含 Unreleased 归档），恢复 tag push 触发；新增 workflow 清理脚本（GitHub Actions 与 Windows PowerShell 两版）。

### 🔧 Improvements

- **`XIT/FLEET`**：移除 REPP 功能模块，将原 REPP 核心算法整合到 `core/repair-plan`，直接通过 productionStore 获取生产数据计算最优维修间隔，简化维修状态展示逻辑。
- **`sfc-auto-fuel` / `PlanetRow`**：优化初始化时机与悬浮提示 —— 等待目的地行程统计加载完成后再配置滑块；补给天数输入框添加计算公式悬浮提示。
- **manifest**：移除不必要的跨域权限域名（workers.dev）。
- **`XIT/FLT`**：更新表头文本与进度条样式。

### 🐛 Bug Fixes

- **`XIT/FLEET/PlanetRow`**：维修悬浮框价格计算改用 PRUNplanner 标准公式 —— 基于建筑全量材料和实际使用时长计算剩余维修成本，修复未满修时价格不准的问题。
- **Tooltip / `PlanetRow` / `InvBar`**：修复 tooltip 显示问题 —— show 方法空值检查、替换原生 `title`/`data-tooltip` 为 Tooltip 组件、修复分段 tooltip 触发区域与告警显示。
- **运输中分类**：统一三处硬编码「运输中」为 `translateCategory` 国际化调用，保持界面文本一致性。
- **`XIT/FLT`**：燃料列标题更新为「燃料/维修」以更清晰地反映内容。
**日期**: 2026-08-16
**说明**: 新增 SFC 自动燃料设置；FLT 燃料条与维修状态视觉重构；快捷卸货复用 SHPI 一键卸货

### ✨ Features

- **`sfc-auto-fuel-settings`**：新增 SFC 自动设置燃料消耗（默认 0.1）与反应堆使用量（默认 100%）功能，预留自动勾选跃迁点与抵达后卸货的配置接口。
- **`XIT/FLT`**：燃料条改细并去边框，维修状态改为进度条。
- **`XIT/FLT`**：快捷卸货按钮改为复用船舱（SHPI）一键卸货按钮。

### 🔧 Improvements

- **`sfc-auto-fuel`**：优化自动燃料设置逻辑 —— 已配置滑块标签缓存防止重复覆盖手动修改、调整滑块点击时序（sleep 确保 onChangeComplete 获取正确值）、完善 `setSliderValue` 返回值与异常处理、启用跃迁点自动勾选配置。
- **`XIT/FLT`**：调整布局，优化货物栏宽度与位置样式；`LocationCell` 增加目的地样式，改善位置显示。
- **`XIT/FLEET/PlanetRow`**：移除拖拽分配飞船时的存量存储空间容量校验，简化拖拽分配流程。

### 🐛 Bug Fixes

- **`sfc-auto-fuel-settings`**：修复滑块点击后值被覆盖的问题。
**日期**: 2026-08-15
**说明**: 新增基地别名功能（命名 / SFC 搜索 / 全局展示）；FLEET 执行按钮 Tooltip；通过 overrides 清理 Dependabot 6 条 high 安全漏洞

### ✨ Features

- **基地别名**：新增 `userData.baseAliases` 存储与迁移（siteId → 别名）；BS 面板新增「别名」编辑按钮；新增 `XIT BSN` 面板集中管理所有基地别名；XIT 模块（PROD/BURN/FLEET/EXP/WFOR/ELEC/PWARN/REP/REPP/FLT/CONTC）原生渲染别名；PrUn 原生 tile 通过 `base-alias-display` 装饰标题与链接（含仓库库存解析）；SFC 目的地输入框输入别名时自动替换为行星 naturalId。
- **`XIT/BSN`**：别名输入改为原生输入框，新增草稿管理，优化输入体验。
- **`XIT/FLEET`**：添加 Tooltip 组件优化执行按钮的提示信息。
- **`XIT/FLT`**：添加飞船状态文本标签，优化状态显示逻辑；调整货物单元格样式，优化垂直堆叠内边距；优化位置单元格逻辑，确保停靠船只正确显示目的地。

### 🔧 Improvements

- **`XIT/FLEET/PlanetRow`**：补给天数输入框添加悬浮提示（可容纳补给天数计算公式与推荐值）。

### � Bug Fixes

- **CI**：release.yml prune job 添加 checkout，避免 `gh release` 找不到 git 上下文。

### � Security

- **`brace-expansion`**：升级 5.0.8 → 5.0.9 + per-major pin（`@1`→1.1.18、`@2`→2.1.4）以清除 [GHSA-mh99-v99m-4gvg](https://github.com/advisories/GHSA-mh99-v99m-4gvg) / CVE-2026-14257（DoS via unbounded expansion length）与 [GHSA-rgw5-rvv9-x895](https://github.com/advisories/GHSA-rgw5-rvv9-x895) / CVE-2026-69152（5.0.8 缓解被绕过的中间数组 DoS）。3 个大版本都受影响：1.x 通过 `eslint → minimatch 3.1.5`、2.x 通过 `@typescript-eslint → minimatch 9.0.9`、5.x 通过 `rimraf → glob → minimatch 10.2.6`；必须按 major 分别 pin 才能让 pnpm dedup 落到补丁版本。
- **`js-yaml`**：升级 4.3.0 → 4.3.1 以清除 Quadratic CPU consumption in `!!omap` 解析（GHSA-5p4m-2wfm-xmqj）。所有路径经 `@eslint/eslintrc` 引入。
- **`nanoid`**：升级 3.3.16 → 3.3.18 以清除 CVE-2026-67213（GHSA-2v37-7h3g-55p8，custom generators 在 `size === 0` 时可死循环）。所有路径经 `vue / vite → postcss → nanoid`。

### ✅ Verification

- `pnpm audit --registry https://registry.npmjs.org/` → No known vulnerabilities found
- `pnpm run compile` → 0 errors
- `pnpm run lint` → 0 errors
- `pnpm run build` → 双 vite build + innerHTML patch 全部成功

### 📝 Notes

- `postcss` 在 dep chain 中实际由 pnpm dedup 拉到 8.5.26（>=8.5.18 满足 patched）；保留 `postcss: 8.5.18` 作为最低保证。
- 沿用 PR #9 已确立的 `pnpm-workspace.yaml#overrides` 模式（pnpm 9.x 不再读 `package.json#pnpm.overrides`）。
- `pnpm install` 必须 `--no-frozen-lockfile`（删除 `pnpm-lock.yaml` + `node_modules` 后重装）才能触发 re-resolution；增量 `pnpm install` 会把 override 当作「已满足」直接复用旧 snapshot。
**日期**: 2026-08-14
**说明**: FLEET 维修间隔 REPP 模型提示；ACT 自动模式静默执行；FLT 位置/目的地分列；DISPATCH 整合进 FLEET

### ✨ Features

- **`XIT/FLEET`**：新增基于 REPP 模型的维修间隔提示 —— 使用 `calculateRepairPredictions` 生成最优维修天数，维修列配色替换为 REPP 模型三色标记，调整表格列顺序与表头文案。
- **`XIT/ACT`**：自动模式窗口静默执行，成功后自动关闭 ACT 执行窗口（tile 分配器复用预开窗口）。
- **`XIT/FLT`**：新增位置与目的地分列 —— `LocationCell` 增加 mode 参数，舰船列表按名称/注册码排序，调整表头对齐样式。
- **CI**：release 工作流新增 prune 任务 —— 自动清理旧 release 仅保留最新 10 个（可手动触发并覆盖保留数量）。

### 🔧 Improvements

- **`XIT/FLEET`**：整合 DISPATCH 模块到 FLEET，统一代码位置与命令。
- **`XIT/FLEET`**：移除展开行功能，将存储计算逻辑提取到 `storage-utils.ts` 复用。
- **`XIT`**：优化舰队相关命令与界面 —— 移除 FLT 的 FLEET 别名命令、重构 FLEET 模块描述为基地管理、PlanetRow 自定义单选替换为 SelectInput 组件。
- **`XIT/FLEET/PlanetRow`**：两个 props 改为可选类型；advanceCell 样式优化；修复物资补给计算逻辑并添加提前列样式。
**日期**: 2026-08-13
**说明**: 新增 DISPATCH 舰队补给维修规划功能；Tooltip 组件重构与物料分类翻译

### ✨ Features

- **`XIT/DISPATCH`**：新增舰队补给维修规划面板 —— 基地补给/维修规划、船只分配（拖拽 + cargo 容量校验）、一键生成执行包（DISPATCHACT），支持配置导出导入与重置。
- **`XIT/DISPATCH`**：多基地卸货包自动生成逻辑。

### 🔧 Improvements

- **Tooltip**：重构组件 —— 支持隐藏默认图标与自定义插槽内容；新增物料类别中文翻译函数；替换原生 `data-tooltip` 为统一 Tooltip 组件，修复宽度溢出问题。
- **`XIT/DISPATCH`**：重构 `fitDaysForShip` 函数优化二分搜索逻辑；优化类型转换与遍历方式。

### 🐛 Bug Fixes

- **`step-machine`**：修复跳过并行步骤后卡死的问题。
**日期**: 2026-08-12
**说明**: 新增 INV/STO 库存与仓储分析；ACT/FLT/BURN 飞船筛选与自动填转移目的地

### ✨ Features

- **`XIT/INV`**：库存列表面板 —— 基地/飞船/仓库/CX 过滤、各类库存显示切换（tile-state 管理）。
- **`XIT/STO`**：仓储分析总览面板 —— BaseDetail/BaseHeader/BaseSection 分段展示、VisitationTable 飞船访问频率、填充率与天数格式化工具。
- **`XIT/BURN`**：生成补给行动面板新增飞船筛选 —— 自动匹配对应空间站与货箱容量的飞船，选中后自动预填转移动作的目的地为对应货仓。
- **`XIT/BURN`**：飞船选择项显示载重和容积。

### 🔧 Improvements

- **`XIT/ACT`**：OPEN_SFC 动作添加同包动作查找能力，修复目的地获取逻辑。
- **`XIT/FLT`**：状态单元格拆分出独立 `LocationCell` 组件。
- **`GenerateActDialog`**：调整标准货箱配置与注释顺序；`TimeCell` 移除加油按钮 tooltip 配置。
**日期**: 2026-08-11
**说明**: ACT 移植 OPEN SFC 动作；BURNGEN 生成 Unload 卸货包；FLT 位置显示区分空间站/轨道/着陆

### ✨ Features

- **`XIT/ACT`**：移植 OPEN SFC 动作 —— 执行完成后自动打开航行控制并输入目的地，暂停等待玩家提交飞行（自动模式自动继续）；COGC/BRA/BURN 生成面板新增「打开航行控制」勾选（记忆上次选择）。
- **`XIT/BURN`**：BURNGEN 生成补给包时同步生成同名 `{星球} Unload` 卸货包（可关闭）—— 卸货目标锁定星球基地，`originType: SHIP_STORE`，卸货包执行成功后自动删除（`autoDelete`，取消/失败保留）。
- **`XIT/FLT`**：位置显示区分空间站（缩写如 HRT）/ 行星轨道（环绕轨道）/ 行星表面（着陆）。
- **`XIT/BS`**：添加最优维修间隔天数计算，优化维修状态展示。

### 🔧 Improvements

- **`XIT/FLT`**：更新默认排序键与布局模式，调整列显示设置。
- **prun-ui**：注册 SFC 窗口默认尺寸 421x535，后调整为 600x700。
- **user-migrations**：移除过期的 sidebar 迁移。

### 🗑️ Removed

- **`contd-generate-purchase-draft`**：移除 contd 采购草稿功能。
**日期**: 2026-08-10
**说明**: 新增 FLT 舰队总览；ACT 自动执行与并行购买；CXPO 快速报价；XIT BS 命令；SFC 交易所快捷按钮；COGCU 补给 ACT

### ✨ Features

- **`XIT/FLT`**：新增舰队总览表功能模块 —— 面板汉化、状态列改为图标+地址单行显示、ETA 列 docked 船加油按钮（自动执行，复用 QuickRefuelDialog）、经典模式隐藏加注燃料按钮、燃料列进度条垂直堆叠。
- **`XIT/FLT`**：卸货按钮自动 MTRA 批量转移（silent 模式，监听 shipStore.items 等待完成），最终复用原生 FLT 卸货按钮。
- **`XIT/ACT`**：购买步骤自动模式并发执行（StepMachine 并行组，多窗口并发购买，组内全部完成才推进）；自动按钮改为红色触发式，点击即预览后自动执行；自动执行与手动执行窗口分离（自动走 requestWindow，避免被右侧 companion 小窗卡住）。
- **`XIT/ACT`**：新增 contd 采购草稿功能（`contd-generate-purchase-draft`）。
- **`cxpo-order-book`**：添加快速报价单功能，优化空量订单展示。
- **`XIT/BS`**：新增 XIT BS 命令（基地总览面板）。
- **`SFC`**：四大交易所目的地快捷按钮（ANT/BEN/HRT/MOR），当前所在站按钮置灰。
- **`COGCU`**：新增商会补给 ACT 生成 —— 全额账单材料 × 可选倍数生成 CX Buy + MTRA 转移；飞船维修 ACT 移除 MTRA 转移。
- **`XIT/BURN`**：标准货箱填满 —— 飞船填满改为标准货箱选择（SCB/WCB/LCB/HCB），按容量自动计算最大补给天数；ExchangeSelector 支持取消选择。

### 🔧 Improvements

- **`XIT/ACT`**：MTRA 批量转移并行化与静默执行（MTRA_BATCH 步骤，多窗口并行提交、display:none 静默执行，取消/失败后 execute 后台续跑修复）；CX 库存不足时警告而非失败。
- **`XIT/ACT`**：SFC/CONTD 目的地字段改用 `selectAddress` helper。
- **`XIT/BS`**：BS INV 上下文链接重定向到基地存储；`INV <planet>` 直接打开基地存储。
- **`XIT/PLANETS`**：拾取飞船下拉明确标注重量 vs 体积。
- **CSS**：解析扩展 CSS 时保留仅 fragment 的 `url()` 原样。
- **生成面板**：新增 `persisted-ref` 工具记忆上次选择（BURN 生产原料与消耗品默认勾选）；ExchangeSelector 横向按钮组件替换 4 个生成对话框的交易所下拉。
**日期**: 2026-08-09
**说明**: 从 refined-prun 大规模迁移基础能力（P0-P4.5）—— 数据源、核心工具、XIT 命令、UI 组件，并补齐基础设施

### ✨ Features

- **P0 基础**：迁移 zh-locale + companion-buffer + css-proxy。
- **P1 数据源与核心**：迁移 agent-channel/cogcs/populations/population-projects 数据源、agent-channel-messaging + select-address；补齐 burn/buildings/storage-analysis/repair/planetOverrides 基础设施（`getInboundShipStores` / `getRepairThreshold` / `getBaseStorageAnalysis` / `getPlanetRepairAge` 等）。
- **P2 命令**：迁移 `XIT/INV` 库存列表 + planet-context-menu、`XIT/BS` 建筑列表、`XIT/NOBUY` 禁止购买列表、`XIT/PLANETS` 行星覆盖设置、`XIT/LINKEDBUFFERS` 关联缓冲区。
- **P3 面板**：迁移 `XIT/STO` 仓储分析、`XIT/GOVBURN` 政府燃烧规划器、`XIT/DISPATCH` 舰队补给维修规划器、`XIT/AGENT` 代理频道包列表、`XIT/DATA` 数据浏览器。
- **P4 系统**：迁移 data-query 核心子系统、ACT 动作系统扩展、`SET/FINMERGE` 财务备份合并、NumericInput + EndlessScrollControl 通用组件。
- **`XIT/FLT`**：迁移舰队视图与 REFUELACT 命令，补齐 displaytimeBetween 工具；迁移 `XIT/BURNACT` 与 `XIT/REPAIRACT` 行星补给/维修执行命令。
- **`XIT/ACT`**：MTRA 批量转移并行化与静默执行（MTRA_BATCH 步骤，填写阶段自适应等待提速 2-3 倍）。
- **`XIT/GOVBURN`**：配置面板新增 JSON 计划导入。

### 🐛 Bug Fixes

- 补全 unimport 自动导入配置，修复 BS 库存条运行时 `sumBy is not defined`。
- 补全 `LinkedBuffersPreset` 类型（lastBufferSize/controlPosition/childLayouts）与 `LinkedBuffersChildLayout` 接口，对齐 RP 定义。
- GOVBURN 用户数据结构修复（govburn 内嵌 config 而非顶层 govburnConfig）+ 数据迁移。
- planetsStore 补上 DATA_DATA 监听，修复 GOVBURN 获取数据失败（populationId 未更新导致 OPEN_POPI/POPID 超时）。
- 补齐 RUNCN 缺失导出，使 pnpm build 通过。

### 📝 Docs

- 新增 refined-prun → RUNCN 迁移文档（按 Basic 基础功能 / Pro XIT 命令区分）。
**日期**: 2026-08-08
**说明**: CONT 一键确认全部条款；XIT BS 拾取徽章；XIT WHATSNEW 发布说明弹窗

### ✨ Features

- **`CONT`**：合同详情页新增「全部确认」按钮 —— 按顺序点击所有「完成」按钮并自动清除「操作成功」toast，无需手动接受合同。
- **`XIT/PLANETS`**：新增 Pickup 列 —— 按行星选择货运飞船尺寸预设（500/500、1k/3k、2k/2k、3k/1k、5k/5k）。
- **`XIT/BS`**：就绪拾取徽章 —— 基地累积产出（净燃烧为正的物料库存）达到所选飞船载重/容积时显示绿色火箭徽章并附吨位/容积 tooltip；飞船在途时自动清除，防止重复派船。
- **`XIT WHATSNEW`**：发布说明弹窗 —— 自动检查版本更新并渲染 CHANGELOG.md（打包进扩展），可手动通过 footer 版本标签打开；恢复 CHANGELOG.md 并接入发布流程。

### 🔧 Improvements

- **`XIT/ACT`**：SFC/CONTD 目的地字段使用 `selectAddress` helper。
- **build**：修复 vitest 从 dist 收集编译测试；排除 .test.ts 于 eager feature-glob 构建。
**日期**: 2026-08-07
**说明**: REPP 多站聚合视图与价格对齐修复；FX 换汇页修正

### ✨ Features

- **`XIT/REPP`**：新增多站聚合视图与价格对齐修复。
- **`XIT/REPP`**：每个基地行末添加跳转到对应基地的 BRA 按钮。

### 🐛 Bug Fixes

- **`XIT/FX`**：修正换汇页合同货币参数与逻辑描述。

---

---

**日期**: 2026-08-06
**说明**: `XIT REPP` 维修预测面板算法对齐 PRUNplanner 后端核心公式并升级为整站统一 sweep：新增 RESOURCES 建筑（extractor / colony / rig）支持、整站加权 sweep、按基地区分聚合展示

### ✨ Features

- **`XIT/REPP`**：支持 RESOURCES 建筑（EXT / COL / RIG）—— 通过 PrUn ProductionLine 的 `productionTemplates.outputFactors.factor × line.efficiency × msInDay / duration` 计算 per-day 净产值，extractor / colony / rig 现在与 PRODUCTION 建筑一样显示 sweep 结果。
- **`XIT/REPP`**：整站统一 sweep —— 同一基地所有可维修建筑（不限 ticker、不限 age）共享一次 `D∈[0,180]` 的 sweep，返回整体最优维修间隔与全站加权和的日均净利润；与 PRUNplanner 的边际最优日语义一致。
- **`XIT/REPP`**：按基地聚合展示 —— 同一基地的不同 ticker / 不同 age 建筑合并为一行，列表头部展示「PHF + SD + INC」式 ticker 集合，全站加权和的日产估值 / 修满成本 / 日均净利润；展开后查看每个建筑的 per-day 详情。
- **`XIT/REPP`**：精准劳动力成本（per-building）—— 利用 `BuildOption.workforceCapacities × WORKFORCE_CONSUMPTION_MAP` 计算每座建筑的劳动力货币成本，避免按建筑数均摊的旧行为；缺失 BuildOption 时回退到站点按劳动力建筑数均摊。

### 🐛 Bug Fixes

- **`XIT/REPP`**：建筑摊销符号错误 —— 建筑建设成本是「折旧」成本，应在 `dailyRevenue` 中减去（`raw − workforcePortion − constructionCost/180`），之前错误地作为收益加进日产值，导致最优维修日被推向更晚；与 PRUNplanner `usePlanCalculation.ts` L428-432 语义对齐。
- **`XIT/REPP`**：condition 因子双重折扣 —— 旧 sweep 把 `template.outputFactors.factor × line.efficiency × msInDay / duration` 中的 `factor` 当成 base 产出量，而它实际已被 line.efficiency（condition+experts+COGC）折算过；改用 FINPR 的 `order.amount × capacity × msInDay / totalDuration` 公式直接读活跃订单，与 PRUNplanner 满 condition 起点语义一致。
- **`XIT/REPP`**：劳动力成本分摊基数错误 —— 旧实现按 `productionBuildingCount` 均摊，导致资源建筑替生产建筑背锅；改按 `workforceBuildingCount`（PRODUCTION + RESOURCES）均摊，对齐 FINPR / PRUNplanner per-building 语义。
- **`XIT/REPP`**：价格缺失时劳动力成本被部分累加 —— `calcSiteWorkforceCost` 旧逻辑仅标记 `hasAllPrices = false` 并继续累加已知的部分值，造成系统性低估；改为缺失价格时直接 `return undefined` 让 caller 完整跳过该建筑。
- **`XIT/REPP`**：`revenueFromOrders` 在任一 queued order 无 `duration.millis` 时 `totalDuration` 变 `Infinity`，`perDayAmount` 被算成 0；改为 `filter(o => o.duration?.millis != null)` 跳过无 duration 的 queued orders。
- **`XIT/REPP`**：`revenueFromOrders` 错误包含正在跑的 orders（`started != null`）—— 这与 FINPR 的 `getRecurringOrders`（排除 started）相反；改为照搬 FINPR 行为，避免正在跑的 batch duration 被反复累加。

**日期**: 2026-08-05
**说明**: 新增 `XIT REPP` 维修预测面板，照搬 PRUNplanner 日均利润最大化模型从 PrUn ProductionLine 自动读取 per-day 净产出，扫描最优维修触发间隔

### ✨ Features

- **`XIT/REPP`**（别名 `REPAIR_PLAN`）：基于 [PRUNplanner](https://github.com/PRUNplanner/frontend) 维修预测模型 —— sigmoid 效率公式 `0.33 + 0.67 / (1 + e^((1789/25000) × (D − 100.87)))`、维修材料公式 `input − floor((input × (180 − min(180, D))) / 180)`、按日均利润 `avgRevenue − amortizedRepair` 最大化扫描 D∈[0,180] 天最优维修间隔。`dailyRevenue` 从 PrUn ProductionLine 的 `outputs×Bid − inputs×Ask × maxDailyRuns` 自动读取（PRODUCTION 建筑）；RESOURCES 建筑因无 production line 显示 `--`。面板顶部显示数据就绪统计与 CX 价格加载状态。

### 🔧 Improvements

- **`XIT/HELP`**：在"生产与基地"分类下注册 REPP / REPAIR_PLAN 命令，使其出现在 `XIT HELP` 列表。
- **`user-data/repair-plan`**：迁移链清理历史遗留字段 `valuePerEfficiencyDay` / `dailyOutputValue` / `defaultThreshold`；`repairPlan` 简化为空对象占位。

**日期**: 2026-07-29
**说明**: ORG 任务面板持续迭代：完成挂单与任务解耦（阶段 4）、自动关联合同时间窗预筛与权威匹配、发布流程重构为模态对话框、任务列表实时刷新、`XIT ORG` 快捷键重绑、安全加固与多项修复

### ✨ Features

- **`org-api/auto-link`**：合同自动关联新增时间窗预筛逻辑（过滤过旧或过新的合同），配合后端权威匹配统一指纹规则；移除不可靠的 partner 名称校验，改用时间窗 + 指纹 + 唯一约束兜底。
- **`XIT/ORG`**：任务列表实时刷新 —— 新增全局任务事件总线，任务变更实时推送；为任务列表添加作用域过滤逻辑，避免显示无关任务。
- **`XIT/ORG`**：发布流程重构 —— 移除 `PublishTask` 组件和 publish 标签页，新增 `PublishOverlay` 模态发布挂单对话框；在市场页和运输页分别集成发布功能。
- **`XIT/ORG`**：交易面板（`TradeOverlay`）UI 布局与交互优化，新增"创建合同"功能。
- **`XIT/ORG,ARB`**：重构分类逻辑 —— 统一使用 PrUn 内置 `getMaterialCategoryName` 移除冗余本地 fallback；给 `ARB` 模块的分类选项添加字母排序；为 ORG 市场页面添加搜索、分类筛选和仅显示有挂单商品的功能；优化市场页面展示逻辑，按挂单状态和 ticker 排序商品列表；重构 i18n 分类查找逻辑，增加多种匹配变体。
- **`XIT/ORG`**：新增挂单详情面板（`ListingDetail.vue`），实现挂单详情展示与取消功能；重构 `TaskList.vue`，新增 `DisplayRow` 类型区分任务/挂单行；扩展 `TaskList` 支持在 published 视图加载并展示 `OPEN` 状态的挂单。
- **`XIT/CONTGEN+BPC`**：跨面板导入蓝图物料到合同生成器 —— 扩展 `ImportedContractItems` 类型支持回填合同名；优化 `parseActJson` 支持从顶层或 global 字段提取合同名；为 `CONTGEN` 添加 workspace 导入通道；为 `BPC` 新增"导入到 CONTGEN"按钮，自动净化蓝图名作为合同名。
- **`XIT/CONTGEN`**：实现 ACT JSON 导入与总价拆分功能，支持多种输入形态并保留单价信息；新增 BUY/SELL 模板总价拆分功能，支持将总价按规则分配到物品单价中。
- **`org-api`**：挂单与任务解耦（阶段 4）—— 新增挂单 API 模块与数据模型；重构 `TradeOverlay`/`MarketView`/`PublishTask` 组件适配新流程；移除 partial claim 父子任务相关逻辑；新增挂单解耦文档说明整体改造方案。

### 🔧 Improvements

- **`XIT/ACT`**：将计算所需资源量的 `floor` 改为 `ceil`，避免出现资源不足的情况。
- **`XIT/ARB`**：批量更新侧边栏菜单与购物车的中文显示名称，同步购物车名称与数据迁移逻辑。
- **`XIT/ORG`**：`MarketView` 替换 `SelectInput` 为原生 `select` 并优化样式；移除 `TaskDetail.vue` 中无用的调试日志；统一替换 CSS 自定义变量为硬编码色值。
- **`XIT/ORG`**：优化表格列样式与布局 —— 移除冗余 `colgroup`、统一 `box-sizing`/`min-width`、调整各列宽度、为表格添加 `table-layout: fixed` 实现稳定布局。
- **`XIT/ORG`**：移除表格展开列相关代码和样式，简化市场页面表格布局。
- **`XIT/ORG`**：`MarketView` 按钮样式从 dark 改为 primary，统一页面内操作按钮主题色。
- **`XIT/auto-link`**：重构 `auto-link` 为按需启停的活跃任务管理 —— 新增 `task-activity` 模块集中管理活跃任务集合，实现 `globalTick` 按需启停；改造 `claimTask`/`linkContract` 等接口，在任务状态变更时自动注册/注销活跃任务；移除全局无脑启动的 auto-link 轮询，改为任务状态变化触发启停；新增 `recoverActiveTasks` 函数。
- **`org-api`**：简化导入语句，合并类型导入。
- **依赖升级**：升级 `socket.io-parser`、`vue`、`@vitejs/plugin-vue` 等多个依赖包到最新版本，移除 `@types/uuid` 依赖。
- **依赖安全**：升级 `postcss` 到 8.5.24、`brace-expansion` 到 5.0.8，修复 Dependabot 告警（postcss sourceMappingURL Path Traversal、brace-expansion DoS）。
- **`sidebar`**：`XIT ORG` 快捷键重绑（原 `XIT FACTION` 已废弃）。

### 🐛 Bug Fixes

- **`XIT/ORG`**：弹窗限制在 ORG 窗口内，并修正 PrUn 身份来源 —— `TradeOverlay`/`LinkContract` 改为 `position: absolute` 避免覆盖整个视口；`ORG.vue` 容器加 `position: relative + min-height: 0` 作为定位锚点；`main.ts`/`AuthOverlay.vue` 把当前 PrUn 身份来源从 `usersStore.all[0]` 改为 `userDataStore.username`，避免同公司其他用户名被误读。
- **`org-api`**：完成旧版接取接口迁移，删除废弃 `claimTask` 相关代码（`types.ts`、`tasks.ts` 注释、所有调用方），接取统一走 `listings.claimListing`；`TaskDetail.vue` 移除直接接取按钮。
- **`org-api`**：修复接取挂单后合同自动关联逻辑 —— 为 `claimListing` 添加接取成功后的活跃任务通知；区分新老任务的合同自动关联规则，简化新架构下的创建方判断。
- **`org-api, task-detail`**：修复自动关联和删除权限逻辑 —— 移除合同状态 OPEN 过滤，支持终态合同自动关联；调整子任务删除权限，允许终态下删除 partial claim 子任务；简化合同关联的模板和货币解析逻辑。
- **`auto-link`**：修复 session 过期后 auto-link 持续发送 401 请求 —— `ORG.vue` 在 `onUnauthorizedCallback` 中加入 `stopGlobalAutoLink`；`auto-link.ts` 在 `globalTick` 检测到 401/403 自动停止轮询；`client.ts` 添加 `sessionExpired` 标志防止并发 401 重复触发回调；`auth.ts` 在登录/注册成功后重置标志。

### 🔒 Security

- **`isValidUrl`**：复用 `SAFE_SCHEMES` 白名单限制 http/https 协议，与 `isSafeUrl` 行为一致；修复 CodeQL `js/incomplete-url-substring-sanitization` 告警。
- **`formatDateTime`**：移除无操作的 `s.replace(' ', ' ')` 自身替换，修复 CodeQL `js/identity-replacement` 告警。

### 📝 Docs

- **XIT 命令一览**：新增 `XIT命令一览.txt`，集中列出全部 `XIT` 命令的用途与参数。
- **`org-api/listings-decoupling`**：新增挂单与任务解耦的设计文档。

## 26.7.24 (后续)

### ✨ Features

- **`XIT/ORG`**：任务详情页新增合同关联展示，支持通过 `PrunLink` 直接打开合同；新增合同状态自动同步功能，实时更新任务进度；重构自动匹配逻辑，优化合同指纹生成与匹配规则。
- **`ORG/user-manager`**：用户管理新增最后活跃时间列与排序。`OrgUser` 接口新增 `lastSeenAt` 字段；同角色下按最后活跃时间倒序排序；兼容多种时间来源；新增 UTC 时间格式化工具函数。

### 🔧 Improvements

- **`org-api/auto-link`**：自动链接轮询间隔从 30s 调整为 5s，提升匹配实时性；移除自动关联时的确认弹窗，直接自动匹配通过；优化合同价格匹配逻辑，兼容缺失顶层价格的场景。

---

## 26.7.23

### 🔧 Improvements

- **`ORG`**：更新开发和生产环境的 API 接口地址。

## 26.7.22.1555

### 📝 Docs

- **`ORG`**：`AUTO_LINK_CONTRACT.md` —— 标记后端权威匹配已落地。

### 🔧 Improvements

- **`XIT/ORG`**：自动关联接入后端权威匹配，前端指纹作为辅助提示。

## 26.7.22.933

### 🐛 Bug Fixes

- **`XIT/ORG`**：完善任务状态标签逻辑，新增 `contractId` 参数适配。

## 26.7.22.616

### 🐛 Bug Fixes

- **`ORG`**：修复错误处理并补充合法的 `tab` 枚举值。

## 26.7.22

### 🔧 Improvements

- **`XIT/ORG`**：优化任务相关代码逻辑（`org-api`、`task-detail`、`task-list` 拆出重发任务与表格视图）。

## 26.7.21.1627

### 🐛 Bug Fixes

- **`XIT/ORG`**：`deleteTask` 区分任务不存在与端点未部署，输出中文友好提示。

## 26.7.21.1327

### ✨ Features

- **`XIT/ORG`**：任务价格统一千分位显示，修复切换 tab 后任务详情残留。

## 26.7.21

### 🐛 Bug Fixes

- **`XIT/ORG`**：修复任务卡片类型显示与轮询逻辑问题。

> 26.7.21 同日合并 `feat(ORG): 新增组织任务管理面板功能` 主体实现，作为 26.7.21 的功能基线。

## 26.7.19 (后续)

### ✨ Features

- **`XIT/ORG`**：与 PrUn 整体风格统一（`PrunButton` / `Header` / `SectionHeader` / `Active` / `PrunLink` / `ActionBar` / `C.Panel` / `C.Tabs` / `C.Chip`）。

### 🐛 Bug Fixes

- **`XIT/ORG`**：发布者可物理删除自己发布的任务（终态显示，输入 `DELETE` 二次确认）。

---

**日期**: 2026-07-19  
**说明**: 修复 BPC / CART ACT 包名在蓝图或购物车名称包含括号 / 引号等符号时的解析失败

### 🐛 Bug Fixes

- **`XIT/BPC`**：`generateAct` 的包名净化只剥离非 ASCII（`/[\x20-\x7E]/`），却保留 `( ) ' " & ! ?` 等可打印 ASCII 符号，导致 `XIT ACT_${name}` 命令在 PrUn 端解析失败。改为保留 `A-Za-z0-9-`，其余符号与空白折叠为单个空格。例如 `"HWS Defense (Missile)"` → `"BP-DHEZ-4037 HWS Defense Missile Buy"`。
- **`XIT/CART`**：`generateAct` 同样问题。购物车名称若含括号 / 引号 / `&` 等符号，会写进 `pkg.global.name` 并参与 `XIT ACT_${name}` 命令，PrUn 端解析失败。改为生成前先调用新增的 `sanitizeActName` 净化（与 BPC 同款规则），保证存储名与命令名一致、ACT 列表回查可命中。

## 26.7.17 (后续)

### 🐛 Bug Fixes

- **`CONTD`**：地址自动填充回归。CONTGEN 引入期间对 `selectListboxItem` / `selectAddressListboxItem` 的拆分与 `clickElement` 改造破坏了模板位置栏的 React-Autowhatever `onSuggestionSelected`。恢复成 bb9720ce 版本的统一 `selectListboxItem`（同时处理 MaterialSelector 与 AddressSelector 的嵌套 sections）+ 原生 `.click()` 事件。
- **`CONTD`**：`changeInputValue` 加 `beforeinput` 事件反而抑制了 AddressSelector 的 server search。回退到原始版本（仅 `input` + `change`）。
- **`CONTD`**：BUY/SELL per-row `price` 在缺失时回退到顶层 `price`，避免每行重复填写。
- **`XIT CONTGEN`**：BUY/SELL 顶部 `price` 作为每行单价默认值，与 `validateConfig` 校验规则保持一致；per-row `price: 0` 不再写入 JSON（让校验回退到顶层）。

## 26.7.17

### ✨ Features

- **`CONTD`**：JSON 自动填充新增 `SHIP` 模板支持。需要 `origin` + `destination` + 顶层 `price`（per-row `price` 不再必需），位置必须使用行星/基地 naturalId（不再支持 station 名如 `Hortus Station`，地址选择器仅搜行星）。
- **`CONTD`**：JSON 自动填充新增 `name` 字段，可在合同头部写入合同名称（与 conditions 表分开保存：先写名 + 点 header 保存按钮 PATCH，再开 template modal 填条件）。
- **`XIT CONTGEN`**：新增合同 JSON 生成器面板（`XIT CONTGEN` / `XIT CGEN`）。通过表单填写合同条件（合同类型 / 币种 / 名称 / 目的地 / 出发地 / 运费 / 物品清单）实时生成 JSON，可一键复制或直接发送到 CONTD 自动填充面板。物品 ticker 支持模糊搜索（ticker + i18n 名称），行星地址支持 fuzzy prefix 搜索。

### 🐛 Bug Fixes

- **`CONTD`**：延长 SHIP 地址 listbox 轮询时间到 15s，适配慢网络下 server search 延迟。
- **`CONTD`**：校验 `origin` 与 `destination` 不能相同（先经 alias 展开），避免 SHIP 模板下两端点冲突。
- **`extension-update`**：修复扩展更新检查在 `chrome.runtime.id` 不可用时导致的控制台刷屏。当 `config.url.manifest` 解析为 `chrome-extension://invalid/...` 时跳过整个轮询；连续 3 次 fetch 失败后 `clearInterval` 熔断，避免每秒一次的 `net::ERR_FAILED` 噪音。

## 26.7.16

### ✨ Features

- **反色模式（项目内置暗黑模式）**（`XIT/SET/DARK`）：内置反色显示模式（invert + hue-rotate），媒体元素二次反转恢复正常。
- **BPC 价格列货币标签**（`XIT/BPC`）：BPC 价格表格从 CSS Grid 切换为原生 `<table>`，为 4 个玩家交易所（AI1/CI1/IC1/NC1）价格列加入对应货币代码（AIC/CIS/ICA/NCC），统一列对齐。

### 🔧 Improvements

- **发行流程**：修复 GitHub Actions 发布工作流，确保发布版本不再处于草稿状态。
- **配置注入**：重构配置注入逻辑，将模块脚本与配置分离到独立 `script` 元素，避免浏览器清除内联内容导致解析失败；为 `BPC` 与 `ARB` 页面的表单控件补充 `id` 和 `name` 属性，提升可访问性与调试便利性。

### 🐛 Bug Fixes

- **`XIT/BPC`**：移除未使用的 `colWidth` 常量以通过 lint。

## 26.7.15

### ✨ Features

- **`XIT/BPC`**：新增配件多选、单市场购买与 ACT 生成功能（含 CI2/NC2 低流动性交易所屏蔽、ACT 采购包自动生成）。
- **`XIT/BPC`**：重构表格布局为 CSS Grid，添加手动价格刷新按钮与移动端适配；修复蓝图名称空值时的排序崩溃。
- **`XIT/BPC`**：获取造船蓝图与市场配件价格，新增 BP 工具模块。
- **`CONTD`**：新增 JSON 自动填充合同草稿面板，支持模板、币种、商品、地址与截止日期解析。

## 26.7.14

> 26.7.14 仅包含 CHANGELOG 同步提交，无新功能变更。

## 26.7.13

### ✨ Features

- **`XIT/PWARN`**：产线停机与产能空闲预警面板。
- **`XIT/WFOR`**：跨基地劳动力满足度总览面板。
- **`XIT/EXP`**：跨基地专家培养进度总览面板。
- **`EXP`**：专家数据懒加载，过滤无效条目。
- **`HAUL`**：运输合同单位费率与平均费率。
- **`FINPR`**：拆分成本结构为劳动力与材料两部分。
- **`CONTC`**：合同条件依赖路径与截止日期预警。
- **自动化测试缺口分析**：分析与补充自动化测试覆盖。
- **提交后高影响缺陷检查**：新增提交流程的高影响缺陷检查。
- **Codex 技能**：内置 6 个新 Codex 技能。

### 🔧 Improvements

- **`XIT/PWARN`**：替换内联样式为统一的按钮类名。

### 🐛 Bug Fixes

- **`WFOR`**：过滤掉所需人数为 0 的劳动力项。
- **`EXP`**：移除未使用的 `percent0` 导入。

### 🗑️ Removed

- **`XIT/MMOD` 用户统计功能**：MMOD 插件中移除用户统计相关功能。
- **组织管理相关功能及配置**：移除派系/组织管理面板及对应配置。

## 26.7.12

> 26.7.12、26.7.12.806、26.7.12.833 三个 tag 合并到本节。

### ✨ Features

- **`XIT/ARB`**：替换自定义选择器为原生 `select` 并添加样式。

## 26.7.11

### ✨ Features

- **倒货助手 (`XIT ARB`)**：新增跨市场套利工具，支持出发地/目的地路由选择、飞船选择、基于 `SHIP_STORE` 真实密度 / 容积 / 重量的贪心分配、买卖过滤、汇总栏（含总花费·出发地币种、预期利润），并可一键生成 `XIT ACT` 脚本。
- **CX 价格偏离度 (`cx-price-deviation`)**：在 `CX` 系列面板展示 VWAP / 7d VWAP 价格偏离度。
- **`XIT/CXTS`**：按时间粒度展开默认分组。
- **`XIT/ACT`**：日志与报价新增涨跌标识与高亮展示。
- **`flt-hide-cargo-fuel-buttons`**：在 `FLT` 系列面板中隐藏货物 / 燃料按钮。
- **聊天翻译 (`chat-translation`)**：翻译配置系统重构，新增多家 AI 翻译服务（Anthropic、OpenAI 兼容、DeepL、Microsoft、Google、HuggingFace、Gemini、自定义 HTTP 等）的独立 Provider；新增 AI 翻译模型可用性查询与中文 UI；强化 URL 主机白名单与脚本重挂校验。
- **特性注册表**：记录并日志输出已加载特性数量与成功状态。

### 🔧 Improvements

- **`XIT ACT/CXPO_BUY`**：总费用计算改用真实价格限制参数，与历史对比算法口径保持一致。
- **`XIT ACT runner`**：重构重量 / 体积负载叠加路径，容量约束更稳定。
- **`XIT BURN`**：资源剩余天数计算纳入预留分配量。
- **`XIT`**：合同模块样式与状态类统一实现；公共样式与工具函数抽离，减少重复代码。
- **`XIT ARB / CART`**：类别 / 材料支持中文显示。
- **样式 / 格式化**：应用 Prettier 全量格式化，解决 14 处 `prettier/prettier` 告警。

### 🐛 Bug Fixes

- **`XIT/ACT runner`**：修复重量 / 体积重复叠加错误。
- **`XIT/ACT/CXPO_BUY`**：修复历史价格对比因变量错误导致的口径偏差。
- **`XIT BURN`**：修复资源剩余天数计算遗漏预留量。
- **`XIT/ACT/EditPriceLimits`**：修复直接修改 `props` 导致的响应式状态同步问题。
- **`price-deviation`**：处理 `vwap7d` 为空的情况，移除冗余非空断言。
- **`chat-images`**：渲染前校验 URL scheme 与扩展名。
- **`shell` / `prepare`**：脚本重挂时强制主机白名单；改用 hostname 比较替代子串匹配。
- **CI / 发布**：移除 GitHub workflow 中不必要的 `models` 读取权限；为 lint workflow 添加显式 `permissions`；更新发布步骤以自动生成发布说明。
- **依赖安全**：通过 `overrides` 清理 7 条 transitive 漏洞；升级主项目直接依赖修复 Dependabot 高危漏洞；升级 `defu` 6.1.4 → 6.1.7。
- **`XIT ARB`**：修复表格列宽 / 勾选错位 / 类别列竖排 / 市场列点击 / `undefined` 防御 / `SHIP_STORE` 查找方式 / 包名分隔符（空格，匹配 ACT lookup）等多项问题。
- **URL 安全**：将 sink URL 路由走规范化 `URL.href`，并补充相关安全模式文档。

### 🔒 Security

- 翻译功能加固：完整白名单 + 单元测试。
- 修复 `chat-images`、`shell`、`prepare` 三处与 URL 解析相关的潜在安全风险。
- 依赖安全升级（详见 Bug Fixes 段）。

## 26.5.18

### 新增

- `shpi-base-inv-button`: 当飞船停靠在基地时添加 INV 上下文按钮
- `shpi-warehouse-button`: 当飞船停靠在有仓库的地址时添加 WAR 上下文按钮
- `pli-cogc-label`: 将"全球商业商会"行标签替换为"CoGC ({program type})"

### 修改

- `XIT BURN`: 将 PROD 和 WF 按钮改为仅排除非活动物料行，不影响输入/输出速率
- `XIT ELEC`: 按选举结束日期升序排序选举
- `inv-warehouse-button`: 将按钮移动到上下文栏
- 按住 Shift 键删除交易所订单时跳过确认覆盖层
- 优化从非 CXOS 位置删除自己订单的性能

### 修复

- `audio-volume-slider`: 修复某些情况下音量未应用的问题
- `minimize-headers`: 修复 `POPID` 面板中库存选择器被最小化的问题
- `mtra-auto-focus-amount`: 修复数量输入框无法自动聚焦的问题

## 26.5.11

### 新增

- `XIT ELEC`: 显示您拥有基地的行星即将举行的选举
- `XIT FXTS`: 列出您所有的外汇交易记录
- `adm-hide-inactive-buttons`: 隐藏非活动按钮
- `bs-warehouse-button`: 添加"仓库"按钮
- `cxo-delete-order-button`: 添加删除按钮
- `cxob-delete-own-exchange-orders`: 在自己的订单上添加删除按钮
- `inv-shpt-condition-indicator`: 在 SHPT 和 BLCK 物品上添加合同条件指示器
- `inv-warehouse-button`: 在基地库存中添加"仓库"按钮

### 修改

- `XIT ACT`: 在 `MTRA` 配置中根据所选来源过滤目标列表
- `XIT BURN`: 添加 PROD、WF 和 I/O 过滤按钮
- `XIT CONTC`: 在"贡献"条件中显示地址链接
- `contribution-maxed`: 在 `POPID` 面板中禁用此功能
- `cxpo-order-book`: 在自己的订单上添加删除按钮
- `minimize-headers`: 在 `POPID` 面板中启用标题最小化
- `nots-notification-type-label`: 为新通知类型添加标签

### 修复

- `XIT ACT`: 防止手动输入的数量/价格被订单簿更改覆盖
- `XIT PROD`: 修复从 `XIT PROD` 打开的 `PRODQ` 面板中的订单删除问题
- `prun-bugs`: 防止拖动项目时选择文本

## 26.3.22

### 新增

- `XIT PROD`: 密集的跨基地生产概览
- `contribution-bulk-controls`: 在贡献部分添加 NONE/ALL 按钮
- `contribution-maxed`: 在 CoGC 和人口维护面板中自动最大化贡献滑块
- `flt-flex-fuel`: 允许燃料列布局更好地利用可用空间
- `sidebar-hide-zero-currencies`: 隐藏右侧边栏中余额为零的货币
- `sysi-blue-negative-value`: 将较低的负行星值显示为蓝色而非红色

### 修改

- `XIT BURN`: 添加适合 Google Sheets 的复制按钮
- `XIT CONTS`: 添加缺失的条件标签
- `XIT CONTC`: 添加缺失的条件描述
- `flt-ship-condition`: 恢复红色/黄色阈值；红色为 79%，黄色为 81%

### 修复

- `prun-bugs`: 修复系统信息中的点/箭头左偏问题
- `prun-bugs`: 修复选择库存网格项目时的布局偏移
- `prun-bugs`: 修复滑块点拉伸和光标样式问题
- `prun-bugs`: 禁用因储备已满而无法填充的 POPID 滑块
- `screen-tab-bar`: 修复触控板滚动抖动问题并添加水平手势支持
- 修复用户没有仓库时财务数据收集失败的问题

## 26.1.24

### 新增

- `expand-sidebar-contract-list`: 完全展开侧边栏中的合同列表
- `mat-refined-prun-price`: 添加"精炼 PrUn 价格"行

### 修改

- `flt-ship-condition`: 将黄色条件阈值移动到 80% 并移除红色阈值

### 修复

- `XIT ACT`: 修复与轨道飞船相关的错误
- `XIT FINCH`: 修复 Y 轴标签小数位数问题
- `XIT GIF`: 修复黑边问题
- `browser-tab-name`: 修复幽灵通知
- `other-context-notification-count`: 修复幽灵通知（希望这次彻底解决）

### 移除

- `cxpc-default-1y`: 此功能有太多边缘情况

## 26.1.15

### 修改

- `XIT FINCH`: 如果禁用完整权益模式，在权益图表上添加"(部分)"后缀
- `XIT GIF`: 从 Giphy 切换到 Klipy

### 修复

- `XIT SET BFR`: 修复表格标题行对齐问题
- `browser-tab-name`: 修复已删除通知的幽灵通知计数器

## 26.1.11

### 新增

- `bbc-building-count`: 在建筑图标上添加建筑计数标签
- `browser-tab-name`: 根据当前屏幕重命名浏览器标签

### 修改

- `XIT ACT`: 使物料组和操作列表可重新排序
- `XIT FINBS`: 将漩涡燃料存储添加到"燃料箱"总计中
- `XIT FINBS`: 在每行添加按钮以使用所选图表打开 `XIT FINCH`
- `XIT FINCH`: 为资产负债表中的所有条目添加图表
- `XIT SET`: 在默认选项中显示 12h/24h 时间格式
- `XIT SET`: 使侧边栏按钮列表可重新排序
- `XIT SET FIN`: 添加"权益模式"切换以在完整和部分权益之间切换
- `XIT SORT`: 使排序模式列表可重新排序
- `flt-flight-status-icons`: 为新状态类型添加图标并使 JUMP 图标更具辨识度
- `inv-compress-inventory-info`: 在 `SHPI` 中为卸载按钮添加右侧小填充
- `inv-shorten-storage-types`: 使用基础游戏中的短类型标签而非自定义标签
- `inv-shorten-storage-types`: 在过滤栏中缩短存储类型
- 在所有功能中忽略行星基础设施库存
- 对使用时间少于 90 天的新 Refined PrUn 用户禁用完整权益模式

### 修复

- `cxpc-default-1y`: 修复打开一次后 1y 图表无法打开的问题
- `nots-notification-type-label`: 为缺失的通知类型添加标签

## 25.12.30

### 修改

- 在无参数的 `XIT` 命令中打开 `XIT CMDS`

### 修复

- `cxpc-default-1y`: 修复从非 `CXM` 打开时 1y 图表只显示 30 天数据的问题
- 修复无参数的 `XIT` 命令破坏后续所有 `XIT` 命令的问题

## 25.12.28

### 新增

- `audio-volume-slider`: 在屏幕右上角的游戏设置中添加音量滑块
- `cxpc-default-1y`: 打开时选择 1y 图表

### 修改

- `XIT BURN`: 添加对 `NOT` 过滤器的支持，例如 `XIT BURN NOT MALAHAT`
- `correct-commands`: 在系统命令中添加对行星的支持，例如 `SYSI PROMITOR`
- `correct-commands`: 在系统命令中添加对空间站的支持，例如 `SYSI ANT`
- `nots-notification-type-label`: 为新通知类型添加标签
- `nots-notification-type-label`: 调整颜色以提高可读性并与游戏 UI 保持一致
- 将默认音频音量降低到 40%

### 修复

- `XIT ACT`: 修复 CX Buy 操作因某些本地化中的数字格式而执行失败的问题
- `bs-hide-zero-workforce`: 修复"当前劳动力"列标题中的损坏工具提示
- `co-base-count`: 修复网关更新后功能无法正常工作的问题
- `cxpo-auto-price`: 修复本地化数字格式
- `exp-expert-eta`: 修复没有重复订单的生产线的 Infinityd 错误
- `hide-system-chat-messages`: 修复网关更新后垂直指示器不可见的问题
- `inv-compress-inventory-info`: 修复 `SHPI` 中功能无法正常工作的问题
- `other-context-notification-count`: 修复幽灵 INFRASTRUCTURE_UPGRADE_COMPLETED 通知
- `screen-layout-lock`: 修复游戏 URL 不包含屏幕 ID 时功能无法正常工作的问题

## 25.11.16

### 新增

- `screen-layout-lock`: 添加屏幕锁定功能
- `cxos-hide-delete-filled`: 过滤隐藏时隐藏"删除已填充"按钮

### 修改

- `XIT ACT`: 使操作包列表可重新排序
- `XIT ACT`: 在 CX Buy 操作中添加"允许未完成"选项
- `XIT ACT`: 移除帮助按钮
- `XIT SET`: 为从备份恢复添加确认弹窗
- `XIT SORT`: 为排序模式添加复制/粘贴按钮
- `item-icons`: 添加殖民船相关物料的图标
- `screen-tab-bar`: 使标签栏可滚动以允许屏幕外标签

### 修复

- `XIT ACT`: 修复物料数量为零时 MTRA 操作卡住的问题
- `XIT ACT`: 修复物料数量为零时 CX Buy 操作卡住的问题
- `XIT CONTS`: 修复合同中政府合作伙伴显示问题
- `XIT CONTS`: 修复"建造飞船"条件的显示文本
- `XIT NOTE`: 修复物料代码被更改为注释中第一个代码的问题
- `correct-commands`: 修复 XIT WEB 中没有 http:// 或 https:// 的链接的 URL 修正
- `sidebar-contracts-details`: 修复合同中政府合作伙伴显示问题
- 修复"基础设施"类别中物料的颜色

## 25.8.16

### 新增

- `bui-sort-recipes`: 按类别/代码/数量排序顺序对配方和物料进行排序

### 修改

- `XIT BURN`: 添加 `OVERALL` 可选参数以仅显示总体消耗
- `shipping-per-unit-price`: 移除 `LMP` 单价标签中的货币符号
- 改进"无人机"和"飞船套件"类别的排序顺序

### 修复

- `planet-commands`: 修复将空间站自然 ID 替换为行星自然 ID 的问题

## 25.8.1

### 新增

- `XIT PRUNSTAT`: 打开 PrUn 财务报告网站

### 修改

- `XIT ACT`: 允许加油操作在燃料存储不足时处理
- `XIT ACT`: 添加重命名按钮
- `XIT ACT`: 在 MTRA 操作的地址选择器中过滤掉燃料箱
- `XIT FIN`: 在 FIN 上下文栏中添加缺失的 `XIT FINBS` 命令
- `XIT NOTE`: 使标题可点击以允许重命名
- `XIT TODO`: 使标题可点击以允许重命名

### 修复

- `XIT ACT`: 修复物料无法完全转移时 MTRA 操作执行失败的问题

## 25.7.19.1611

### 修复

- 修复扩展无法加载的另一种情况

## 25.7.19

### 新增

- `blck-item-destination`: 为 BLCK 物品添加目标地址
- `cxpc-chart-types`: 添加"平滑"和"对齐"图表类型
- `shorten-shpt-blck-address`: 缩短 SHPT 和 BLCK 物品中的地址
- `usr-subscription-level`: 添加用户许可证信息

### 修改

- `XIT ACT`: 将"无需加油"消息级别更改为 INFO
- `prun-bugs`: 移除 `CONTD` 条件保存修复

### 修复

- `XIT ACT`: 修复加油操作中的差一错误
- `XIT FINPR`: 修复 PRO 许可证到期后的盈利能力计算
- `cxpo-order-book`: 修复表单标签文本溢出
- 修复扩展在某些情况下无法加载的问题

### 移除

- `shipment-item-detail`: 此功能现在已在 APEX 中原生实现

## 25.6.18

### 新增

- `exp-expert-eta`: (新) 显示下一位专家出现的预计时间
- `show-space-remaining`: (新) 在 INV 和 SHPI 中显示所选存储的剩余重量和容量
- `wf-workforce-filters`: (新) 添加过滤器以隐藏零劳动力类型和消耗品

### 修改

- `XIT ACT`: 添加加油操作
- `custom-left-sidebar`: 将 ACT、BURN 和 REP 添加到默认左侧边栏按钮
- `input-math`: 在数学表达式中添加"k"替换为 1000

### 修复

- `XIT BURN`: 修复某些情况下消耗值不正确的问题
- `XIT CXTS`: 修复金额列格式不正确的问题
- `other-context-notification-count`: 修复通知计数有时包含已删除通知的问题
- 修复日期/时间/数字格式不尊重所选语言的问题

## 25.6.9.1557

### 修复

- `XIT ACT`: 修复 CX Buy 操作在意外订单簿更新后卡住的问题

## 25.6.9

### 修复

- `other-context-notification-count`: 修复计数器显示"幽灵"通知计数的问题

## 25.6.8

### 新增

- `other-context-notification-count`: (新) 在 NOTS 标题标签中显示来自其他上下文的通知数量
- 添加用户数据备份（最多 5 个，每 24 小时）
- 添加扩展重新安装后从备份恢复用户数据的功能

### 修改

- `XIT ACT`: 在操作编辑器中添加导出按钮
- `XIT ACT`: 在操作导入提示打开时自动聚焦文本输入框
- `XIT SET`: 导入或重置用户数据后重新加载页面
- `highlight-own-exchange-orders`: 将自己的订单行设为粗体
- `item-icons`: 为 INS 图标添加细节
- 交换类别排序中 SF 和 FF 的顺序

### 修复

- `XIT ACT`: 修复 CX Buy 操作使用过期订单簿数据的问题
- `XIT WEB`: 修复 iframe 对 Firefox 来说太大而无法正确滚动的问题
- `cxob-depth-bars`: 修复新下达订单时功能无法正常工作的问题
- `cxpo-order-book`: 修复价格/数量自动填充数字格式
- `cxpo-order-book`: 修复点击 MM 订单金额时不填充价格的问题
- `highlight-own-exchange-orders`: 修复新下达订单时功能无法正常工作的问题
- `screen-tab-bar`: 修复页面 URL 包含上下文 ID 时 SCRN 列表不更新的问题

## 25.4.27

### 新增

- `mu-fix-sector-names`: (新) 修复扇区名称，例如 LE => LS

### 修改

- `XIT ACT`: 添加操作包名称验证
- `XIT HELP`: 移除操作包帮助
- `cxpo-order-book`: 更改自己订单的显示方式 - 使用金额链接而非行高亮
- `highlight-own-exchange-orders`: 更改自己订单的显示方式 - 使用金额链接而非行高亮

### 修复

- `cxob-depth-bars`: 修复在 Firefox 和旧版 Chromium 中功能无法正常工作的问题

## 25.4.24

### 新增

- `cmds-clickable-commands`: (新) 使命令可点击
- `cx-search-bar`: (新) 添加物料搜索栏
- `cxob-center-on-open`: (新) 打开时居中订单簿
- `cxob-depth-bars`: (新) 添加市场深度条形图
- `cxob-hide-section-headers`: (新) 隐藏"报价"和"请求"标题
- `cxob-supply-demand-values`: (新) 添加供需价值标签
- `cxpo-auto-price`: (新) 添加自动价格计算
- `cxpo-bigger-buttons`: (新) 增大"买入"和"卖出"按钮
- `macos-antialiased-font`: (新) 在 macOS 上对所有字体应用抗锯齿平滑

### 修改

- `cxpo-order-book`: 添加通过点击订单金额和价格自动填充价格和数量的功能
- `cxpo-order-book`: 将 `CXPO` 缓冲区的默认宽度增加 60px
- `cxpo-order-book`: 移除"报价"和"请求"部分标题
- `prun-bugs`: 修复右侧和底部工具提示中的箭头位置

## 25.4.14

### 修改

- `XIT ACT`: 在 CX Buy 操作步骤描述中添加总成本
- `XIT ACT`: 改进"部分购买"CX Buy 操作的步骤生成和日志消息
- `XIT ACT`: 如果操作无法执行，将未失败的操作标记为跳过
- `XIT ACT`: 使 CX Buy 和 MTRA 操作在执行下一个操作前等待存储更新
- `XIT ACT`: 当 CX 仓库空间不足时为 CX Buy 操作添加错误提示

### 修复

- `XIT ACT`: 修复订单簿中没有订单且"部分购买"开关打开时 CX Buy 操作卡住的问题
- `XIT ACT`: 修复没有可用来源/目标的可配置 MTRA 包打开运行面板的问题
- `XIT ACT`: 修复目标库存没有空间时 MTRA 操作卡住的问题
- `XIT ACT`: 修复来源库存中不存在物料时 MTRA 操作错误
- `XIT SET`: 修复财务数据点删除目标错误数据点的问题

## 25.4.12

### 新增

- `tile-controls-background`: (新) 为右上角面板控件添加纯色背景
- `prodco-order-eta`: (新) 为订单添加完成预计时间标签

### 修改

- `XIT ACT`: 为没有任何操作包的用户添加快速入门流程
- `XIT ACT`: 添加在包运行期间打开缺失面板的功能
- `XIT ACT`: 在浮动缓冲区中为包运行添加配套面板
- `XIT ACT`: 在补给和维修操作中添加"执行时配置"作为行星选项
- `XIT ACT`: 在 MTRA 操作期间自动选择物料
- `XIT ACT`: 改进 MTRA 操作期间"不会被转移"警告的措辞
- `XIT ACT`: CX Buy 期间物料不足时停止包运行
- `XIT ACT`: 改进库存选择下拉菜单中的排序
- `XIT ACT`: 添加日志自动滚动
- `XIT ACT`: 在日志中显示额外的上下文数据
- `XIT ACT`: 为补给物料组添加自动获取消耗数据
- `XIT ACT`: 将配置 UI 更改为基于表单
- `XIT ACT`: 使包运行期间的 UI 布局更稳定
- `item-icons`: 添加消耗品捆绑类别的图标
- 将"消耗品捆绑"类别中的项目排序更改为基于等级

### 修复

- `XIT ACT`: 修复补给物料数量与 `XIT BURN` 中的数量不匹配的问题
- `XIT ACT`: 修复包运行期间缓冲区移动时操作按钮位移的问题
- `XIT ACT`: 修复浮动缓冲区中包运行的各种问题
- `XIT BURN`: 修复零金额有时显示为"-0"的问题
- `prodco-order-eta`: 修复最近游戏更新导致的功能损坏
- `prodq-order-eta`: 修复初始为空的订单槽中缺少预计时间的问题
- `prun-bugs`: 修复 `GIFT` 面板中用户搜索结果框过大的问题
- `table-rows-alternating-colors`: 修复 Firefox 中的渲染问题
- 修复堆叠覆盖层（如 `XIT ACT` 中的）显示不正确的问题
- 修复扩展制作的图标中消耗品捆绑的项目颜色

## 25.3.24

### 新增

- `header-hide-controls-button`: (新) 为包含上下文控件的面板添加隐藏和显示上下文控件的按钮
- `lead-per-day-column`: (新) 在"商品生产"排行榜中添加"每日"列
- `prodq-hide-government-links`: (新) 隐藏费用收集器链接
- `prodq-order-eta`: (新) 为订单添加完成预计时间标签
- `prodq-shorten-material-links`: (新) 将物料全名缩短为带链接的代码

### 修改

- `inv-compress-inventory-info`: 将功能移至基础功能集
- `nots-notification-type-label`: 在较小缓冲区尺寸中使通知布局更节省空间

### 修复

- `XIT CXTS`: 修复日期之间有间隔时日期显示不正确的问题

## 25.3.17

### 新增

- `contd-condition-address-placeholder`: (新) 将当前地址设置为条件编辑器地址字段的占位符

### 修改

- `XIT HQUC`: 取消 HQ 等级上限
- `XIT REP`: 在 `BRA` 上下文按钮中使用行星 ID

### 修复

- `XIT GIF`: 修复损坏的 GIF
- `focus-buffers-on-click`: 在 `HQ` 中禁用此功能以修复重新定位输入重置问题
- `prun-bugs`: 修复 `PROD` 中滚动条槽在没有滚动条时占用空间的问题

### 移除

- `contd-fill-condition-address`: 被 `contd-condition-address-placeholder` 取代

## 25.3.8

### 新增

- `contd-fill-condition-address`: (新) 填充条件编辑器中的地址字段
- `highlight-production-order-error`: (新) 在 `PROD`、`PRODQ` 和 `PRODCO` 中高亮显示有错误的生产订单
- `shipment-item-detail`: 添加字体自动调整大小

### 修复

- `prun-bugs`: 修复金额不变时 `CONTD` 条件保存问题
- 修复 Refined PrUn 添加的上下文控件中命令的错误加粗

## 25.2.27

### 修复

- `XIT SHEET`: 修复带下划线的文档 ID 解析问题
- `inv-compress-inventory-info`: 修复较小面板中的可用性问题并恢复地址链接

## 25.2.25

### 新增

- `XIT CXTS`: 在每日摘要中添加购买/销售
- `XIT SHEET`: 添加 Sheet ID 的可选参数
- `context-controls-no-hover`: (新) 防止在悬停时显示上下文控件的描述
- `inv-compress-inventory-info`: (新) 将特定库存信息压缩到一行
- `prod-hide-percent`: (新) 隐藏生产线中的百分比值

### 修改

- `XIT CXTS`: 隐藏只有单笔交易的日期的每日摘要

### 修复

- `prod-order-eta`: 修复完成时间计算不正确的问题
- `prun-bugs`: 修复 PROD 和 PRODQ 缓冲区中的物料图标不可点击的问题
- 修复运输中物料资产价值在长期应收物料中的重复计算

## 25.2.11

### 修复

- `custom-item-sorting`: 修复"+"按钮无法打开 `XIT SORT` 的问题
- `mtra-transfer-on-enter`: 修复停靠面板中功能无法正常工作的问题
- 修复覆盖层不显示的问题

## 25.2.6.1805

### 修复

- `custom-item-sorting`: 修复上一次更新引入的几个错误

## 25.2.6

### 新增

- `XIT CONTS`: 添加 CONTRIBUTION 条件类型支持
- `mtra-auto-focus-amount`: `MTRA`: 打开缓冲区时自动聚焦金额输入框
- `mtra-transfer-on-enter`: `MTRA`: 按 Enter 触发转移并在成功时关闭缓冲区

### 修改

- `custom-item-sorting`: 记住最后选择的排序模式
- `nots-clean-notifications`: 添加"X 满足条件 Y"通知的缩短

## 25.1.28

### 新增

- `focus-buffers-on-click`: 点击任意位置聚焦缓冲区，而不仅仅是标题
- `item-icons`: 添加 HCB 图标
- `nots-notification-type-label`: 为 RELEASE_NOTES 通知类型添加标签

### 修复

- `XIT ACT`: 修复 MTRA 操作期间"缺少 UI 元素"错误
- `shipment-item-detail`: 修复缺失的目标标签

### 移除

- `mtra-sync-amount-slider`: 此功能现在已在 APEX 中原生实现
- `nots-ship-name`: 此功能现在已在 APEX 中原生实现

## 25.1.19

### 新增

- `XIT YAPT`: 打开 Yet Another PrUn Tool 网站
- `XIT HQUC`: 添加 HQ 等级 52

### 修改

- `XIT ACT`: 将组/操作类型选择器移动到编辑覆盖层内
- `XIT ACT`: 为一些必填字段添加验证
- `XIT ACT`: 自动将物料代码转换为大写
- `XIT CALC`: 更改配色方案以匹配 APEX
- `XIT CALC`: 以极简模式显示

### 移除

- `productivity-through-depression`: 灰色利润数字已取消，因为即使 Castillo-Ito 也认为它们太暗淡了，这说明了一些问题

## 25.1.7

### 新增

- `XIT DEV`: 添加 pu-debug 开关
- `XIT SET`: 添加带有自定义缓冲区大小配置的"缓冲区"选项卡
- `auto-resize-buffers`: 命令更改时自动调整缓冲区大小
- `productivity-through-depression`: Promitor 的最佳作品

### 修改

- `XIT CONTC`: 添加上下文按钮
- `XIT CONTC`: 在支付条件中最多显示 2 位小数
- `XIT CONTS`: 添加上下文按钮
- `XIT CONTS`: 缩短列名

### 修复

- `XIT CONTS`: 修复待处理条件状态检测
- `custom-item-sorting`: 修复初始库存打开时的排序偏移
- `sfc-flight-eta`: 修复多个 `SFC` 面板打开时的预计时间冲突
- 修复缓冲区的默认大小以匹配原始大小

### 移除

- `hide-bfrs-button`: molp 发布与 BFRS 相关的更改后，现在可以安全地禁用底部栏

## 25.1.5

### 新增

- `XIT CMDL`: 命令列表（从 PMMG 移植的 `XIT LIST`）
- `hide-ctx-name`: 隐藏当前上下文名称标签 (CTX)

### 修改

- `XIT BURN`: 使用短库存 ID 打开 `INV`
- `XIT CONTS`: 添加更多条件状态颜色
- `XIT SET PMMG`: 添加 pmmg-lists.json 导入支持
- `lm-clean-ads`: 在运输广告中用箭头替换 from/to
- `lm-clean-ads`: 在运输广告中显示当前位置
- `mtra-sync-amount-slider`: 防止在面板加载时设置金额值

### 修复

- `XIT SORT`: 修复物料类别编号
- `XIT TODO`: 修复截止日期时区偏移
- `custom-item-sorting`: 修复排序顺序偏移
- `lm-clean-ads`: 修复非英语本地化中的分数截断
- 优化整体 CPU 和内存使用

## 24.12.18.2202

### 修复

- 修复从旧版本更新时 Firefox 中的页面重新加载问题

## 24.12.18

### 新增

- `mtra-sync-amount-slider`: `MTRA`: 将"金额"滑块与输入字段同步
- `nots-ship-arrival-inventory`: `NOTS`: 点击"飞船到达"通知时打开飞船库存

### 修改

- `XIT BURN`: 添加全部展开/折叠按钮
- `XIT FIN`: 澄清速动资产/负债工具提示
- `screen-tab-bar`: 将"隐藏"/"显示"按钮的样式更改为看起来像"复制"按钮
- 更改 Refined PrUn 集成到 APEX 的方式，减少 CPU 使用

### 修复

- `XIT BURN`: 修复"绿色"过滤器关闭时 inf 值被过滤掉的问题
- `XIT BURN`: 修复 Firefox 上表格边框消失的问题
- `nots-clean-notifications`: 修复"组件渲染失败"错误
- `screen-tab-bar`: 修复标签重新排序动画
- 修复某些地方 MM 物料价格不等于 MM 买入价格的问题
- 修复尝试打开无效命令（如 `CO undefined`）时新缓冲区无法打开的问题
- 优化 `bs-satisfaction-percentage`、`bs-merge-area-stats` 和 `shipping-per-unit-price` 的 CPU 使用
- 优化 Refined PrUn 启动时间

## 24.12.12

### 新增

- `co-base-count`: `CO`: 在"基地"标签中显示基地数量
- `prevent-delete-button-misclicks`: 使聊天中的"删除"按钮仅在按住 shift 时生效
- `XIT CONTS` 和 `XIT CONTC` 中的 REPAIR_SHIP 条件支持

### 修改

- `XIT ACT`: 移除"陈旧数据"错误
- `XIT REP`: 在行星链接中使用自然 ID 而非名称
- `search-auto-focus`: 在停靠面板中禁用

### 修复

- `XIT ACT`: 修复操作无法购买所需全部物料的问题
- `table-rows-alternating-colors`: 优化渲染性能
- 解析面板命令时修剪空格

## 24.11.29.2317

### 新增

- `search-auto-focus`: 在 PLI 和 SYSI 中自动聚焦搜索栏

### 修改

- `XIT BURN`: 在消耗列中为负值显示减号
- `XIT CXTS`: 将时间显示更改为 hh:mm

### 修复

- `XIT ACT`: 如果导入的包名称相同，则替换现有包（这次是真的）

## 24.11.29

### 新增

- `XIT CONTS`: 合作伙伴可以接受的合同图标
- `XIT HELP`: PMMG 设置导入条目
- `XIT HQUC`: 等级 51
- `XIT NOTE`: 如果未找到注释则显示"创建"按钮
- `XIT TODO`: 如果未找到任务列表则显示"创建"按钮
- `XIT REP`: `BRA` 上下文按钮

### 修改

- `XIT ACT`: 如果导入的包名称相同，则替换现有包
- `XIT CXTS`: 在总计列中将数字四舍五入为整数
- `XIT REP`: 在单目标 `XIT REP` 中隐藏目标列
- `screen-tab-bar`: 使标签可重新排序并在屏幕列表中添加隐藏/显示按钮
- `header-calculator-button`: 顶部边距增加 1px
- 将 `FLT` 相关功能应用于 `FLTP` 和 `FLTS`

### 修复

- `XIT ACT`: 修复执行时手动物料组被覆盖的问题
- `XIT ACT`: 修复行星的"来源库存未找到"错误
- `XIT CHAT`: 修复用户名溢出
- `XIT NOTE`: 修复包含物料代码的注释无法渲染的问题
- `inv-search`: 修复搜索栏样式
- 修复面板移动时 `XIT` 命令中上下文控件重复的问题

## 24.11.25

### 新命令

- `XIT CONTC`: 待处理合同条件
- `XIT CXTS`: 商品交易所交易
- `XIT FINBS`: 资产负债表
- `XIT GIF`: 随机 GIF（主要原因是 `XIT GIF CORGI`）
- `XIT HQUC`: HQ 升级计算器
- `XIT MATS`: 物料列表
- `XIT WEB`: 打开任何网页（专业提示！试试 `XIT WEB https://www.youtube.com/embed/dQw4w9WgXcQ`）

### 新增

- `BS`: 建筑列表摘要。
- `FINLA`: 新增流动资产列 - CX/FX 存款和 MM 物料。
- `FLT`: 飞船状态标签。
- `INV`: 自定义排序模式的反向排序。
- `LM`: 商品和运输图标。
- `XIT BURN`: 新的上下文按钮列：行星的 `BS` 和 `INV`，物料的 `CXM`。
- `XIT CONTS`: 玩家可以接受的合同中的收件箱图标。
- `XIT CONTS`: 带运输条件的合同中的 SHPT 图标。
- `XIT FINCH`: 使用 SMA 平滑权益历史图表。
- `XIT FINPR`: 新列 - 维修和利润率（利润/收入）。
- `XIT SET`: 货币符号自定义。
- `XIT REP`: 物料表中的新列 - 重量、体积和成本。
- SHPT 和 BLCK 物品的目标标签。
- 命令中物料代码的自动大写：`CXM`、`CXOB`、`CXP`、`CXPC`、`CXPO`、`MAT`。
  例如：`CXPO h2o.ai1` 按 Enter 后将变为 `CXPO H2O.AI1`。
- 系统命令 (`FLTS`、`INF`、`MS` 和 `SYSI`) 的系统名称替换。
- 飞船命令 (`SFC`、`SHP`、`SHPF`、`SHPI` 和 `SI`) 的飞船名称替换。
- 支持非英语本地化。

### 修改

- `CONTD`: 合作伙伴搜索结果显示在搜索栏上方。
- `FINLA`: 隐藏 ECD 行。
- `LM`: 广告更紧凑。
- `LM`: 隐藏评级图标。
- `LM`: BUYING/SELLING 广告以绿色/红色高亮显示。
- `LM`: 自己的订单高亮显示（如 `CXOB` 中的自己订单）。
- `INV`: 更改 BRN 排序以优先输出而非输入/消耗品，输入优先于消耗品。
- `INV`: 增强消耗品、预制件和 SHPT 物品的 CAT 物料排序。
- `MAT`: 物料类别可点击并使用物料类别打开 `XIT MATS`。
- `XIT BURN`: 无需 `ALL` 参数即可工作。
- `XIT BURN`: 行更密集。
- `XIT BURN`: 更改为按剩余天数排序（升序）。
- `XIT BURN`: "额外天数"设置更改为"补给"，表示补给的总天数。
- `XIT CALC`: 更改为 <https://desmos.com/scientific。>
- `XIT CHECK`: 更改为 `XIT TODO`。
- `XIT CONTS`: 反向排序，最新合同位于列表顶部。
- `XIT FIN_CHARTS`: 更改为 `XIT FINCH`。
- `XIT FINCH`: 权益历史图表每天只显示最新的点。
- `XIT FIN_PRODUCTION`: 更改为 `XIT FINPR`。
- `XIT FIN_SET`: 更改为 `XIT SET FIN`。
- `XIT FIN_SUMMARY`: 更改为 `XIT FIN`。
- `XIT FIN`: 更改关键指标。查看工具提示了解更多信息。
- `XIT SHEETS`: 以极简模式显示 Google Sheets。
- 点击 APEX 徽标打开玩家公司信息。
- 价格通过所有交易所的 VWAP 公式计算，使权益价值更稳定。
- 权益包括飞船、HQ 升级和 APEX 代表中心。添加新的"清算价值"指标来表示旧权益指标。
- 已阻止/已运输的物料包含在资产中。
- "提取运输"合同条件中的物料包含在资产中。
- 派系合同中的物料请求包含在负债中。
- 派系合同中的物料奖励包含在资产中。
- 尚未开始的船坞项目中的物料包含在资产中。
- 建筑物料在计入总资产价值时逐渐折旧。
- 生产订单中的输入/输出物料和费用包含在资产中。
- 债务利息仅在当前期间到期（截止日期 <7d）时才计入负债。
- 左侧边栏上的 `CONT` 按钮在有待接受的合同时会脉动。
- 物料数量标签的字体大小增加 1px。
- 支持数学的输入字段不需要开头的 '=' 符号。
- 支持数学的输入字段在聚焦时显示数学图标。
- 支持数学的输入字段除 Enter 外还在 Tab 键按下时计算公式。
- 所有 XIT 命令支持参数之间的空格。
- 聊天中隐藏"用户删除此消息"消息。
- 更多行星命令（如 `INV`）支持行星名称。
- 面板控件始终可见。
- 表格行在奇数行和偶数行之间交替颜色。
- 在不执行任何操作的单面板窗口上隐藏关闭按钮。
- 将图表库更改为 Chart.js，支持 Firefox。
- 命名系统中的未命名行星按原始 PrUn 方式显示（系统名称 + 字母）。

### 修复

- `NOTS`: 修复通知类型标签存在时的文本换行。
- 修复数学评估后的浮点数舍入。

### 移除

- 定价方案选择。
- 旧的 `XIT FIN` 登陆页面，改用上下文按钮。
- XIT 缓冲区的刷新按钮。
- `XIT INV`
- `XIT LIST`
