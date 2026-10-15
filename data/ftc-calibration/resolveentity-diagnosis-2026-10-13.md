# resolveEntity 失败：已确认的事实 vs 仍未验证的假设

## 已确认（有证据）
1. UI 正常渲染，点击**有效**：`startFScan` 被执行，面板显示「无法解析探针或目标天体」。
2. `resolveEntity('HRT')` 返回 undefined（否则不会走这句提示）。
3. `stationsStore.getByNaturalId('HRT')` **应该命中** —— defaultStations 里确有
   `{naturalId:'HRT', name:'Hortus Station', system:VH-331}`。
4. socket 通道本身**没问题**：`sendServerMessage` 在 socket 未 OPEN 时返回 false，
   而 `sendMessage` 会**抛错** → 面板会显示「扫描失败：...」而不是「无法解析」。
   既然显示的是「无法解析」，说明**消息发出去了**，只是 12s 内没收到匹配响应。
5. `dispatchForce` 对**每条**消息无条件调用（prun-api-listener.ts:27 dispatchAlways），
   所以监听器本身应该能收到 —— 不存在「通道没派发」的问题。
6. BTF 面板是否打开**不影响**（用户确认一直开着，仍失败）。

## 仍未验证（我此前的错误假设）
- ~~「BTF 预热能让 registry 应答」~~ → 已证伪。
- 服务器是否真的应答了 `NOMENCLATURE_ADDRESSES_QUERY_DATA`？
- 应答来了但 `queryId` 不匹配？（我只在 pendingQueries 里按 queryId 找）
- 还是压根没应答？

## 已做的改进（2026-10-13 第二次）
给 `resolveEntity` 加了**分级诊断**（console.warn），把三种失败分开：
  a) 12s 无响应 → 提示 "无响应（12s 超时）"
  b) 有响应但无一匹配 → 提示返回条数 + 首条地址结构
  c) 命中 → 正常返回
编译 ✓，已 build。

## 下次要拿到的信息
刷新游戏页面 → 点「扫描 f 曲线」→ 等 ~15 秒 → 看 console 里的 `[resolveEntity]` 警告。
**这条警告直接决定后续方向**，不需要再猜：
  - 若是 (a) → 裸 socket 请求不被应答，必须改用 UI 驱动方案；
  - 若是 (b) → 请求通了但匹配逻辑有 bug（我优先怀疑这个：`stationLine.name`
    与 naturalId 的大小写/命名差异）。

## 备注
我倾向于 (b)：`resolveEntity` 的匹配条件是
`stationLine.name.toUpperCase() === naturalId.toUpperCase()`，
即拿 `Hortus Station` 和 `HRT` 比 —— **名字和 naturalId 永远不相等**。
这条对空间站很可能恒不成立，对行星才成立（planet.naturalId 才可能是 'VH-331g'）。
⇒ 若如此，探针必须填行星而不是空间站，或匹配逻辑需要同时比 naturalId 与 name。
