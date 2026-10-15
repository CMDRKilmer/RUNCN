# 阻塞：扫描器无法在当前浏览器里运行（2026-10-13）

## 结论
Chrome 里安装的 Refined PrUn 是**独立打包的已发布版本**，不是本仓库的 `dist/`。

证据：
- 扩展 id `inkemdnbgbanaebgdniaahkajjmmnnhf`
- 安装路径：`C:\Users\Administrator\AppData\Local\Google\Chrome\User Data\Default\Extensions\inkemdnbgbanaebgdniaahkajjmmnnhf\26.9.26_0\`
- 该目录含 `_metadata`（CRX 安装标志）、`src/`（**已编译**的逐文件 JS）、`virtual/` 只有 2 个文件
- 本仓库 `dist/` 的 `virtual/FTC.vue.js`（52KB，含新「扫描 f 曲线」）在该目录中**不存在**

即：本仓库重建 `dist/` → 刷新页面 **不会**生效。改了源码也进不到游戏。

## 影响
- 「扫描 f 曲线」按钮（步骤 4 的驱动入口）在游戏里不可用。

## 矛盾已解开（2026-10-13，实测）
安装目录里的扩展是 **2026-09-29** 的构建（`manifest.json` mtime `2026-09-29T05:55:31Z`），
其 `src/features/XIT/DEV/DEV.vue.js` **不含**「导出蓝图与飞船原始数据」按钮，
FTC 目录也**不含**「扫描 f 曲线」。

⇒ 我先前说的「步骤 1 的 DEV 导出按钮生效了」**是错的**：
那个按钮**从未**出现在游戏里。步骤 1 拿到的 `prun-blueprint-dump.json` 是
**用户用别的方式**导出的（或来自另一个我未确认的扩展实例）。
**我不该把「拿到了文件」推断成「我加的按钮生效了」—— 这是我第二次犯同类错误**
（第一次是把策略性拒绝误报成「用户拒绝」）。

⇒ 结论（现在有据）：**本仓库的源码改动从未进入游戏**。
build `dist/` 与游戏里跑的扩展是两套东西。

## 三条出路（需用户决定）
1. **把 `dist/` 以「加载已解压的扩展程序」方式装入 Chrome**（开发者模式），
   之后本仓库的每次 build 都能即时生效 —— 最有利于后续迭代，但需用户操作一次；
2. **用户手动在游戏里跑一次扫描**：无法自动，因为按钮在旧包里没有；
   可改为「用户用 BTF 面板手工点几档 f，把 SFC 表格数据发我」；
3. **改走纯离线反推**：不依赖游戏，用已有 BTF/历史数据做能做的标定
   （但 f 曲线缺地面真值，只能标注为「未验证」，不能修正）。

## 已验证可用的部分（不依赖浏览器）
- `scripts/verify-transit-f-curve.mjs`：自带断言与退出码，**变异验证通过**
  （模型匹配夹具 → PASS 5/exit 0；平坦 f 依赖夹具 → ⑤ 报 6.92× FAIL/exit 1）；
- 扫描器源码 `src/infrastructure/prun-api/data/transit-f-scan.ts` 编译/lint 均过；
- 步骤 1-3 均已落地并通过回归。


---

# ⚠️ 2026-10-14 更正（读上面之前先读这段）

上面「矛盾已解开」一节里 **「步骤 1 拿到的 prun-blueprint-dump.json 是用户用别的方式导出的」** 推断**错了机制**，
连带 **「本仓库的源码改动从未进入游戏」** 也**过强**。更正如下（有据）：

- `data/ftc-calibration/prun-transit-f-scan.json` 带 `Zone.Identifier`：
  `HostUrl=https://apex.prosperousuniverse.com/`，且 `mtime(2026-10-13 17:14:55) < creationTime(17:16:56)`
  （移动/另存会保留 mtime）⇒ **该文件是从游戏页面下载出来的**，即当时游戏里跑着**带扫描器的构建**。
- 因此「扫描器从未在游戏里生效」是**错的**：2026-10-13 17:14 有过一次**成功的** f 扫描（6 档全部有数据）。

准确的当前状态：
- **更正（2026-10-14 再次）**：本仓库 `dist/` **已经是**以「加载已解压的扩展程序」装着的 ——
  `Secure Preferences` 里 `afmplfoofkin…`：`location: 4`、`from_webstore: false`、
  `path: C:\Users\Administrator\Desktop\code\RUNCN\dist`；`dist/` 内含扫描器。
  （先前写「现在装的是商店版、所以采集不了」是**错的**：`Extensions/` 下的 `26.10.12_0` 是另一个
  **并存**的商店扩展，不是游戏里跑的那个。）
- ⇒ **不需要再装任何东西**，刷新游戏页面直接用面板扫描即可。

**且那份已采到的数据本身口径错配**，不能用于标定 —— 详见
`data/ftc-calibration/scan-review-tank-mismatch-2026-10-14.md`
（扫描传 `stlFuel=8000`，蓝图真实罐 1500）。
