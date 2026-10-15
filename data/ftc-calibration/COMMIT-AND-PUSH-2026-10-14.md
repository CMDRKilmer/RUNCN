# 提交并推送：方案 a（转移段速度查询表）

## 为什么没有自动提交
本会话的 `pwsh` 工具已不可用（spawn ENOENT：`C:\Program Files\WindowsApps\Microsoft.PowerShell_7.6.6.0_...\pwsh.exe` 起不来），
因此我**无法执行 git 命令**。changelog 与代码改动都已落盘，你跑下面几条即可。

## 当前分支
`codex/ftc-native-data`

## 本次要提交的文件

```
CHANGELOG.md
public/json/transit-speed-table.json
src/features/XIT/FTC/FTC.vue
src/features/XIT/FTC/fuel-model.ts
src/infrastructure/shell/config.types.d.ts
src/refined-prun-startup.ts
scripts/verify-transit-lookup.mjs
```

⚠️ 工作树里还有**更早的多轮改动**未提交（docs/、其他 FTC/FLEET 文件、以及大量 data/ftc-calibration/*.json 标定数据）。
我**只提交上面这 7 个**，避免把无关改动混进这次提交。
如果你想连标定数据一起提交，见文末「可选：连数据一起提交」。

## 执行

```powershell
cd C:\Users\Administrator\Desktop\code\RUNCN

git add CHANGELOG.md public/json/transit-speed-table.json src/features/XIT/FTC/FTC.vue src/features/XIT/FTC/fuel-model.ts src/infrastructure/shell/config.types.d.ts src/refined-prun-startup.ts scripts/verify-transit-lookup.mjs

git commit -m "feat(FTC): 系内转移段速度改用实测查询表" -m "
受控扫描证明旧式（27512 x (1271/质量)^0.78）两个前提都错：
1) 质量幂指数不是常数（同 Q 下 828->1270 无影响、1270->1456 降 2.7%）；
2) 模型完全没有罐项 —— 同船只改罐，f=0.5 速度相差 2.32 倍。

连续 6 种闭式在全数据集 336 点上最好也只有 28% 误差；正交二维网格显示
物理结构是部分可分离（未饱和区可分 3.5%、饱和区最高 57%），耦合住在饱和里。
故改用查询表：v = f(引擎, Q, a_eff)，Q=0.98*罐*min(f,0.5)，
a_eff=acc*空重/总质量，4 近邻反距离加权（log 空间）。

实测 372 点：整体平均 1.2%，内部区间(a_eff 50-120)平均 1.0%。
外推区（罐 500、a_eff 两端）最大 32.7%，已在 UI 明示。

新增 scripts/verify-transit-lookup.mjs（exit 0）—— 第一个真正测生产路径的
转移段速度校验。既有 verify-transit-f-curve / verify-transit-e2e 仍直接调
stlIntraTransitSpeedKmS（旧式子本身），本次未改其断言来变绿。
"

git push
```

## 提交前自检（建议先跑）

```powershell
pnpm run compile   # 期望 exit 0（vue-tsc）
pnpm run lint      # 期望 exit 0（eslint）
node scripts/verify-transit-lookup.mjs   # 期望 exit 0
```

上面三条在本会话机器上是 **exit 0 / exit 0 / exit 0**（工具失效前刚跑过）。

## 推送后
1. 刷新游戏页面（加载新 dist）—— 扩展 reload 我够不到 chrome://，见此前记录
2. 面板「转移段速度」那一行会显示当前走表 / 回退旧式
3. 游戏里实测一轮：FTC 对某条航线的预估 vs BTF 面板

## 可选：连数据一起提交

```powershell
git add data/ftc-calibration
git commit --amend --no-edit
```

（标定原始数据约几十个 JSON + 若干 md；不想进主干就保持上面的 7 文件提交。）