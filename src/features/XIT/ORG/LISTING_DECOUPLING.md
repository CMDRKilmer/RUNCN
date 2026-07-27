# 市场挂单与任务解耦方案

> 目标：把"市场挂单"从"任务"里拆出来。新挂单只挂一个商品；挂单被接取后才创建任务与关联合同。

## 1. 现状与问题

### 1.1 现有模型：挂单 = 任务

当前架构里，`PublishTask.vue` 发布挂单 → `POST /tasks` → 在 `tasks` 表里写一条 `status='PUBLISHED'` 的任务。`MarketView.vue` 用 `GET /tasks?scope=board` 把这些任务当作挂单展示。

"挂单"、"任务"、"合同载体"三位一体导致以下复杂度：

1. **多 item 拆解**：[createTask](file:///c:/Users/kilsa/Desktop/code/%E7%90%BC%E7%92%83/rprun-org-worker/rprun-org-worker/src/services/task-service.ts#L53-L115) 在发布时把多 item 任务拆成 N 条独立任务，专门为了让 partial claim 能套用（每条只有 1 个 item）。这增加了发布路径的代码复杂度。
2. **partial claim 父子任务**：[partialClaimTask](file:///c:/Users/kilsa/Desktop/code/%E7%90%BC%E7%92%83/rprun-org-worker/rprun-org-worker/src/db/repositories/tasks.repo.ts#L277-L369) 创建反向子任务 + 父任务缩 amount；[releasePartialClaimTask](file:///c:/Users/kilsa/Desktop/code/%E7%90%BC%E7%92%83/rprun-org-worker/rprun-org-worker/src/db/repositories/tasks.repo.ts#L402-L463) 删除子任务 + 加回父任务 amount。一来一回的同步逻辑渗入了 7 个函数（claim / release / cancel / delete / link / get / list）。
3. **合同创建方反转规则的二义性**：父任务 BUY → 子任务 SELL（contract_creator='publisher'），这一规则散落在 [partialClaimTask](file:///c:/Users/kilsa/Desktop/code/%E7%90%BC%E7%92%83/rprun-org-worker/rprun-org-worker/src/db/repositories/tasks.repo.ts#L319-L320) 内联三元、`invertTemplate` 工具函数、[match-contract-service](file:///c:/Users/kilsa/Desktop/code/%E7%90%BC%E7%92%83/rprun-org-worker/rprun-org-worker/src/services/match-contract-service.ts#L78-L95) 的"试 publisher 再试 claimer"等多个地方。
4. **market UI 摊平逻辑**：每个 BUY/SELL 任务可能有多个 item，MarketView 要 `task.contractJson.items.forEach(...)` 摊平，按 commodity 聚合。每次展示要重新做商品化映射。

### 1.2 业务诉求

- "卖 100 份 FE，买 30 份"依然要支持（partial claim）。
- 现有已发布的任务（tasks 表里的数据）必须平滑迁移。
- 合同自动关联链路不受影响。

## 2. 目标架构

### 2.1 数据模型

**新增 `listings` 表**（市场挂单，无合同、无状态机）：

```sql
CREATE TABLE listings (
  id                     TEXT PRIMARY KEY,
  type                   TEXT NOT NULL CHECK (type IN ('BUY','SELL','SHIP')),
  commodity              TEXT NOT NULL,
  amount                 INTEGER NOT NULL,        -- 发布总量
  remaining_amount       INTEGER NOT NULL,        -- 剩余可接取量
  price                  REAL NOT NULL,
  currency               TEXT NOT NULL,
  location               TEXT,                     -- BUY/SELL
  origin                 TEXT,                     -- SHIP
  destination            TEXT,                     -- SHIP
  publisher_id           TEXT NOT NULL REFERENCES users(id),
  publisher_username     TEXT NOT NULL,
  publisher_company_code TEXT NOT NULL,
  status                 TEXT NOT NULL DEFAULT 'OPEN'
                         CHECK (status IN ('OPEN','CLOSED','CANCELLED','EXPIRED')),
  expires_at             TEXT,
  created_at             TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at             TEXT NOT NULL DEFAULT (datetime('now'))
);
```

**`tasks` 表改造**：

| 列 | 操作 | 原因 |
|---|---|---|
| `parent_task_id` | DROP | 不再有父子任务 |
| `listing_id` | ADD（nullable） | 接取来源挂单；老任务为 NULL |
| `claim_seq` | ADD（nullable） | 同 listing 下接取序号 |
| `contract_json.items` | 不动（仍可为数组） | 解耦后单 item，迁移期老数据仍是数组 |
| 其他列 | 不动 | |

**新约定**：
- `tasks.contract_json.items.length === 1`（创建时硬校验；老任务保留兼容）。
- 接取者接走 `amount=N` → 创建 1 条新 task（`items.amount=N`）→ listing.remaining_amount -= N。
- 同一 listing 可被接取多次，产生多条独立 task，每条独立关联一份合同。

### 2.2 业务对象关系

```
listing (amount=100, remaining=70)
        │  接取 1：claim 30 → task_1 (amount=30) → contract_1 → COMPLETED
        │  接取 2：claim 40 → task_2 (amount=40) → contract_2 → COMPLETED
        └─  listing.remaining=0 → status='CLOSED'
```

每条 task 是独立实体，**不再有父子概念**。反向合同创建方规则仍然存在（接取者创建反向合同），但与父子任务无关——只是简单的"接取者创建反向合同"语义。

### 2.3 业务流程

#### 发布挂单

```
PublishTask.vue
  └─ POST /listings   { type, commodity, amount, price, ... }
     └─ 写 listings 表，status='OPEN'
```

#### 浏览市场

```
MarketView.vue
  └─ GET /listings?commodity=FE&type=BUY
     └─ 拉 listings 表（status='OPEN'）
```

前端无需做 items 摊平——listings 已是单商品实体。

#### 接单（关键路径）

```
TradeOverlay.vue
  └─ 输入 claimAmount（≤ listing.remaining_amount）
     └─ POST /listings/:id/claim  { amount }
        └─ 后端做（事务内）：
           1. 校验 listing.status='OPEN'、amount≤remaining
           2. 创建 task：
              - type 反转（listing BUY → task SELL；listing SELL → task BUY；SHIP 保持）
              - items = [{ commodity, amount, price }]
              - contract_creator = 'claimer'（接取者创建反向合同）
              - listing_id = listing.id
              - claim_seq = listing 已接取次数 + 1
              - status = 'AWAITING_CONTRACT'
           3. listing.remaining_amount -= amount
           4. listing.status = (remaining==0 ? 'CLOSED' : 'OPEN')
           5. 写 audit log
        └─ 返回 { task, listing }
     └─ 前端：notifyTaskClaimed → registerActiveTask → 启动 auto-link
     └─ 用户去 PrUn 创建反向合同
     └─ auto-link 命中 → link-contract → 任务 IN_PROGRESS
```

#### 合同自动关联（**不变**）

保持现有 [auto-link.ts](file:///c:/Users/kilsa/Desktop/code/%E7%90%BC%E7%92%83/RUNCN/src/infrastructure/org-api/auto-link.ts) + [match-contract-service](file:///c:/Users/kilsa/Desktop/code/%E7%90%BC%E7%92%83/rprun-org-worker/rprun-org-worker/src/services/match-contract-service.ts) + [contract-link.ts](file:///c:/Users/kilsa/Desktop/code/%E7%90%BC%E7%92%83/RUNCN/src/infrastructure/org-api/contract-link.ts) + [contract-match.ts](file:///c:/Users/kilsa/Desktop/code/%E7%90%BC%E7%92%83/rprun-org-worker/rprun-org-worker/src/utils/contract-match.ts) 链路。每个 task 独立关联一份合同。

## 3. 改动清单

### 3.1 后端

#### 数据库

| 文件 | 操作 |
|---|---|
| [006_listings.sql](file:///c:/Users/kilsa/Desktop/code/%E7%90%BC%E7%92%83/rprun-org-worker/rprun-org-worker/src/db/migrations/006_listings.sql) | 新建：listings 表 + 索引 + 触发器 |
| [007_tasks_listing_id.sql](file:///c:/Users/kilsa/Desktop/code/%E7%90%BC%E7%92%83/rprun-org-worker/rprun-org-worker/src/db/migrations/007_tasks_listing_id.sql) | 改 tasks 表：DROP parent_task_id，ADD listing_id/claim_seq |

#### 类型与映射

| 文件 | 操作 |
|---|---|
| [types.ts](file:///c:/Users/kilsa/Desktop/code/%E7%90%BC%E7%92%83/rprun-org-worker/rprun-org-worker/src/types.ts) | 新增 `ListingType`/`ListingStatus`/`OrgListing` |
| [mappers.ts](file:///c:/Users/kilsa/Desktop/code/%E7%90%BC%E7%92%83/rprun-org-worker/rprun-org-worker/src/db/mappers.ts) | 新增 `ListingRow` + `mapListing` |
| [tasks.repo.ts](file:///c:/Users/kilsa/Desktop/code/%E7%90%BC%E7%92%83/rprun-org-worker/rprun-org-worker/src/db/repositories/tasks.repo.ts) | 删 `parent_task_id` 字段；`OrgTask` 类型移除 `parentTaskId` |

#### 新增 listings 模块

| 文件 | 内容 |
|---|---|
| `db/repositories/listings.repo.ts` | create / find / listOpen / claimFromListing / cancelListing / nextClaimSeq |
| `services/listing-service.ts` | createListing / listListings / claimListing（事务：创建 task + 扣 remaining）/ cancelListing / findListingForUser |
| `routes/listings.ts` | POST /listings / GET /listings / POST /listings/:id/claim / POST /listings/:id/cancel / GET /listings/:id |
| `utils/validation.ts` | 新增 createListingSchema / listListingsQuerySchema / claimListingSchema |
| `index.ts` | 挂载 `/listings` 路由 |

#### 简化 tasks 模块

| 文件 | 改动 |
|---|---|
| `db/repositories/tasks.repo.ts` | 删 `partialClaimTask`、`releasePartialClaimTask`、`findEffectivePublisherId`；`listTasks` 的 published/claimed scope 改为只查 `publisher_id` / `claimer_id`（不再追溯 parent）；`createTasks` 拆解分支删除 → `createTask` |
| `services/task-service.ts` | `createTask` 校验 `contractJson.items.length === 1`（老任务编辑仍允许多 item）；`claimTask` 改为"从 listing 接取"（调用 listings service）；`releaseTask`、`cancelTask`、`linkContract`、`getTaskForUser`、`deleteTaskForPublisher` 删除所有 `parent_task_id` 分支 |
| `services/match-contract-service.ts` | 删除 `findEffectivePublisherId` 调用 |
| `services/contract-sync-service.ts` | 删除 `findEffectivePublisherId` 调用 |

#### 数据迁移

| 文件 | 操作 |
|---|---|
| `scripts/migrate-tasks-to-listings.sql` | 把 tasks 表里 status='PUBLISHED' 的任务按 `contractJson.items[0]` 提取出 listing 字段，写入 listings 表。**注意**：多 item 任务会拆成多条 listing。老 task 保留不动。 |

### 3.2 前端

#### 新增 listings 模块

| 文件 | 内容 |
|---|---|
| `infrastructure/org-api/listings.ts` | createListing / listListings / claimListing / cancelListing / getListing |
| `infrastructure/org-api/types.ts` | 同步后端：新增 `OrgListing` / `ListingType` / `ListingStatus` |

#### UI 改造

| 文件 | 改动 |
|---|---|
| `features/XIT/ORG/PublishTask.vue` | 改为打 `listings.createListing`；隐藏"添加物品"按钮（单 item）；单 item 校验 |
| `features/XIT/ORG/MarketView.vue` | 改为 `listings.listListings`；删除 items 摊平逻辑；按 listing 直接渲染 |
| `features/XIT/ORG/TradeOverlay.vue` | 改为 `listings.claimListing(listingId, amount)`；删除 partial claim 展示（不再有"反向子任务"概念） |
| `features/XIT/ORG/TaskDetail.vue` | 删除 `parentTaskId` 特判；保留 `listingId` 展示（点击跳到 listing 详情，如需要） |
| `features/XIT/ORG/TaskList.vue` | "我的发布" / "我的接取" Tab 保留：分别展示 listings（"我发布的挂单"）和 tasks（"我接取的任务"）；老 task 数据通过 `listings` 端点兼容读取 |

#### 不变

- `auto-link.ts` / `contract-link.ts` / `match-contract-service.ts` / `contract-match.ts` —— 合同自动关联链路不动（每个 task 仍是独立实体，关联流程不变）
- `LinkContract.vue` —— 手动关联 UI 保留

### 3.3 反转规则收敛

解耦后反转规则只剩**一个**使用场景：接取者创建反向合同时，把 `task.type` 反转成"待签合同类型"。

| 位置 | 现状 | 解耦后 |
|---|---|---|
| [RUNCN/utils.ts invertTemplate](file:///c:/Users/kilsa/Desktop/code/%E7%90%BC%E7%92%83/RUNCN/src/features/XIT/ORG/utils.ts#L9-L21) | 通用反转 | **保留**（前端用） |
| [RUNCN/auto-link.ts effectiveTaskTemplate](file:///c:/Users/kilsa/Desktop/code/%E7%90%BC%E7%92%83/RUNCN/src/infrastructure/org-api/auto-link.ts#L63-L70) | 扫描时尝试两个方向 | **保留**（指纹匹配需要） |
| [contract-match.ts effectiveTemplate](file:///c:/Users/killsa/Desktop/code/%E7%90%BC%E7%92%83/rprun-org-worker/rprun-org-worker/src/utils/contract-match.ts#L67-L74) | 后端权威匹配 | **保留** |
| `task-service.ts:319-320` 父子反转内联三元 | partial claim 专用 | **删除** |
| `task-service.ts:268 reverseContractCreator='publisher'` 内联 | partial claim 专用 | **删除** |
| [match-contract-service.ts "试 publisher 再试 claimer"](file:///c:/Users/killsa/Desktop/code/%E7%90%BC%E7%92%83/rprun-org-worker/rprun-org-worker/src/services/match-contract-service.ts#L78-L95) | 通用反转 | **保留** |

去掉了父子反转的所有特殊路径。

## 4. 迁移策略

### 4.1 双轨过渡（推荐）

**阶段 1：listings 表上线**
- 部署 migration 006 + 007
- 新挂单走 `/listings`；老挂单仍走 `/tasks?scope=board`
- 前端**只后端切换，前端不动**：MarketView 仍读 `/tasks` 拉老数据
- 跑 `scripts/migrate-tasks-to-listings.sql` 把老 PUBLISHED 任务迁移到 listings（老 task 不删除）
- 双轨期间：`listings` 端点拉新挂单，`tasks?scope=board` 拉老 task；前端 MarketView 合并两者展示

**阶段 2：前端切换到 listings**
- MarketView 改为读 `/listings`
- PublishTask 改为打 `/listings`
- TradeOverlay 改为打 `/listings/:id/claim`
- 老 `tasks` 端点的发布路径不再被前端调用

**阶段 3：清理**
- 删除 `task-service.ts` 的发布逻辑（`createTask` 改为内部工具函数，仅供 listings 服务的 claim 路径使用）
- 删除 `tasks.repo.ts` 的 `createTasks` 拆解路径
- 移除 tasks 表上的老 status='PUBLISHED' 数据（已全部迁移）

### 4.2 老任务数据兼容性

迁移脚本：

```sql
-- scripts/migrate-tasks-to-listings.sql
INSERT INTO listings (
  id, type, commodity, amount, remaining_amount, price, currency,
  location, origin, destination,
  publisher_id, publisher_username, publisher_company_code,
  expires_at, status, created_at, updated_at
)
SELECT
  -- 新 listing id：与 task id 区分（前缀 'l-' 避免与 task uuid 冲突）
  'l-' || id AS id,
  type,
  -- 多 item 任务：每个 item 一条 listing（拆解）
  item.value->>'$.commodity' AS commodity,
  CAST(item.value->>'$.amount' AS INTEGER) AS amount,
  CAST(item.value->>'$.amount' AS INTEGER) AS remaining_amount,
  CAST(item.value->>'$.price' AS REAL) AS price,
  contract_json->>'$.currency' AS currency,
  contract_json->>'$.location' AS location,
  contract_json->>'$.origin' AS origin,
  contract_json->>'$.destination' AS destination,
  publisher_id,
  publisher_username,
  publisher_company_code,
  expires_at,
  'OPEN' AS status,
  created_at,
  created_at AS updated_at
FROM tasks, json_each(json_extract(contract_json, '$.items')) AS item
WHERE status = 'PUBLISHED';
```

注：D1 不一定支持 `json_extract` 和 `json_each`——需先在 dev DB 上验证；如不支持，改用应用层循环导出。

### 4.3 回滚

- migration 006 是新建表，回滚：DROP TABLE listings。
- migration 007 是修改 tasks 表，DROP COLUMN / ADD COLUMN 都可逆。
- 数据迁移脚本是**追加**，不回写老 tasks 表——回滚只需 DROP 新增的 listings 行。
- 阶段 1 期间前端不动 → 完全可回滚到原状态。

## 5. 风险评估

### 5.1 高风险点

1. **D1 schema 变更**：DROP COLUMN 在早期 D1 不支持，需重建表。007 migration 用 `ALTER TABLE ... DROP COLUMN` 假设 D1 2025-08 后版本支持；如不支持，需改写为"建新表 + 数据迁移 + 重命名"。
2. **既有 task 的合同关联**：老 task 表里 `contract_id` 已关联的合同不动；前端 auto-link 仍可工作。但老的 partial claim 子任务（`parent_task_id` 非 NULL）需要额外处理——007 把这列删了，子任务的"父任务指针"丢失。
   - **应对**：阶段 1 部署前，先跑一个一次性脚本把"父任务指针"信息附加到子任务的 `contract_json.metadata.parent_task_id`（如果有这个列就跳过）；或把子任务的 contract_id 当作"反向合同"。
3. **D1 不支持 `json_extract` / `json_each`**：迁移脚本需验证；不通过则改用 Node 脚本读 SQLite 导出再写。

### 5.2 中风险点

1. **MarketView 双轨合并**：阶段 1 期间，老 task + 新 listing 都要展示。需要前端做"虚拟视图合并"——增加一层抽象。
2. **既有 audit log 引用 task id**：迁移不影响 audit_logs（保留原 task_id 引用），无需迁移。

### 5.3 低风险点

- listings 表结构简单
- 合同关联链路不动
- 状态机不变

## 6. 验收标准

- [ ] migration 006 / 007 在 dev DB 上跑通（无 schema 错误）
- [ ] 迁移脚本把老 PUBLISHED 任务正确导出到 listings
- [ ] `POST /listings` 创建挂单
- [ ] `GET /listings?commodity=FE` 拉挂单
- [ ] `POST /listings/:id/claim` 接单 → 扣 remaining + 创建 task
- [ ] 合同自动关联链路完整工作（auto-link 命中后 link-contract → task IN_PROGRESS）
- [ ] 任务状态机不变（AWAITING_CONTRACT → IN_PROGRESS → COMPLETED）
- [ ] MarketView 切换到 listings 后展示正确
- [ ] partial claim 业务（卖100接30）走新 listings 路径仍可工作
- [ ] 老 PUBLISHED task 数据完全迁移；前端双轨期间无重复挂单

## 7. 文件影响清单

### 7.1 后端修改/新增

| 文件 | 类型 | 说明 |
|---|---|---|
| `src/db/migrations/006_listings.sql` | 新增 | listings 表 |
| `src/db/migrations/007_tasks_listing_id.sql` | 新增 | tasks 表加 listing_id + claim_seq，drop parent_task_id |
| `src/types.ts` | 修改 | 新增 ListingType/ListingStatus/OrgListing |
| `src/db/mappers.ts` | 修改 | 新增 ListingRow/mapListing；TaskRow 删 parent_task_id |
| `src/db/repositories/listings.repo.ts` | 新增 | listings 仓库 |
| `src/services/listing-service.ts` | 新增 | listings 业务服务 |
| `src/routes/listings.ts` | 新增 | listings HTTP 路由 |
| `src/utils/validation.ts` | 修改 | 新增 listing schemas |
| `src/index.ts` | 修改 | 挂载 /listings 路由 |
| `src/db/repositories/tasks.repo.ts` | 修改 | 删 partialClaim/releasePartialClaim/findEffectivePublisher；listTasks 简化 |
| `src/services/task-service.ts` | 修改 | 删 partial claim 分支；createTask 单 item 校验；claimTask 改为 listings 路径调用 |
| `src/services/match-contract-service.ts` | 修改 | 删 findEffectivePublisherId |
| `src/services/contract-sync-service.ts` | 修改 | 删 findEffectivePublisherId |
| `scripts/migrate-tasks-to-listings.sql` | 新增 | 数据迁移脚本 |

### 7.2 前端修改/新增

| 文件 | 类型 | 说明 |
|---|---|---|
| `src/infrastructure/org-api/types.ts` | 修改 | 同步后端 Listing 类型 |
| `src/infrastructure/org-api/listings.ts` | 新增 | listings API 客户端 |
| `src/features/XIT/ORG/PublishTask.vue` | 修改 | 改打 listings 端点；单 item 校验 |
| `src/features/XIT/ORG/MarketView.vue` | 修改 | 改读 listings；删 items 摊平 |
| `src/features/XIT/ORG/TradeOverlay.vue` | 修改 | 改打 listings claim；删 partial claim 展示 |
| `src/features/XIT/ORG/TaskDetail.vue` | 修改 | 删 parentTaskId 特判 |
| `src/features/XIT/ORG/TaskList.vue` | 修改 | 区分 listings 与 tasks 的展示 |

### 7.3 不变文件

- `src/infrastructure/org-api/auto-link.ts`
- `src/infrastructure/org-api/contract-link.ts`
- `src/infrastructure/org-api/task-activity.ts`
- `src/infrastructure/org-api/polling.ts`
- `src/features/XIT/ORG/LinkContract.vue`
- `src/features/XIT/ORG/TaskCard.vue`
- 后端 `src/services/contract-sync-service.ts`（仅删 1 行 findEffectivePublisherId）
- 后端 `src/services/match-contract-service.ts`（仅删 1 行 findEffectivePublisherId）
- 后端 `src/utils/contract-match.ts`（不动）

## 8. 实施顺序（建议）

### 阶段 1：后端 listings 全栈（前端不动）

1. migration 006 listings 表
2. migration 007 tasks 表改造
3. types/mappers 加 Listing
4. listings.repo / listing-service / listings route
5. validation schemas
6. 路由挂载
7. dev 部署 + curl 验证
8. 跑迁移脚本

### 阶段 2：后端 tasks 简化（可选与阶段 1 并行）

1. 删 partialClaim/releasePartialClaim/findEffectivePublisher
2. createTask 单 item 校验
3. claimTask 内部走 listings service
4. match-contract / contract-sync 删除子任务追溯

### 阶段 3：前端切换

1. listings.ts API 客户端
2. types.ts 同步 Listing
3. MarketView 改读 listings
4. PublishTask 改打 listings
5. TradeOverlay 改打 listings claim
6. TaskDetail / TaskList 适配

### 阶段 4：清理

1. 移除老 task 发布路径
2. 移除 partial claim 相关 UI
3. 移除双轨合并逻辑

## 9. 备选方案

### 9.1 不解耦，只删 partial claim

如果业务上"卖100买30"不常见，可以放弃 partial claim：

- 砍掉 partialClaimTask / releasePartialClaimTask / findEffectivePublisherId
- tasks 表保留 parent_task_id 列（或也删）
- 维持"挂单=任务"模型
- partial claim 业务损失：100 挂单只能整单接

**收益**：改动量 ~30% 当前方案
**损失**：业务功能

### 9.2 不解耦，只限制多 item

- 砍掉 createTask 多 item 拆解（tasks 表 items.length=1）
- 保留 partial claim 父子任务路径
- 改动量更小（约 10% 当前方案）

**问题**：仍受父子任务复杂度困扰

---

**当前推荐**：执行本文档"目标架构" + "迁移策略（双轨过渡）"完整方案。

---

## 10. 实施进度（持续更新）

### 阶段 1：后端 listings 全栈上线 ✅ 已完成

- ✅ `db/migrations/006_listings.sql`：listings 表 + 索引 + 触发器
- ✅ `db/migrations/007_tasks_listing_id.sql`：tasks 表加 `listing_id` / `claim_seq` 列
- ✅ `types.ts`：新增 `OrgListing` / `ListingType` / `ListingStatus`
- ✅ `db/mappers.ts`：新增 `ListingRow` / `mapListing`
- ✅ `db/repositories/listings.repo.ts`：CRUD + `claimFromListing` + `nextClaimSeq`
- ✅ `services/listing-service.ts`：发布/浏览/接取/取消（含 `db.batch` 原子事务）
- ✅ `utils/validation.ts`：新增 `createListingSchema` / `listListingsQuerySchema` / `claimListingSchema` / `cancelListingSchema`
- ✅ `routes/listings.ts`：6 个端点（GET / POST / GET/:id / POST /:id/claim / POST /:id/cancel）
- ✅ `index.ts`：挂载 `/listings` 路由
- ✅ `tests/listings.test.ts`：5 个端到端测试场景
- ✅ `tests/setup.ts`：applySchema 同步 apply 006/007
- ✅ `npx tsc --noEmit`：通过

**前端未动**：MarketView 仍读 `/tasks?scope=board` 拉老挂单数据。

### 阶段 2：tasks 模块化简 ✅ 已完成

- ✅ 删除 `findEffectivePublisherId`（3 个调用点：match-contract / contract-sync / task-service）
- ✅ 删除 `partialClaimTask` / `releasePartialClaimTask` repo 函数
- ✅ 删除 `createTasks` batch 路径 → `createTask` 单条
- ✅ `createTask` 校验 `items.length === 1`（多 item 走 `/listings`）
- ✅ `claimTask` 简化（无 partial claim 子任务分支）
- ✅ `releaseTask` 简化（老 partial claim 子任务允许 publisher release → CANCELLED）
- ✅ `cancelTask` / `deleteTaskForPublisher` / `linkContract` / `getTaskForUser` 删除 `parent_task_id` 分支
- ✅ `OrgTask` 类型加 `listingId` / `claimSeq`，移除 `parentTaskId`
- ✅ `validation.ts` `createTaskSchema` refine 限制单 item
- ✅ `routes/tasks.ts` `claim` 端点不再传 amount
- ✅ `scripts/decompose-multi-item.sql` 标记废弃
- ✅ `npx tsc --noEmit`：通过

**注意**：`parent_task_id` 列在 D1 表中**保留**（老 partial claim 子任务数据还在），`TaskRow` 类型仍含该字段以兼容老数据。阶段 3 删列。

### 阶段 3：数据迁移与列清理 ✅ 已完成

- ✅ `db/migrations/008_drop_parent_task_id.sql`：孤儿任务置 CANCELLED → DROP COLUMN parent_task_id → DROP INDEX
- ✅ `db/mappers.ts` `TaskRow` 移除 `parent_task_id` 字段
- ✅ `task-service.ts` `releaseTask` 删除 orphan child 兼容路径
- ✅ `tests/setup.ts` applySchema 同步 008
- ✅ `npx tsc --noEmit`：通过

### 阶段 4：前端切换 ✅ 已完成

- ✅ `infrastructure/org-api/listings.ts`：listListings / getListing / createListing / claimListing / cancelListing
- ✅ `infrastructure/org-api/types.ts`：新增 `OrgListing` / `ListingType` / `ListingStatus` / `ClaimListingResult`；`OrgTask` 移除 `parentTaskId`、加 `listingId` / `claimSeq`；`ClaimTaskResult` 移除 `childTask`
- ✅ `MarketView.vue` 改读 `/listings`；删除 items 摊平逻辑；`MarketOrder` 改用 `listingId` / `remainingAmount`
- ✅ `PublishTask.vue` 改打 `/listings`；单 item 校验；隐藏"添加物品"按钮；UI 文案改"发布挂单"
- ✅ `TradeOverlay.vue` 改打 `/listings/:id/claim`；prop 改 `listingId`；删除 partial claim 文案
- ✅ `TaskDetail.vue`：删除 `parentTaskId` 引用（`parentPublisher` / 子任务特判 / loadParentPublisher / canRelease 子任务分支 / canShowCancelButton 子任务过滤 / canDelete 子任务限制 / onClaim / onRelease 注释 / "原始任务发布者"模板）
- ✅ `infrastructure/org-api/tasks.ts` `claimTask` 删除 `childTask` 引用
- ✅ `npx tsc --noEmit`：通过

### 阶段 5：清理 ⏳ 未开始

待做：
- 移除老 task 发布路径（`createTask` 限内部 service 使用，route 可关停）
- 移除 double 合并逻辑（MarketView 已读 listings，不再读 tasks）

注意：阶段 5 涉及路由层调整（关闭 `POST /tasks` 公开端点 → 限制为 listings 内部使用）。这是 product-level 决策——是否允许老 `POST /tasks` 端点继续暴露给外部客户端。当前未做。