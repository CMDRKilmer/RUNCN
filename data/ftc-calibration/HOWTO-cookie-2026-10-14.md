# 直连采集：需要你提供游戏 cookie（一次性，2026-10-14）

## 进展（好消息）
协议已经全部打通到最后一格：
- EIO polling handshake ✓（拿到 sid）
- ingress 粘性 cookie 处理 ✓（不回传就会 400 Session ID unknown，已解决）
- socket.io CONNECT ✓（服务器回 200 ok）
- 唯一缺的：**游戏登录态 cookie**。没有它，服务器在 CONNECT 后立刻发 NOOP+CLOSE。

## 你要做的（约 1 分钟）

1. 在 Chrome 里打开游戏标签页（已登录的那个）。
2. F12 打开 DevTools。
3. 顶部切到 **Network（网络）** 面板 → 刷新页面（F5）→ 随便点一个发往 apex 的请求。
4. 右侧 **Headers（标头）** → 往下找 **Request Headers（请求标头）** → 找到 `Cookie:` 那一行。
5. 把 `Cookie:` **后面那一整串**复制下来（形如 `a=b; c=d; e=f`）。

   或者走 Application 面板：
   F12 → **Application（应用）** → 左侧 Storage → **Cookies** → `https://apex.prosperousuniverse.com`
   → 把每行的 Name=Value 用 `; ` 连起来。

6. 把这一串发给我（或你自己跑下面命令）。

## 怎么跑

PowerShell：

    $env:PRUN_COOKIE="粘到这里"; node scripts/prun-direct-collect.mjs

脚本会：合并 [你的游戏 cookie] + [ingress 粘性 cookie] → 重新 CONNECT → 看 CLOSE 是否消失。

## 我不会做的事
- 不把这个 cookie 写入任何文件（只从环境变量读，不落盘）
- 不打印它的内容（日志里只显示长度）

## 如果加上 cookie 仍然 CLOSE
那就说明服务器在校验浏览器特有的东西（Origin/指纹/CSRF），Node 端走不通。
退路：我写一段**浏览器控制台脚本**给你，粘进游戏页面的 console 里跑 ——
它复用页面自己的同源上下文，cookie/Origin 全天然正确，扫完直接下载 JSON。
这条路不需要你导出 cookie，但每次采集都要你粘一次。