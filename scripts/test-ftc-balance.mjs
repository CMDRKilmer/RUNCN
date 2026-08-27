// 快速验证 FTC 平衡点（Pareto 拐点）算法：模拟一组 (时间, 燃料) 权衡方案，
// 确认拐点落在「快」与「省油」之间、且是前沿上距两极端连线最远的点。
// 用法：node scripts/test-ftc-balance.mjs（纯逻辑测试，不依赖扩展）。
const options = [
  { fuel: 0.05, reactor: 0.1, totalHours: 40, stlFuel: 30, ftlFuel: 5 },
  { fuel: 0.1, reactor: 0.2, totalHours: 30, stlFuel: 60, ftlFuel: 10 },
  { fuel: 0.15, reactor: 0.3, totalHours: 22, stlFuel: 90, ftlFuel: 15 },
  { fuel: 0.2, reactor: 0.4, totalHours: 17, stlFuel: 120, ftlFuel: 20 },
  { fuel: 0.3, reactor: 0.6, totalHours: 13, stlFuel: 180, ftlFuel: 30 },
  { fuel: 0.5, reactor: 0.8, totalHours: 10.5, stlFuel: 300, ftlFuel: 40 },
  { fuel: 1.0, reactor: 1.0, totalHours: 9, stlFuel: 600, ftlFuel: 50 },
  // 被支配方案（时间更长且燃料更多）：不应出现在前沿
  { fuel: 0.35, reactor: 0.7, totalHours: 13.5, stlFuel: 240, ftlFuel: 40 },
];

const totalFuelOf = o => o.stlFuel + o.ftlFuel;

const pareto = options
  .filter(
    o =>
      !options.some(
        p =>
          p !== o &&
          p.totalHours <= o.totalHours &&
          totalFuelOf(p) <= totalFuelOf(o) &&
          (p.totalHours < o.totalHours || totalFuelOf(p) < totalFuelOf(o)),
      ),
  )
  .sort((a, b) => a.totalHours - b.totalHours);

const fastest = pareto[0];
const cheapest = pareto[pareto.length - 1];
const tSpan = Math.max(1e-9, cheapest.totalHours - fastest.totalHours);
const fuels = pareto.map(totalFuelOf);
const fMin = Math.min(...fuels);
const fSpan = Math.max(1e-9, Math.max(...fuels) - fMin);
let best = fastest;
let bestDist = -1;
for (const o of pareto) {
  const x = (o.totalHours - fastest.totalHours) / tSpan;
  const y = (totalFuelOf(o) - fMin) / fSpan;
  const dist = Math.abs(x + y - 1);
  if (dist > bestDist) {
    bestDist = dist;
    best = o;
  }
}

console.log('Pareto 前沿:');
for (const o of pareto) {
  console.log(`  f=${o.fuel} r=${o.reactor} t=${o.totalHours}h fuel=${totalFuelOf(o)}`);
}
console.log(`平衡点: f=${best.fuel} r=${best.reactor} t=${best.totalHours}h fuel=${totalFuelOf(best)}`);
console.log(`最快: f=${fastest.fuel} t=${fastest.totalHours}h fuel=${totalFuelOf(fastest)}`);
console.log(`最省油: f=${cheapest.fuel} t=${cheapest.totalHours}h fuel=${totalFuelOf(cheapest)}`);
if (pareto.length !== 7) {
  console.error(`❌ 前沿应有 7 个（被支配方案被剔除），实际 ${pareto.length}`);
  process.exit(1);
}
if (!(best.totalHours > fastest.totalHours && best.totalHours < cheapest.totalHours)) {
  console.error('❌ 平衡点应在最快与最省油之间');
  process.exit(1);
}
console.log('✅ 平衡点算法验证通过');
