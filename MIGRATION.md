# refined-prun → RUNCN（琉璃）迁移文档

> 版本：26.6.18 ｜ 分支：`feat/migrate-rp-p0` ｜ 目标仓库：https://github.com/CMDRKilmer/RUNCN

## 1. 概述

本仓库（RUNCN，别名「琉璃」）以 [refined-prun-oog](https://github.com/refined-prun/refined-prun-oog)（简称 **RP**）为源项目，逐步迁移其全部功能与架构，并在此之上加入 RUNCN 自有功能（中文本地化、聊天翻译、暗色模式等）。

迁移分为两大块，按功能定位区分：

| 分类 | 目录 | 定位 |
| --- | --- | --- |
| **Basic（基础功能）** | `src/features/basic` + `src/features/advanced` | 针对游戏 UI 的增强、修正与个性化，开机即用，无命令入口 |
| **Pro（专业命令 / XIT）** | `src/features/XIT` | 通过输入框命令调用的专业工具（烧炉规划、财务、物流、脚本执行等） |

## 2. Basic（基础功能）

### 2.1 features/basic（143 项，已迁移并保留全部，另有 15 项 RUNCN 自有扩展）

RP 的 `features/basic` 下 UI 增强功能全部迁移完毕，按类别列举：

- **界面布局与样式**：custom-left-sidebar、screen-tab-bar、close-all-buffers、auto-resize-buffers、focus-buffers-on-click、tile-controls-background、table-rows-alternating-colors、screen-layout-lock、hide-inactive-close-button、expand-sidebar-contract-list、header-calculator-button、header-duplicate-button、header-hide-controls-button、prevent-delete-button-misclicks、clickable-apex-logo、browser-tab-name、macos-antialiased-font、item-ticker-shadow
- **物品/库存**：inv-custom-item-sorting、inv-item-markers、inv-search、inv-compress-inventory-info、inv-show-space-remaining、inv-warehouse-button、lm-item-icons、item-icons、better-item-colors、bigger-item-count-font、blck-item-destination、shpi-base-inv-button、shpi-warehouse-button、funny-materials
- **交易所/市场**：cxpo-order-book、cxpo-auto-price、cxpo-bigger-buttons、cxob-supply-demand-values、cxob-center-on-open、cxob-delete-own-exchange-orders、cx-price-deviation、cx-search-bar、cxpc-chart-types、fxpo-better-current-price、fxpo-maximum-lot-size、highlight-own-exchange-orders、shipping-per-unit-price、mat-refined-prun-price、mat-linkify-category、lm-colored-buy-sell、lm-highlight-own-ads
- **舰队/生产**：flt-ship-condition、flt-arrival-eta、flt-quick-refuel、flt-flex-fuel、shpf-quick-refuel、sfc-flight-eta、prod-order-eta、prodq-queue-load、prodq-order-eta、prodco-order-eta、prod-burn-link、highlight-production-order-error、bui-sort-recipes、exp-expert-eta、lead-per-day-column
- **系统消息/翻译**：nots-desktop-notifications、nots-material-ticker、nots-notification-type-label、nots-ship-arrival-inventory、chat-translation（RUNCN 自有）、chat-images、align-chat-delete-button、other-context-notification-count、contribution-bulk-controls、contribution-maxed、cont-fulfill-next
- **杂项修正**：prun-bugs、correct-commands、input-math、dark-mode（RUNCN 自有）、parse-safe-image（RUNCN 自有）、zh-locale（RUNCN 中文本地化）、usr-subscription-level、adm-hide-inactive-buttons、adm-neutral-withdraw-button、audio-volume-slider、co-base-count、bbc-building-count、bbl-condition-progress-bar、bbl-dangerous-demolish、bbl-dangerous-repair、bbl-sticky-dividers、bs-building-list、bs-merge-area-stats、bs-satisfaction-percentage、bs-warehouse-button、cont-confirm-all、contd-auto-fill、contd-condition-address-placeholder、contd-upward-search-results、cmds-clickable-commands、hq-upgrade-bulk-controls、mtra-auto-focus-amount、mtra-transfer-on-enter、mu-fix-sector-names、prodq-hide-government-links、search-auto-focus、sysi-blue-negative-value、bra-generate-repair-act、shp-generate-repair-act

**RUNCN 自有（RP 无）**：chat-translation、dark-mode、nots-desktop-notifications、flt-quick-refuel、shpf-quick-refuel、bra-generate-repair-act、shp-generate-repair-act、close-all-buffers、cont-confirm-all、contd-auto-fill、contribution-maxed、cx-price-deviation、adm-hide-inactive-buttons、hq-upgrade-bulk-controls、parse-safe-image

### 2.2 features/advanced（49 项，已迁移；另有 2 项自有扩展）

- **界面精简**：always-visible-tile-controls、minimize-headers、context-controls-no-hover、hide-ctx-name、hide-form-errors、hide-item-names、hide-weight-volume-labels、bbl-clean-repair-info、bbl-collapsible-categories、bbl-hide-book-value、bs-hide-zero-workforce、cogcpex-clean-labels、cxob-depth-bars、cxob-hide-section-headers、cxos-hide-delete-filled、cxos-hide-exchange、cxpo-shorten-fields、finla-hide-ecd、flt-hide-transponder、flt-shorten-addresses、flt-shorten-cargo-capacity、inv-shorten-addresses、inv-shorten-storage-types、lm-clean-ads、lm-hide-rating、mat-clean-info、nots-clean-notifications、prod-hide-percent、prodq-shorten-material-links、sfc-auto-close、shorten-shpt-blck-address、shpf-hide-sort-options、sidebar-hide-zero-currencies
- **舰队/生产过滤**：wf-workforce-filters、hide-system-chat-messages、flt-flight-status-icons、flt-flex-fuel
- **RUNCN 自有（RP 无）**：flt-hide-cargo-fuel-buttons、pli-cogc-label

### 2.3 未迁移的 RP Basic 功能（有意跳过或待后续）

以下 RP 功能未在 RUNCN 中找到对应实现（部分为命名差异，已在 RUNCN 以不同名称实现）：

- `contd-paste-import`、`contd-bulk-add-commodity`、`contd-fill-all-button`（合同填充辅助）
- `cxm-reorder`、`inv-analysis-button`
- `oog-burn-inflight-inventory`、`oog-cxpo-quick-price`、`oog-repair-button`（OOG 相关）
- `pli-warehouse-open-button`、`popi-details-companion-buffer`
- `sfc-exchange-destinations`、`sfc-flight-cost`
- `market-contextmenu`（advanced）

> 备注：`cogcu-contribution-maxed` → RUNCN 以 `contribution-maxed` 实现；`pli-cogc-label` 在 RUNCN 中位于 advanced 目录。

## 3. Pro（features/XIT 专业命令）

全部 XIT 命令已迁移完毕并在 `src/features/XIT/index.ts` 注册，与 RP 命令集对齐（60+ 注册项）：

| 类别 | 命令 |
| --- | --- |
| 资产/库存 | INV、STO、NOBUY、LINKEDBUFFERS、BS、BPC、BURN（+BURN_GEN） |
| 财务/合同 | FIN（+FINPR）、FINBS、FINCH、CONTC、CONTS、CONTSS、CONTFF、CONTGEN、LOAN |
| 物流/舰队 | HAUL、PLANETS、FLT（FLEET）、DISPATCH（+DISPATCHACT）、REFUELACT、WFOR |
| 燃烧/维护 | GOVBURN（+GOVBURNACT / GOVBURNDATA / GOVBURNEXEC / govburn-data-capture）、REP（+REPAIRACT）、REPP、BURN |
| 交易所 | CXOS、CXTS、FX、FXTS |
| 数据/脚本 | DATA、ACT（动作系统）、AGENT、CMDL、CMDS、TODO、WEB、GIF、NOTE |
| 其他 | ARB、CART、CHAT、DEV、ELEC、EXP、HEALTH、HELP、HQUC、JH、MATS、ORG、PLAN、PROD、PWARN、SET、START、CALC |

> 各命令均为独立目录 `src/features/XIT/<CMD>/`，通过 `xit.add({ command, name, description, component, ... })` 注册。

## 4. 迁移适配要点（技术差异）

RP 与 RUNCN 虽同源，但 RUNCN 历经二次开发，存在以下必须适配的差异：

| 差异点 | RP 写法 | RUNCN 适配 |
| --- | --- | --- |
| **Store API** | 商店借用 `passiveAll` / `fetched` / `nativeWebSocket` 等 | 改用 `state.all` / `state.fetched`；`game-sources` 相关文件无法直接复制，以 stub / 占位实现（如 `data-catalog`、`agent-query`） |
| **xit registry 签名** | `description` 用 `() => getI18nValue(...)` 函数式 | RUNCN 要求**同步 string**，迁移时改为 `getI18nValue('RP.XIT.XXX.name', 默认值)` |
| **unimport 自动导入** | vite 配置自动导入 `sumBy` 等工具 | 需同步到 RUNCN 的 `vite.config.mts`（`imports` 列表）与 `src/types/unimport.d.ts`（全局类型声明），缺失会导致运行时 `xxx is not defined` |
| **UserData 类型** | 每模块类型定义在 `user-data.types.d.ts` | RUNCN 需为每个新 XIT 模块补充命名空间类型与默认值；GOVBURN 的 `govburn` / `govburnConfig` 为**顶层字段**（不在 settings 内） |
| **依赖预扩展** | — | 迁移前先为 RUNCN 的 `burn` / `buildings` 等模块补齐 RP 独有的导出函数（`computeNeed`、`getRepairThreshold` 等），避免连锁编译失败 |
| **工具函数** | 部分依赖 `ts-extras`（如 `sumBy`） | RUNCN 无 `ts-extras`，迁移为 `@src/utils/sum-by` 并显式/自动导入 |

## 5. 构建与验证

```bash
pnpm run compile   # tsc --noEmit（注意：普通 tsc 不检查 .vue 文件）
pnpm run lint      # eslint
pnpm run build     # clean + compile + vite build ×2 + fix-innerHTML
```

- `tsc` 对缺失导入是惰性的，**必须 `build`** 才能捕获 rollup 的 `ENOENT` / `is not exported` 等错误
- `.vue` 文件类型错误需通过 IDE（Volar）或 `vue-tsc` 检查
- 运行时错误需在浏览器控制台验证（如 `sumBy is not defined` 这类 unimport 注入问题）

## 6. 提交记录摘要（迁移过程）

| 提交 | 内容 |
| --- | --- |
| `854c89ca` | P3.5 XIT/DATA 数据浏览器 |
| `c9935451` | P4.2 ACT 动作系统扩展 |
| `5995ebeb` | P3.2 + P3.3 XIT/GOVBURN 政府燃烧规划器 + XIT/DISPATCH 舰队补给修复规划器 |
| `ba77eb09` | P3.4 XIT/AGENT 代理频道包列表，升级 MTRA 双阶段补给 |
| `dda74659` | XIT/FLT 舰队视图 + REFUELACT，补齐 `displaytimeBetween` |
| `3ee630e7` | XIT/BURNACT + XIT/REPAIRACT 行星补给/维修执行 |
| `0b78dce1` | 补全 unimport 自动导入配置（修复运行时 `sumBy is not defined`） |
| `ef2a6d60` | 补全 `LinkedBuffersPreset` 类型与 `LinkedBuffersChildLayout` 接口 |

> P0–P4 其余计划项（STO、PLANETS、LINKEDBUFFERS、NOBUY、INV、BS、core 工具、数据源、agent-channel、SET/FINMERGE、通用 UI 组件等）在更早的提交中完成。
