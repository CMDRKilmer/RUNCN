// FTC 验证脚本共用的截图实测参数（单一来源，避免脚本间手抄漂移）。
//
// 截图实测飞船：AVI-06JVV（BP-ZXWK-1228）标准引擎 / 罐 3500 / G8 / 空重 1271t /
// 流量 0.015 u/s / FTL 2.84 pc/h；当前质量 2140t 由截图分段时长
// （离港 1h14m41s / 进近 22m25s）反解，两段误差 <0.01%。
export const SHIP = {
  mass: 2140,
  operatingEmptyMass: 1271,
  acceleration: 0,
  ftlMaxSpeed: 2.84,
  stlFuelFlowRate: 0.015,
  reactorPower: 0,
  condition: 1,
  stlEngineOption: 'STL_ENGINE_STANDARD',
  maxGFactor: 8,
  stlFuelCapacity: 3500,
  stlRemaining: undefined,
};

// 截图航线几何：zv-307a → ANT（同星系）。68.0562M + 33.6491M 来自截图里 FTC 面板的
// 「航线分段（**模型估算**）」两行（该标题表明它不是服务器原生计划 —— 2026-09-23 复核更正：
// 真实系内计划只有「转移」（TRANSIT）段，见 system-bodies.recordStlSegments 注释），
// 总 d = 101.7053M km；修复前模型用 liftOffKmAt 自建轨道几何得到的 d = 101.8808M
// （面板 best.stlFuel = 580.7205u）。这里仅作**测试几何常量**使用。
export const DEPART_KM = 68.0562e6;
export const APPROACH_KM = 33.6491e6;
