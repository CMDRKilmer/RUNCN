# 更新日志

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
