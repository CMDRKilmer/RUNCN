// 验证新模型（当前 STL 余量替代罐容量）vs 实测
// LCB 罐容量=3500, standard 引擎, f_cap=0.164
// 实测数据: [stl余量, f, 离港燃料, 进近燃料, 离港时间s, 进近距离km, 进近时间s, 离港距离km]
const CAP = 3500;
const F_CAP = 0.164; // 10.96×0.015
const data = [
  { stl: 3500, f: 0.1, dFuel: 173, aFuel: 180, dTime: 1308, aTime: 3213, aDist: 67915410, dDist: 22027968 },
  { stl: 1500, f: 0.1, dFuel: 73, aFuel: 80, dTime: 2282, aTime: 6480, aDist: 72028457, dDist: 22027968 },
  { stl: 500, f: 0.1, dFuel: 23, aFuel: 30, dTime: 6540, aTime: 20520, aDist: 89939092, dDist: 22027968 },
  { stl: 200, f: 0.1, dFuel: 8, aFuel: 14, dTime: 18600, aTime: 69600, aDist: 143951887, dDist: 22027968 },
  { stl: 100, f: 0.1, dFuel: 3, aFuel: 9, dTime: 49500, aTime: 76980, aDist: 102724198, dDist: 22027968 },
  // f 对照（STL=3500）
  { stl: 3500, f: 1.0, dFuel: 289, aFuel: 1731, dTime: 1154, aTime: 2007, aDist: 66647899, dDist: 22024319 },
  { stl: 3500, f: 0.01, dFuel: 19, aFuel: 25, dTime: 9240, aTime: 31260, aDist: 103208271, dDist: 22024224 },
];

console.log('=== 新模型：段燃料 = 0.49×STL余量×min(f,cap) / 0.49×STL余量×f+8 ===');
let totalErrD = 0, totalErrA = 0;
for (const d of data) {
  const base = Math.min(d.stl, CAP);
  const fDep = Math.min(d.f, F_CAP);
  const predD = 0.49 * base * fDep;
  const predA = 0.49 * base * d.f + 8;
  const errD = ((predD - d.dFuel) / d.dFuel * 100).toFixed(1);
  const errA = ((predA - d.aFuel) / d.aFuel * 100).toFixed(1);
  totalErrD += Math.abs(Number(errD));
  totalErrA += Math.abs(Number(errA));
  console.log(`STL=${d.stl} f=${d.f}: 离港 实测${d.dFuel} 预测${predD.toFixed(1)} (${errD}%) | 进近 实测${d.aFuel} 预测${predA.toFixed(1)} (${errA}%)`);
}
console.log(`平均|误差|: 离港 ${(totalErrD/data.length).toFixed(1)}%, 进近 ${(totalErrA/data.length).toFixed(1)}%`);

console.log('\n=== 段速度 Weibull（Q=段燃料预测值）vs 实测 ===');
const wD = (q) => 20938 * (1 - Math.exp(-Math.pow(q / 94.6, 1.216)));
const wA = (q) => 38607 * (1 - Math.exp(-Math.pow(q / 181, 1.17)));
let tvD = 0, tvA = 0;
for (const d of data) {
  const base = Math.min(d.stl, CAP);
  const qD = 0.49 * base * Math.min(d.f, F_CAP);
  const qA = 0.49 * base * d.f + 8;
  const vD = wD(qD), vA = wA(qA);
  const vDMeas = d.dDist / d.dTime;
  const vAMeas = d.aDist / d.aTime;
  const errD = ((vD - vDMeas) / vDMeas * 100).toFixed(1);
  const errA = ((vA - vAMeas) / vAMeas * 100).toFixed(1);
  tvD += Math.abs(Number(errD));
  tvA += Math.abs(Number(errA));
  console.log(`STL=${d.stl} f=${d.f}: 离港 v实测${vDMeas.toFixed(0)} 预测${vD.toFixed(0)} (${errD}%) | 进近 v实测${vAMeas.toFixed(0)} 预测${vA.toFixed(0)} (${errA}%)`);
}
console.log(`平均|误差|: 离港 ${(tvD/data.length).toFixed(1)}%, 进近 ${(tvA/data.length).toFixed(1)}%`);
