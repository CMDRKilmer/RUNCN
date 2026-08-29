"""BTF 数据拟合分析：着陆/起飞燃料载重项 + STL 段速度-载重关系。
数据来源 data/ftc-calibration/btf-load-sweep-2026-08-29.md
"""
import math

# ---- 标准引擎 BP-OHMI（高负荷货舱，整备 1199t，G8，推力 196659）----
# 航线1: HRT -> VH-331g（转移+着陆），f=0.05，着陆距离恒 4,779km
# load(t), transfer_h, transfer_km, transfer_fuel, landing_fuel
s1 = [
    (0, 12 + 29 / 60, 520267630, 74, 40),
    (600, 15 + 19 / 60, 519790466, 75, 44),
    (1200, 19 + 55 / 60, 519013386, 75, 51),
    (1500, 21 + 56 / 60, 518674487, 76, 53),
    (1800, 24, 518302876, 76, 56),
    (2400, 28, 517540842, 76, 61),
    (3000, 33, 516859064, 76, 66),
]
# 航线4: VH-331g -> HRT（起飞+转移），f=0.05，起飞距离恒 4,552km
# load(t), takeoff_s, takeoff_fuel, transfer_h, transfer_fuel
s4 = [
    (0, 341, 39, 13 + 9 / 60, 78),
    (600, 381, 43, 16 + 35 / 60, 79),
    (1200, 435, 49, 21 + 46 / 60, 81),
    (1500, 459, 52, 24, 81),
    (1800, 482, 55, 25, 82),
    (2400, 526, 60, 29, 84),
    (3000, 526, 60, 29, 84),
]
# 航线5: HRT -> VH-192c（跨星系），f=0.05
# load(t), depart_h, approach_h, approach_km, approach_fuel, landing_fuel (dist 2143km)
s5 = [
    (0, 1 + 4 / 60, 3 + 2 / 60, 70102623, 41, 27),
    (600, 1 + 20 / 60, 3 + 39 / 60, 69355321, 42, 30),
    (1200, 1 + 44 / 60, 4 + 29 / 60, 68365633, 44, 34),
    (1800, 2 + 8 / 60, 5 + 19 / 60, 67391338, 45, 38),
    (2400, 2 + 32 / 60, 5 + 59 / 60, 66618536, 47, 41),
    (3000, 2 + 32 / 60, 5 + 59 / 60, 66618365, 47, 41),
]
# 节油引擎（整备 1197t）
# load(t), transfer_h, transfer_fuel, landing_fuel (dist 5014km)
s6 = [
    (0, 6 + 52 / 60, 74, 21),
    (600, 9 + 39 / 60, 75, 26),
    (1200, 12 + 32 / 60, 75, 29),
    (1800, 15 + 13 / 60, 76, 32),
    (2400, 18 + 3 / 60, 76, 35),
    (3000, 18 + 3 / 60, 76, 35),
]

EMPTY = 1199  # 标准引擎整备质量 t
G_LIMIT = 8 * 9.81  # 78.48
THRUST = 196659


def accel(mass):
    return min(THRUST / mass, G_LIMIT)


# ================= 1. 着陆/起飞燃料载重项 =================
print("=" * 70)
print("1. 着陆/起飞燃料 vs 载重（距离恒定，f=0.05，标准引擎）")
print("=" * 70)

# 着陆 (VH-331g, dist 4779): base = 0.578*sqrt(4779)
base_landing = 0.578 * math.sqrt(4779)
print(f"着陆基线模型 0.578*sqrt(4779) = {base_landing:.2f} (实测空载 40)")
landing_extra = [lf - 40 for (_, _, _, _, lf) in s1]
takeoff_extra = [tf - 39 for (_, _, tf, _, _) in s4]
loads1 = [x[0] for x in s1]
print("着陆增量:", landing_extra)
print("起飞增量:", takeoff_extra)

# 尝试模型：extra = a * load^p
def fit_power(loads, extras):
    # log-linear fit: ln(extra) = ln(a) + p*ln(load)
    pts = [(math.log(L), math.log(E)) for L, E in zip(loads, extras) if E > 0]
    n = len(pts)
    sx = sum(x for x, _ in pts)
    sy = sum(y for _, y in pts)
    sxx = sum(x * x for x, _ in pts)
    sxy = sum(x * y for x, y in pts)
    p = (n * sxy - sx * sy) / (n * sxx - sx * sx)
    ln_a = (sy - p * sx) / n
    a = math.exp(ln_a)
    return a, p

# 去掉首点(0)后拟合 power
a_l, p_l = fit_power(loads1[1:], landing_extra[1:])
print(f"着陆增量 power fit: extra = {a_l:.4f} * load^{p_l:.3f}")
for L, E in zip(loads1[1:], landing_extra[1:]):
    print(f"  load={L}: 实测 {E}, 模型 {a_l * L ** p_l:.1f}")

# 尝试线性 + 二次: extra = a*load + b*load^2
def fit_poly(loads, extras, deg):
    import numpy as np
    c = np.polyfit(loads, extras, deg)
    return c

try:
    import numpy as np
    c = np.polyfit(loads1, landing_extra, 2)
    print(f"着陆增量 二次拟合: extra = {c[0]:.2e}*L^2 + {c[1]:.4f}*L + {c[2]:.2f}")
    for L, E in zip(loads1, landing_extra):
        print(f"  load={L}: 实测 {E}, 模型 {c[0]*L*L + c[1]*L + c[2]:.1f}")
    c1 = np.polyfit(loads1, landing_extra, 1)
    print(f"着陆增量 线性拟合: extra = {c1[0]:.4f}*L + {c1[1]:.2f}")
except ImportError:
    print("numpy 不可用")

# 用 VH-192c 着陆（dist 2143, base=0.578*sqrt(2143)=26.75, 实测空载27）验证载重项是否随行星/基线缩放
print()
print("VH-192c 着陆（dist 2143km，空载 27u）：")
s5_landing = [x[5] for x in s5]
s5_loads = [x[0] for x in s5]
extra5 = [lf - 27 for lf in s5_landing]
print("  增量:", extra5)
for L, E, E_std in zip(s5_loads, extra5, [0] + [e - l for e, l in zip(landing_extra[1:], [0]*len(landing_extra[1:]))]):
    pass
# 比较同载重下两行星的增量（VH-331g vs VH-192c）
common = [(600, 4, extra5[1]), (1200, 11, extra5[2]), (1800, 16, extra5[3]), (2400, 21, extra5[4]), (3000, 26, extra5[5])]
print("  同载重增量对比 (VH-331g, VH-192c):")
for L, e1, e5 in common:
    print(f"    load={L}: {e1} vs {e5}")

# 节油引擎着陆增量（dist 5014, base=0.578*sqrt(5014)*0.5=20.4, 空载21）
print()
print("节油引擎着陆增量（VH-331g, dist 5014km, 空载 21u）：")
s6_loads = [x[0] for x in s6]
s6_landing = [x[3] for x in s6]
extra6 = [lf - 21 for lf in s6_landing]
print("  增量:", extra6)
for L, e_std, e_fs in zip(loads1, landing_extra, extra6):
    print(f"    load={L}: 标准 {e_std}, 节油 {e_fs}")

# ================= 2. STL 转移速度 vs 载重 =================
print()
print("=" * 70)
print("2. STL 转移速度 vs 载重（标准引擎，f=0.05）")
print("=" * 70)
speeds = [d / (t * 3600) * 1e3 for (_, t, d, _, _) in s1]  # km/s
masses = [EMPTY + L for (L, _, _, _, _) in s1]
print("转移速度(km/s):", [round(v, 0) for v in speeds])
print("质量(t):", masses)

# v ∝ mass^(-p)
def local_p(i):
    return math.log(speeds[0] / speeds[i]) / math.log(masses[i] / masses[0])

print("局部幂指数 p (v∝mass^-p):", [round(local_p(i), 3) for i in range(1, len(masses))])

# v ∝ a^q (a=min(thrust/mass, G))
accs = [accel(m) for m in masses]
print("加速度:", [round(a, 1) for a in accs])

# 尝试 v = v0 * (1 - exp(-mass0/mass)) 或 v = v0*sqrt(m0/m)
print()
print("候选模型对比 (R² 形式)：")
# 模型A: v = v0 * (m0/m)^p 全局拟合
import numpy as np
m0 = masses[0]
v0 = speeds[0]
for p in [0.5, 0.6, 0.7, 0.8]:
    err = sum((v - v0 * (m0 / m) ** p) ** 2 for v, m in zip(speeds, masses))
    print(f"  v = v0*(m0/m)^{p}: SSE={err:.1e}")

# 模型B: v = v0 * (a/a0)^q (a0=G-limit 78.5)
a0 = G_LIMIT
for q in [0.5, 0.6, 0.7, 1.0]:
    err = sum((v - v0 * (min(a, a0) / a0) ** q) ** 2 for v, a in zip(speeds, accs))
    print(f"  v = v0*(min(a,G)/G)^{q}: SSE={err:.1e}")

# 模型C: v = v0 * sqrt(m0/m) * (G-limited 部分)
errC = sum((v - v0 * math.sqrt(m0 / m)) ** 2 for v, m in zip(speeds, masses))
print(f"  v = v0*sqrt(m0/m): SSE={errC:.1e}")

# 模型D: v = k * (a*d)^0.25 之类（Brachistochrone 变体）—— T = k*d^0.5/a^0.5
# 尝试 T = c * d^0.76 * a^-0.38（d^0.76 取自历史模型）
print()
print("转移耗时模型：")
trans_h = [t for (_, t, _, _, _) in s1]
trans_d = [d for (_, _, d, _, _) in s1]
# T = c * d^0.76 / a^0.5
for ea in [0.25, 0.38, 0.5]:
    ratios = [t / (d ** 0.76 * a ** (-ea)) for t, d, a in zip(trans_h, trans_d, accs)]
    rmean = sum(ratios) / len(ratios)
    rerr = sum((r - rmean) ** 2 for r in ratios)
    print(f"  T = c*d^0.76*a^-{ea}: c={rmean:.2e}, 相对残差 {math.sqrt(rerr/len(ratios))/rmean*100:.1f}%")

# ================= 3. 转移速度 vs f（载重0） =================
print()
print("=" * 70)
print("3. 转移速度 vs f（载重 0，标准引擎）")
print("=" * 70)
# f, transfer_h, fuel
fs = [0.05, 0.1, 0.2, 0.3, 0.5, 1.0]
ft = [12 + 29 / 60, 6 + 21 / 60, 3 + 18 / 60, 2 + 20 / 60, 1 + 40 / 60, 1 + 40 / 60]
fd = [520384259, 521421277, 521937387, 522102516, 522218890, 522220425]
fv = [d / (t * 3600) * 1e3 for t, d in zip(ft, fd)]
print("转移速度(km/s):", [round(v, 0) for v in fv])
for i in range(1, len(fs) - 1):
    if fs[i] <= 0.5:
        p = math.log(fv[i] / fv[0]) / math.log(fs[i] / fs[0])
        print(f"  f={fs[i]}: 速度比 {fv[i]/fv[0]:.3f}, 幂指数 {p:.3f}")

# f 饱和点：0.5 与 1.0 相同 → f_cap=0.5
print("f 饱和点: 0.5（0.5 与 1.0 速度/燃料完全相同）")

# ================= 4. 进近燃料 vs 载重 =================
print()
print("=" * 70)
print("4. 进近燃料 vs 载重（HRT->VH-192c，f=0.05）")
print("=" * 70)
# 进近燃料 = 0.49*tank*f + extra。0.49*1500*0.05 = 36.75
base_approx = 0.49 * 1500 * 0.05
print(f"进近基础 0.49*罐*f = {base_approx:.2f}")
print("进近实测:", [x[4] for x in s5])
print("进近增量(超出基础):", [round(x[4] - base_approx, 1) for x in s5])
print("进近距离变化(km):", [x[3] for x in s5])
