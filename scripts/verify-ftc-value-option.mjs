// FTC「最优性价比」选点（fuel-model.pickBestValueOption）纯函数回归脚本 —— 带退出码。
//
// 锁定的行为契约：
//   ① 同一反应堆序列内逐档比较「每 +1 燃料换回多少时间」，边际收益跌破首档一半即停；
//   ② 多反应堆（FTC 全网格）时**先按反应堆分组**、组内选点，再比较各序列候选——
//      不允许把反应堆带来的时间差算进燃料边际收益（否则结果随输入顺序变化）；
//   ③ 结果与输入顺序无关；
//   ④ maxFuel 上限（离港饱和点）先过滤再选点；
//   ⑤ 单序列（BTF 实测固定反应堆）结果与旧口径逐位一致。
//
// 用法：node scripts/verify-ftc-value-option.mjs
// 退出码：0 = 全部通过（末行 PASS n/n）；1 = 有失败（打印 FAIL <场景> expected=… actual=…）。
// 局限：只到纯函数层；面板/向导接线与真实服务器数值不在本脚本范围内。
import { pickBestValueOption } from '../src/features/XIT/FTC/fuel-model.ts';

const summary = { pass: 0, fail: 0 };

function check(name, fn) {
  const failures = [];
  try {
    fn(failures);
  } catch (e) {
    failures.push(`抛出异常 ${String(e)}`);
  }
  if (failures.length === 0) {
    summary.pass++;
    console.log(`PASS ${name}`);
  } else {
    summary.fail++;
    console.log(`FAIL ${name} ${failures.join(' | ')}`);
  }
}

function option(fuel, reactor, totalHours) {
  return { fuel, reactor, stlFuel: fuel, ftlFuel: 0, totalHours };
}

function expectOption(failures, label, actual, expected) {
  if (actual === undefined) {
    failures.push(`${label}: 未返回方案`);
    return;
  }
  if (actual.fuel !== expected.fuel || actual.reactor !== expected.reactor) {
    failures.push(
      `${label}: expected=fuel ${expected.fuel}/reactor ${expected.reactor}` +
        ` actual=fuel ${actual.fuel}/reactor ${actual.reactor}`,
    );
  }
}

const seriesSlow = [option(10, 0.3, 10), option(20, 0.3, 8), option(30, 0.3, 7)];
const seriesFast = [option(10, 1, 6), option(20, 1, 5), option(30, 1, 4)];

check('① 单序列按边际收益停档', f => {
  expectOption(f, 'marginal', pickBestValueOption(seriesSlow), option(30, 0.3, 7));
});

check('② 跨反应堆只比较各序列候选', f => {
  const grid = [...seriesSlow, ...seriesFast];
  expectOption(f, 'grid', pickBestValueOption(grid), option(30, 0.3, 7));
});

check('③ 输入顺序不影响结果', f => {
  const shuffled = [seriesFast[2], seriesSlow[0], seriesFast[0], seriesSlow[2], seriesFast[1], seriesSlow[1]];
  expectOption(f, 'shuffled', pickBestValueOption(shuffled), option(30, 0.3, 7));
});

check('④ maxFuel 先过滤（饱和点封顶）', f => {
  const grid = [...seriesSlow, ...seriesFast];
  expectOption(f, 'maxFuel=20', pickBestValueOption(grid, 20), option(20, 0.3, 8));
});

check('⑤ 单序列 5%–100% BTF 样本保持旧口径', f => {
  const samples = [option(5, 0.5, 12), option(10, 0.5, 10), option(20, 0.5, 8), option(30, 0.5, 7)];
  expectOption(f, 'btf', pickBestValueOption(samples), option(20, 0.5, 8));
});

check('⑥ 燃料总量无差别的短途取最快', f => {
  const flat = [
    { ...option(10, 0.5, 9), stlFuel: 5 },
    { ...option(20, 0.5, 8), stlFuel: 5 },
    { ...option(30, 0.5, 8), stlFuel: 5 },
  ];
  expectOption(f, 'flat', pickBestValueOption(flat), option(20, 0.5, 8));
});

check('⑦ 空输入返回 undefined', f => {
  const actual = pickBestValueOption([]);
  if (actual !== undefined) {
    f.push(`expected=undefined actual=${JSON.stringify(actual)}`);
  }
});

console.log(`PASS ${summary.pass}/${summary.pass + summary.fail}`);
process.exit(summary.fail === 0 ? 0 : 1);
