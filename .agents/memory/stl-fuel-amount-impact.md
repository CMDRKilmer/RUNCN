# FTC STL/FTL 油量与滑块模型（2026-08-27 完整实测定稿）

## ★ 最重要的两个结论

1. **段燃料基准 = 当前 STL 罐余量**（非蓝图罐容量）：
   `Q = 0.49×STL余量×f`（离港 min(f, f_cap)）+ `0.49×STL余量×f+8`（进近）
   —— 罐不满时 Q 变小 → 段燃料少、段速度慢、时间/距离变。
   **已改代码**：`fuel-model.ts` `ShipPerformance.stlRemaining`（`ftc-compute.ts` `shipFuelRemainingFor` 从油罐 store 实测），`stlSegmentSpeedFor`/`computeFuelOption` 用 `stlRemaining ?? stlFuelCapacity`。

2. **滑块必须用键盘操作**（focus + Home/End/方向键）才触发服务器重算：
   mousedown 拖拽只改 DOM `aria-valuenow`，**不触发 React onChange**，表格是陈旧数据
   → 会得出「f/r 滑块无效」的错误结论（踩过坑）。
   SFC 状态变「计算中」→「有效」才算重算成功。

## STL 段模型（LCB HRT→Animus a 跨星系，实测验证）

### 段燃料（7 点验证，高油量误差<7%）
- **进近 = 0.49×基准×f + 8**：f=0.01→25u、f=0.13→232u、f=1.0→1731u（=0.49×3500×1+8）全中
- **离港 = 0.49×基准×min(f, f_cap)**：f_cap=10.96×流量（standard 0.015→0.164），f=1.0→289u 饱和
- 基准 = min(当前STL, 罐容量)；低油量(<500u)绝对误差 2-4u（取整/截断噪声）

### 段速度 = 各引擎 Weibull（Q=段燃料）
- 离港 vSat=20938/q0=94.6/k=1.216：平均误差 ~11%
- 进近 vSat=38607/q0=181/k=1.17：平均误差 ~16%
- 引擎表见 `fuel-model.ts` STL_SEGMENT_CURVES

## FTL 模型（LCB HRT→ZV-307a 自然 61pc 8跳，三档验证）

| r | FTL 燃料 | C_F×r×pc 预测 | 误差 | 充能/跳 |
|---|---|---|---|---|
| 0.438 | 188u | 7.03×0.438×61=187.8 | **0.1%** | 3m17s=197s |
| 0.719 | 314u | 7.03×0.719×61=308.5 | 2% | 5m23s=323s |
| 1.0 | 436u | 7.03×1.0×61=428.8 | 1.7% | 7m30s=450s |

- **FTL 燃料 = C_F×r×总pc**：C_F = 0.00293×反应堆功率(GW)，LCB STD 2400→7.03，三档 <2%
- **充能 = (eT/m)×r**：eT/m=450s（LCB 与 WCB 同），三档精确（197/323/450 ∝ r）
- 跃迁速度随 r 增快（8pc 跳：1.91/2.14/2.40 pc/h）
- FTL 燃料分配在充能段（每跳 = 充能时间×~0.12 u/s）
- 短跳（3pc）验证：r 影响 FTL 燃料（10/17/24u）但跃迁时间差异小（噪声大）
- **与 fuel-model.ts 现有公式完全一致 → 模型通过**

## r 对总时间的影响（61pc 航线）
- r=0.438: 1天12h31m
- r=0.719: 1天9h09m
- r=1.0: 1天6h10m
（r 高 → FTL 燃料多但时间短，trade-off 正确）

## STL 段不受 r 影响
- 61pc 航线 STL 233u 恒定（87离港+97进近+49着陆），三档 r 全同

## 验证脚本
- `scripts/verify-stl-fuel-model.mjs`（段燃料+段速度验证）

## 测试操作要点
- MTRA 命令支持大批量转移：`MTRA SF,发货storeId,收货storeId,数量`
  （LCB-1 STL store=091ba47a569b54ce1d07191e3c22e012，仓库=2ea36536f6da5404b6e746d3d7f1674c）
- 长航线自然 FTL 测试：SFC 目的地 ZV-307a（61pc），需关闭「使用跃迁点」
- 滑块键盘：focus → Home(MIN)/End(MAX)

## 已知未验证
- f 对 hyperthrust/advanced/fuelSaving 引擎的段燃料（已有引擎表，未跨引擎复测）
- 小 STL 油量 + 大 STL 距离边界
- 网关航线 STL 段（离港/进近低 ~35-50%）
