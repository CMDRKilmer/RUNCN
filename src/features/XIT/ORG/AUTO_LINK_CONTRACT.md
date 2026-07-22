# 自动关联合同方案设计

> 记录日期：2026-07-22
> 状态：**待选型 / 方案探索**

## 背景

ORG 当前任务生命周期的"接取 → 合同关联"环节仍依赖用户手动操作：

1. 接取者在 CONTGEN 面板里创建合同
2. 接取者回到 ORG TaskDetail，点击"上报合同 ID"
3. 任务状态由 `AWAITING_CONTRACT` → `IN_PROGRESS`

这个手动步骤影响接取效率，且容易出错（合同 ID 复制粘贴失误）。

## 现状梳理

### 已有的能力

| 能力 | 实现位置 |
|---|---|
| 手动关联合同 | [routes/tasks.ts:118-133](file:///c:/Users/kilsa/Desktop/code/%E7%90%BC%E7%92%83/rprun-org-worker/rprun-org-worker/src/routes/tasks.ts#L118-L133) `POST /tasks/:id/link-contract` |
| 合同状态→任务状态反向同步 | [services/contract-sync-service.ts:20-62](file:///c:/Users/kilsa/Desktop/code/%E7%90%BC%E7%92%83/rprun-org-worker/rprun-org-worker/src/services/contract-sync-service.ts#L20-L62) `syncTaskFromContract` |
| 前端监听合同状态变化自动上报 | [infrastructure/org-api/contract-link.ts:23-50](file:///c:/Users/kilsa/Desktop/code/%E7%90%BC%E7%92%83/RUNCN/src/infrastructure/org-api/contract-link.ts#L23-L50) `watchContractStatus` |

### 缺失的能力

任务接取后到合同创建、关联这段 **无任何自动机制**。

---

## 三种候选方案

### 方案 A：发布者预生成合同 ID（创建即分配）

**思路**：任务发布时由后端生成一个预留的合同 ID（UUID）存入任务；接取者在 CONTGEN 看到任务列表后，选择"为任务 X 创建合同"，CONTGEN 把这个合同 ID 作为 ID 写入 CONTD。

**优点**
- 100% 准确，不会关联错合同
- 无需扫表
- 接取者体验自然（CONTGEN 现有 UI 改造小）

**缺点**
- 改了任务模型（增加 `reserved_contract_id` 字段）
- 接取者必须通过专门的入口创建，不能直接复制合同 JSON
- 单任务-单合同关系硬绑定，不支持一个合同关联多个任务

**实现成本**：中。需要前后端配合修改。

---

### 方案 B：指纹匹配（创建合同时自动识别）

**思路**：接取者在 CONTGEN 创建合同时，把合同 JSON 中的关键字段（任务类型、物品清单、currency、location/origin/destination、价格）作为指纹上报给后端；后端扫描处于 `AWAITING_CONTRACT` 的任务，匹配指纹最高者，自动 `link-contract`。

**优点**
- 零迁移，接取者无感
- CONTGEN 端只增加一行"指纹上报"
- 兼容多合同-多任务场景

**缺点**
- 匹配规则难定（价格波动、过期时间不同怎么办？）
- 误关联风险（两人发布的相似任务可能被错配）
- 需要前后端约定指纹权重

**实现成本**：中。需要定义匹配算法 + 误关联兜底。

---

### 方案 C：前端轮询反查（PrUn 合同 store 检测）

**思路**：CONTGEN/CONTD 创建合同时，PrUn 自带的合同 ID 是唯一的。Worker 后端定期（cron）扫描 contractsStore（PrUn 客户端的全局 store），找出"最近 5 分钟内由本组织创建、且合同 JSON 与任务 contractJson 匹配的合同"，自动 `link-contract`。

**实际可行的版本**：后端 Worker 访问不到客户端 contractsStore，所以改为 **前端轮询时主动检测**：前端轮询 contractsStore，发现新合同且 JSON 与 `task.contractJson` 关键字段匹配，则自动调 `link-contract`。

**优点**
- 利用现有 contractsStore，零用户操作
- 时窗短（5 分钟）误关联概率低
- 无需改任务模型
- 后端零改动

**缺点**
- 依赖前端扩展运行（卸载/关闭会停）
- 误关联仍可能（指纹规则需谨慎）

**实现成本**：低（前端层面）。后端无需改动。

---

## 推荐组合：方案 B + C

具体做法：

1. **接取者触发**：在 TaskDetail.vue 的"创建合同（CONTGEN → CONTD）"按钮旁新增"🤖 开启自动关联"按钮（一次点击）
2. **前端轮询**：开启后启动 30 秒轮询：检查 `contractsStore.all` 中是否有新合同，其 JSON 与 `task.contractJson` 关键字段匹配
3. **自动关联**：匹配上后自动调 `link-contract`，弹 toast 提示"已自动关联合同 XXX"
4. **保留手动**：原"上报合同 ID"按钮保留，自动关联失败/误判时仍可手动操作

### 指纹匹配规则（建议）

合同 JSON 必须**全部**满足以下条件才视为匹配：

| 字段 | 匹配方式 |
|---|---|
| `template` | 严格相等（已考虑反转规则：BUY↔SELL） |
| `currency` | 严格相等 |
| `items[].commodity` | 全等集合（不考虑顺序） |
| `items[].amount` | 对应物料的 amount 严格相等 |
| `items[].price` | 对应物料的 price 严格相等（允许 ±0.5% 误差） |
| `location` / `origin`+`destination` | 严格相等 |

**任一字段不匹配 → 不关联**（宁缺毋滥）。

### 误关联兜底

- 匹配成功后**不直接调 link-contract**，而是先弹确认 toast："检测到合同 XXX 与本任务匹配，是否关联？"（5 秒倒计时）
- 用户点取消则不关联
- 5 秒倒计时结束自动关联

### 状态机兼容

自动关联等价于手动关联，状态机走 `AWAITING_CONTRACT → IN_PROGRESS`（CLOSED 触发），后续走 [`syncTaskFromContract`](file:///c:/Users/kilsa/Desktop/code/%E7%90%BC%E7%92%83/rprun-org-worker/rprun-org-worker/src/services/contract-sync-service.ts#L20-L62) 已有的反向同步逻辑。

---

## 实现 TODO

> 实际编码时再拆分。

- [x] 前端 `contract-link.ts` 增加 `matchContractJson(contractJson, taskContractJson)` 指纹比对函数
- [x] 新建 `auto-link.ts` 暴露 `startAutoLink(task)` / `stopAutoLink(taskId)` / `isAutoLinkRunning(taskId)`，30s 轮询 + dismissedContractIds 去重
- [x] TaskDetail.vue 增加"开启/关闭自动关联"按钮 + 5s 倒计时确认弹窗（contractId + fingerprintSummary 展示）+ onBeforeUnmount 自动清理
- [x] 关联成功/失败的 toast 提示（成功走 `emit('updated', updated)` 由父级统一 toast；失败走 `error.value` 内嵌面板 + onError 回调）
- [x] 后端可选：增加 `POST /tasks/:id/match-contract` 端点，让前端上报合同 JSON、后端做权威匹配（避免不同客户端的指纹规则不一致）

### 已落地清单

**前端（2026-01）**

| 文件 | 内容 |
|---|---|
| `infrastructure/org-api/contract-link.ts` | `ContractFingerprint` 投影、`contractToFingerprint`、`taskJsonToFingerprint`、`conditionsToTemplate`/`conditionsToItems`/`addressToLocation`、`priceEquals`、`itemsEqual`、`matchContractJson` |
| `infrastructure/org-api/auto-link.ts` (新) | `startAutoLink`/`stopAutoLink`/`isAutoLinkRunning`，单 task 单会话，30s 轮询，命中返回 `Promise<boolean>` 等待 UI 确认。命中前先调后端 `matchContract` 端点做权威比对，失败直接 dismiss 不弹窗。 |
| `infrastructure/org-api/tasks.ts` | 新增 `matchContract(taskId, { contractId, fingerprint, autoLink? })` API 客户端。 |
| `features/XIT/ORG/TaskDetail.vue` | "🤖 开启/关闭自动关联"按钮、5s 倒计时 overlay 确认弹窗、`onBeforeUnmount` 自动 stopAutoLink |

**后端（2026-07 commit `23c6ca8`）**

| 文件 | 内容 |
|---|---|
| `rprun-org-worker/src/utils/contract-match.ts` (新) | `matchContractFingerprint`/`effectiveTemplate`，与前端 ContractFingerprint 形状等价，独立实现 |
| `rprun-org-worker/src/utils/validation.ts` | 新增 `matchContractSchema` |
| `rprun-org-worker/src/services/match-contract-service.ts` (新) | `matchContract` 服务层；按 `autoLink` 选择直接调 `linkContract` 或仅返回比对结果；写审计日志 |
| `rprun-org-worker/src/routes/tasks.ts` | 新增 `POST /tasks/:id/match-contract` 路由 |
| `rprun-org-worker/tests/contract-match.test.ts` (新) | 21 个单测覆盖反转规则 / 价格容差 / items 集合等 / 缺字段 / SHIP 例外 |

### 已知简化点

* 价格容差硬编码 0.5% (`PRICE_TOLERANCE`)，前后端两端硬编码，未来可抽取到常量配置允许覆盖。
* 前端 `contractToFingerprint` 与后端 `taskJsonToFingerprint` 实现独立，规则变更必须同步两端（已在两处文件头注释注明）。
* 项目前置 `tests/integration.test.ts` 套件因 vitest-pool-workers v0.13+ D1 exec 行为变化整体失败（与本次改动无关，单独 PR 修复）。

---

## 决策记录

| 决策 | 选定方案 |
|---|---|
| 默认方案 | **方案 C**（前端轮询反查）—— 改动最小 |
| 增强方案 | **方案 B**（指纹匹配 + 后端权威匹配）—— 适合大规模部署 |
| 排除方案 | **方案 A**（预生成 ID）—— 需要改任务模型，迁移成本高 |