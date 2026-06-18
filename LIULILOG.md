# 更新日志

**插件版本**: 26.6.18  
**日期**: 2026-06-18  
**说明**: 重构加油动作，优化资源统计逻辑

## 26.6.18

### 新增

- `deep-to-raw`: 增强 Vue 响应式对象转原始对象工具函数，支持 `isRef`/`isReactive`/`isProxy` 检测、`null`/`Date` 处理及循环引用保护

### 修改

- `XIT ACT Refuel`: 重构加油动作逻辑，提取通用处理函数，消除 SF/FF 重复代码
- `XIT ACT`: 优化资源统计，按物料标识聚合重量/体积，避免重复累加
- `XIT ACT`: 抽取关闭窗口通用方法 `closeWindow`，消除重复代码
- 更新项目所有尺寸的应用图标

### 修复

- `XIT ACT`: 调整预加载价格数据的执行时机
- `XIT ACT`: 移除 `act-registry` 中不必要的非空断言，修复空值校验，跳过无有效步骤信息的执行项

## 1.8.7

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

## 1.8.6

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