# 扫描器实测结论（2026-10-13）：按钮可用，但 resolveEntity 走不通

## 已验证
- UI 正常渲染（截图证实：探针 HRT / 目标天体 VH-331g / 段 STL 燃料 8000）；
- 点击**有效**：`startFScan` 被执行，面板显示 `无法解析探针或目标天体，请检查名称`；
- 说明点击、v-model、函数绑定全部正常 —— **问题只在数据解析**。

## 失败点
`resolveEntity('HRT')` 返回 undefined。它内部走：
```
stationsStore.getByNaturalId('HRT')  → 应命中 defaultStations 里的 Hortus Station
  → query = station.name = 'Hortus Station'
  → queryAddresses('Hortus Station')   ← 12s 后超时返回 undefined
  → 返回 undefined → 面板报「无法解析」
```

## 根因（未完全确认，但高度可疑）
`queryAddresses` 通过 `sendServerMessage` 发 `NOMENCLATURE_QUERY_ADDRESSES` 到
`nomenclature-registry`，响应由 `onApiMessageForce` 的 `NOMENCLATURE_ADDRESSES_QUERY_DATA` 接收。
它**依赖游戏 socket 上下文**。12 秒无响应说明该请求在本环境下没有被应答
（可能要求公司上下文/需要先打开某个界面）。

⚠️ 与之对照：`ftc-compute.ensureShipBlueprint` 用的是 `blueprintsStore.request()`
（游戏 UI 侧请求），不是裸发 socket —— 说明裸发这条路在本项目里并未被验证过。

## 结论与选择
1. **不要**继续在裸 socket 请求上投入 —— 它不在本项目已验证的路径上；
2. 正确做法：**复用已验证的通道**。已有两条：
   - `ftc-compute` 的 `ensureShipBlueprint`（UI 触发，可靠）；
   - `flight-plans.findNativeFlightPlan` + `SHIP_FLIGHT_MISSION`（被动接收，已被 FTC 面板使用）。
3. 或者：**先让用户在游戏里手动打开一次 BTF 面板**再试 —— 某些 registry 请求
   需要对应界面先初始化。

## 待验证（下一步）
在 BTF 面板（蓝图船只试航模拟）打开的状态下，再点一次「扫描 f 曲线」。
若成功 ⟹ 根因确认是「registry 需要界面预热」；
若仍失败 ⟹ 裸 socket 路径不通，需要改用 UI 驱动的方案。
