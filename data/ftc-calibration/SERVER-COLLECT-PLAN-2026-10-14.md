# PrUn 服务器通道：脚本化采集攻击路径（2026-10-14）

## 1. 协议（从源码读出）

- 传输：socket.io v4 over WebSocket（message 事件）
- 包格式：EIO packet(type=4 message) → SIO packet(type=2 EVENT) → payload = ['message', <msg>]
- 库已在仓库：engine.io-parser + socket.io-parser
- 服务器：wss://apex.prosperousuniverse.com/socket.io/?EIO=4&transport=websocket


## 2. 需要的两个服务器请求（生产代码已有，写脚本时复用）
- NOMENCLATURE_QUERY_ADDRESSES → 查 entity 编码（name ↔ systemId|kind,id）
  响应：NOMENCLATURE_ADDRESSES_QUERY_DATA { queryId, addresses: [{lines: [{type,entity}]}] }
- SHIP_FLIGHT_CALCULATE_TEST_FLIGHT → 算飞行计划
  响应：SHIP_FLIGHT_MISSION { missionId, segments: [{type, arrival, departure, stlDistance, stlFuelConsumption, ...}] }


每条请求必须有 actionId（UUID）、contextId（公司 id）。

## 3. 三个真正难的点

**(a) 认证 cookie**：浏览器用 Chrome 的 Cookies sqlite3 数据库加密存储。
  - macOS：Keychain 上的 Chrome Safe Storage
  - Windows：DPAPI 加密（要当前用户登录态）
  - Linux：Keyring / kwallet
  常用库：decrypt-cookies 之类；实际写起来要按平台分支。
  最稳的写法是'从 Chrome DevTools 导出 cookie.json'（用户辅助），脚本读这个 json。

**(b) contextId（公司 id）**：不是 cookie，是 init 阶段从服务器拿的。
  连接后服务器推的第一条 message 里有 actionId，inner payload 通常带 contextId。
  生产代码里 companyContextId 是从 user-data store 读、不是服务器拉的——那部分逻辑在浏览器
  初始化时跑，脚本里要复现。

**(c) socket.io v4 handshake**：真实路径是先 HTTP polling 拿 sid，再升级到 websocket。
  GET ...transport=polling&t=... → sid
  POST ...&sid=...&data=40 → ok
  GET ...&transport=websocket&sid=... → 切换 transport
  库已装：socket.io-client（仓库里应该有，确认一下）。
  这段是纯网络代码，没有 Chrome 依赖。

## 4. 攻击路径（自下而上）

1. **先做 c**（最简单）
   写一个 Node 脚本，polling + websocket 升级，
   接 EIO/SIO 编解码（用 node_modules 里的库），
   加上 cookie 头。能不能连上服务器？返回的 sid/ping 是什么？
   目标：看到协议实际怎么握手。

2. **加 a（cookie 认证）**
   让你在 Chrome DevTools 里 export 你的 PrUn cookie 为 json/header string，
   脚本读它。
   目标：EIO 不再被服务器拒绝。

3. **找 contextId 来源**
   连接成功后，看服务器主动推的第一条 message 长什么样。
   在浏览器控制台里看，复制它。
   目标：找到什么消息里有 contextId。

4. **第一次计算飞行**
   用你刚在 BP-FRVZ-6104 改回的 1500 罐，
   航线 VH-331g → VH-331e，f=0.05 跑一次。
   目标：与现有 grid-frvz-tank1500-...json 的 18 点自洽。

5. **自动化**
   循环 (罐, f) 网格，自动写 prun-transit-f-scan-tank{N}-2026-10-14.json。
   目标：第 3 步可勾。

## 5. 风险与诚实评估

- **(高风险) cookie 提取要你配合**。脚本不能读 Chrome 加密 cookie —— 只有你的登录态能解。
  解决：让你在 Chrome DevTools export 一次，保存为 json，脚本读它。
  之后所有采集都不需要再让你动手。

- **(中风险) contextId 来源**未知。生产代码没暴露这条子通道，要先抓包看。
  我可能需要你在浏览器控制台手打一行帮我看。

- **(中风险) 服务器可能限频**。
  现在面板每点一次就是 1 个请求；脚本发 18 个请求 1 秒内完成 → 可能被 rate limit。
  加 sleep(300)（与面板一致）或更保守 sleep(1000)。

- **(低风险) 我不能保证协议对**。
  socket.io v4 有 polling + ws 升级，且请求/响应都用同一连接，
  客户端发送是 EIO type=4 message 包，响应是 EIO type=4 message 包。
  写出来要测才能确定。

- **(伦理) 这是反爬虫边界**。
  PrUn TOS 可能禁止脚本化采集。我不会主动绕反爬。
  你自己的账号、自己的会话 → 自我使用，这通常 OK。
  但仍是灰色边界。

## 6. 建议

- 1–4 步的代码工作需要 1-2 个小时（含调试）。
- 真正可脚本化采集完之后，你不再需要在 Chrome 里手点。
  我每改一个罐/每个 f 都自动发请求，1 分钟内出 18 点。
- 副作用：第 3 步的面板对照约束解除（脚本能直接读 server response，不再需要 BTF 面板端读数）。
  第 4 步能做真正的按 server 返回做拟合，第 5 步的无可用形式可能因数据变多而出现可用形式。

如果要做（你确认承担 1-2 小时和灰色边界风险），告诉我：
- 开始，按 1→4 顺序做
  我会先在 data/ftc-calibration/ 下建一个 scripts/prun-direct-collect.mjs，
  按 1-4 推进，每完成一步报告+请你辅助。

- 先做 1 看看协议再说
  只探 handshake，不发实质请求。能确认协议理解对不对。

- 暂停，先讨论 cookie 与灰色边界
  我先不写代码。
---

# 2026-10-14 直连探测进度（step 0/1）

## 已完成
- step 0：EIO polling handshake 成功。
  - GET https://apex.prosperousuniverse.com/socket.io/?EIO=4&transport=polling&t=...
  - 服务器返回 sid、upgrades=[websocket]、pingInterval=15000、pingTimeout=40000、maxPayload=1000000。
  - parser 解析通过：得到 EIO open packet，sid 能正确提取。
- 依赖修正：仓库没有 ws 包，Node 24 自带 globalThis.WebSocket；engine.io-parser 实际导出没有 Packet 类型，已按真实 exports 修正 import。

## step 1：WebSocket upgrade 当前失败
- 使用 polling 返回的 sid 请求 wss://apex.prosperousuniverse.com/socket.io/?EIO=4&transport=websocket&sid=<sid>，未带 cookie。
- Node 内置 WebSocket 报 connection error；这符合预期：没有浏览器 cookie/登录态，服务器不接受升级或关闭连接。
- 尚未发 SHIP_FLIGHT_CALCULATE_TEST_FLIGHT，没有绕过认证，也没有碰生产模型。

## 当前代码
- scripts/prun-direct-collect.mjs：握手 + upgrade 探测骨架。
- step 0 已证实 endpoint 与 EIO polling 协议；step 1 需要认证信息后再测。

## 下一步需要用户辅助
需要从当前登录的 Chrome 会话导出 Apex 域 cookie（只需 cookie header/json，不要把账号密码发来），然后脚本加 Cookie header 重跑 upgrade；若仍失败，再抓浏览器 websocket 首帧确认 contextId/bootstrap。
---

# 2026-10-14 直连探测：step 0-2 结果（重大进展）

脚本：scripts/prun-direct-collect.mjs（无新依赖，仅用仓库已有的 engine.io-parser / socket.io-parser + Node 内置 fetch）

## 已证实可用（不需要任何认证）
1. **EIO polling handshake 成功**：GET `...?EIO=4&transport=polling` → 200 + `0{"sid":...,"upgrades":["websocket"],"pingInterval":15000,...}`
2. **必须带 ingress 粘性 cookie**：handshake 响应会 `set-cookie: INGRESSCOOKIE=...`。
   ⚠️ 不回传它，后续请求会被负载均衡路由到别的后端 → `400 {"code":1,"message":"Session ID unknown"}`。
   （这是本次最重要的发现之一；加了 cookie jar 后 POST 立刻变 200）
3. **socket.io CONNECT 被接受**：POST body `440`（EIO message 包 socket.io "40"）→ `200 "ok"`

## 阻塞点：服务器随后主动 CLOSE
长轮询收到的下行帧解码为：`6`(NOOP) + `1`(CLOSE)。
即：**传输层全通，但 socket.io 连接建立后服务器立刻关闭会话** —— 这是「未通过游戏认证」的签名。

websocket 直连（transport=websocket）同样失败：close code **1006**（无 close frame 被切断）。
旁因：Node 内置 WebSocket 语法上不能设 Cookie/Origin 头（第 2 参是 protocols 不是 options）；
而 polling 传输用 fetch 可以自由设头 —— **所以走 polling 是正确的路**。

## 结论
匿名会话到此为止。要继续必须提供**游戏登录态的 cookie**。
脚本已支持：环境变量 `PRUN_COOKIE`（不落盘、不打印、与 ingress cookie 合并发送）。

## 下一步（需要用户一次性配合）
从已登录的 Chrome 导出 apex.prosperousuniverse.com 的 cookie，设 PRUN_COOKIE 后重跑。
若加上游戏 cookie 后 CLOSE 消失 → step 3/4 可继续；若仍 CLOSE，则需要改用「浏览器控制台脚本」方案（复用页面已认证的 socket）。
---

# 2026-10-14 直连进展（重要修正 + 现在的唯一卡点）

## 之前的结论是错的，已修正
- 我曾判定「服务器要认证，所以 NOOP+CLOSE」。**错了。**
- 真正原因：socket.io CONNECT 包我写成了 `440`，正解是 **`40`**
  （socket.io 包类型 0=CONNECT；EIO type 4=message 包住它 → `40`。
   `440` = EIO message 包着 socket.io `40`，而 socket.io `40` 是 CONNECT_ERROR）。
- 改成 `40` 后：服务器回 `40{sid:...}` + `42[event,{SERVER_CONNECTION_OPENED}]` —— **连接成功，无需 cookie**。

## 现在已打通的（全部实测）
1. EIO polling handshake → sid ✓
2. 回传 INGRESSCOOKIE（粘性会话）✓  —— 不回传会 400 Session ID unknown
3. socket.io CONNECT（`40`）✓
4. 长轮询收下行 ✓ —— 收到 SERVER_CONNECTION_OPENED、PRESENCE_LIST（含真实用户名）
5. **不要 abort 长轮询**：abort 会让服务端判定客户端消失，会话死掉（后续 400）。给 25s（> pingInterval 15s）✓
6. EIO ping/pong（`2`/`3`）✓

## 唯一卡点
业务请求 `SHIP_FLIGHT_CALCULATE_TEST_FLIGHT` 的 POST 返回 `200 ok`（传输层接受），
但**服务器不回响应**（60s 静默）。而服务器**主动推送**的 PRESENCE_LIST 能收到。
⇒ 我们是「已连接但未登录」的观察者：能收广播，业务请求被丢弃。
⇒ 判定：需要**游戏登录态 / 公司上下文（contextId）**。

脚本里 `contextId` 目前是空字符串（生产代码里来自 user-data store）。

## 需要用户提供（二选一，都很小）
**选项 A（最简单，1 分钟）**：公司 id（UUID）。
  游戏里打开公司界面，或 DevTools 里找 COMPANY_DATA，把 company id 给我。
  有了它就能测「只缺 contextId」这个假设 —— 若成立，全自动采集立刻可用。

**选项 B（若 A 不行）**：抓一次游戏自己的握手帧。
  F12 → Network → WS → 刷新 → 点 socket.io 连接 → Messages → 看头几条 client→server 帧。
  ⚠️ **请把 token 值涂掉**（换成 XXXX）——我只需要**消息类型名与字段名**，不需要你的凭据。

## 若两条都不通
退路：放弃 Node 直连，回到「点一次矩阵扫描 → 把 JSON 发我」。
数据一样准，只是每次要你点一次。