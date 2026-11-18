// 用法：node --experimental-strip-types scripts/verify-sfc-formula-plan.mjs
// SFC 自动联动（src/features/XIT/FTC/formula-compute.ts）的行为契约，退出码检查。
// 覆盖（6 个场景）：
//   ① 输入完整 → 按航线键写入燃料/反应堆参数，lastFtcCompute.complete = true；
//   ② 输入残缺 → 一个参数都不写，lastFtcCompute.complete = false（SFC 沿用玩家当前设置）；
//   ③ publish = false（假设性计算）→ 既不写参数也不写完成信号；
//   ④ 起终点相同 → ok = false，不调模型；
//   ⑤ 空输入 → ok = false，不调模型；
//   ⑥ 网关航线用独立键，直飞参数不串到网关航线（键格式与 ftcRouteKey 逐位一致）。
//
// 局限：模型本身（planFormulaFlight）由替身按用例脚本返回，真实公式数值见
// verify-ftc-formula.mjs / verify-real-flight.mjs；本脚本只锁「什么时候写、写到哪个键」。
// 未映射的 '@src/*' 会显式报错。
import { register } from 'node:module';

register('./lib/sfc-formula-loader.mjs', import.meta.url);

const stub = await import('./lib/sfc-formula-stub.mjs');
const { computeFormulaFtcPlan } = await import('../src/features/XIT/FTC/formula-compute.ts');
const { ftcRouteKey, getFtcFuelSlider, getFtcReactorUsage } =
  await import('../src/features/XIT/FTC/ftc-fuel-settings.ts');

const summary = { pass: 0, fail: 0 };

async function check(name, fn) {
  const failures = [];
  try {
    await fn(failures);
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

function expectEqual(failures, label, expected, actual) {
  const e = JSON.stringify(expected);
  const a = JSON.stringify(actual);
  if (e !== a) {
    failures.push(`${label} expected=${e} actual=${a}`);
  }
}

const ship = 'T-1';
const key = ftcRouteKey(ship, 'HRT', 'ANT', false);
// ftc-fuel-settings 是进程内的真实持久化 map：每个用例用**独立起点**，避免上一条写入被下一条读到。

function useFixture(plan) {
  stub.stubReset();
  stub.stubSetPlan(plan);
}

const goodPlan = {
  ok: true,
  message: '',
  reactorRelevant: true,
  best: { fuel: 0.35, reactor: 0.6, totalHours: 3, stlFuel: 120, ftlFuel: 26 },
};

await check('输入完整：写入航线键参数并置完成信号', async failures => {
  useFixture(goodPlan);
  const result = await computeFormulaFtcPlan({ shipRegistration: ship, from: 'HRT', to: 'ANT' });
  expectEqual(failures, 'ok', true, result.ok);
  expectEqual(failures, 'inputIncomplete', undefined, result.inputIncomplete);
  expectEqual(
    failures,
    'best',
    { fuel: 0.35, reactor: 0.6 },
    {
      fuel: result.best?.fuel,
      reactor: result.best?.reactor,
    },
  );
  expectEqual(failures, '燃料滑块', 0.35, getFtcFuelSlider(ship, 'HRT', 'ANT', false));
  expectEqual(failures, '反应堆档', 0.6, getFtcReactorUsage(ship, 'HRT', 'ANT', false));
  expectEqual(failures, '完成信号键', key, stub.lastFtcCompute.value?.key);
  expectEqual(failures, '完成信号 complete', true, stub.lastFtcCompute.value?.complete);
});

await check('输入残缺：不写任何参数，完成信号标 false', async failures => {
  useFixture({
    ok: false,
    message: '无法解析起终点',
    inputIncomplete: ['无法解析起终点，请输入具体行星或空间站代号'],
    reactorRelevant: false,
  });
  const result = await computeFormulaFtcPlan({ shipRegistration: ship, from: 'HRT2', to: 'ANT' });
  expectEqual(failures, 'ok', false, result.ok);
  expectEqual(
    failures,
    'inputIncomplete',
    ['无法解析起终点，请输入具体行星或空间站代号'],
    result.inputIncomplete,
  );
  expectEqual(failures, '燃料滑块未写', undefined, getFtcFuelSlider(ship, 'HRT2', 'ANT', false));
  expectEqual(failures, '反应堆档未写', undefined, getFtcReactorUsage(ship, 'HRT2', 'ANT', false));
  expectEqual(failures, '完成信号 complete', false, stub.lastFtcCompute.value?.complete);
});

await check('publish=false：假设性计算既不写参数也不写完成信号', async failures => {
  useFixture(goodPlan);
  stub.stubSetLastCompute(undefined);
  await computeFormulaFtcPlan({
    shipRegistration: ship,
    from: 'HRT3',
    to: 'ANT',
    publish: false,
  });
  expectEqual(failures, '燃料滑块未写', undefined, getFtcFuelSlider(ship, 'HRT3', 'ANT', false));
  expectEqual(failures, '完成信号未写', undefined, stub.lastFtcCompute.value);
});

await check('起终点相同：直接拒绝，不调模型', async failures => {
  useFixture(goodPlan);
  const result = await computeFormulaFtcPlan({ shipRegistration: ship, from: 'HRT', to: 'hrt' });
  expectEqual(failures, 'ok', false, result.ok);
  expectEqual(failures, '模型调用次数', 0, stub.calls.length);
});

await check('空输入：直接拒绝，不调模型', async failures => {
  useFixture(goodPlan);
  const result = await computeFormulaFtcPlan({ shipRegistration: ship, from: '', to: 'ANT' });
  expectEqual(failures, 'ok', false, result.ok);
  expectEqual(failures, '模型调用次数', 0, stub.calls.length);
});

await check('网关航线用独立键：直飞参数不串到网关航线', async failures => {
  useFixture(goodPlan);
  await computeFormulaFtcPlan({
    shipRegistration: ship,
    from: 'HRT4',
    to: 'ANT',
    useGateway: true,
  });
  expectEqual(failures, '网关键', 0.35, getFtcFuelSlider(ship, 'HRT4', 'ANT', true));
  expectEqual(failures, '直飞键仍为空', undefined, getFtcFuelSlider(ship, 'HRT4', 'ANT', false));
  expectEqual(failures, '键格式', 'T-1|HRT|ANT|gw', ftcRouteKey(ship, 'HRT', 'ANT', true));
});

console.log(
  summary.fail === 0
    ? `PASS ${summary.pass}/${summary.pass}`
    : `FAIL ${summary.pass}/${summary.pass + summary.fail}`,
);
process.exitCode = summary.fail === 0 ? 0 : 1;
