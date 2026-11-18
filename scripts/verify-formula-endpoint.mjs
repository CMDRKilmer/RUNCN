// 用法：node --experimental-strip-types scripts/verify-formula-endpoint.mjs
// 公式模型端点解析（真实模块 src/features/XIT/FTC/formula-endpoint.ts）。
// 退出码：0 = 全通过（末行 PASS n/n）；1 = 有失败（FAIL <场景> expected=… actual=…）。
//
// 覆盖（8 个场景）：
//   ① 行星 naturalId 直接解析（不做任何反查）；
//   ② 空间站 naturalId 直接解析；
//   ③ **星系 id → 唯一空间站**：SFC 把空间站目的地规范化成星系 id（VH-331），公式模型回推 HRT；
//   ④ 星系 id 根本查不到时同样走反查，结果是解析失败而不是静默通过；
//   ⑤ 同星系多站 → 报错列出候选，绝不猜；
//   ⑥ 星系无站 / 无法解析 → 给出可操作错误；
//   ⑦ 同一 naturalId 只向游戏查询一次（地址缓存）；
//   ⑧ 空输入直接拒绝。
// 局限：地址解析与反查由替身注入（真实 NOMENCLATURE 查询与站点表由其它脚本覆盖）。
import { register } from 'node:module';

register('./lib/formula-endpoint-loader.mjs', import.meta.url);

const stub = await import('./lib/formula-endpoint-stub.mjs');
const { resolveFormulaEndpoint } = await import('../src/features/XIT/FTC/formula-endpoint.ts');

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

async function expectThrows(failures, label, promise, expectedFragment) {
  try {
    await promise;
    failures.push(`${label} expected=抛出异常 actual=正常返回`);
  } catch (e) {
    const text = e instanceof Error ? e.message : String(e);
    if (!text.includes(expectedFragment)) {
      failures.push(`${label} expected=含「${expectedFragment}」 actual=${text}`);
    }
  }
}

function prepare() {
  stub.stubReset();
  // 行星：VH-874b（起点）
  stub.stubSetAddress('VH-874B', stub.address('VH-874', 'PLANET', 'VH-874b'));
  // 空间站：HRT（VH-331 的唯一站点）
  stub.stubSetAddress('HRT', stub.address('VH-331', 'STATION', 'HRT'));
  // 星系 id 本身能解析出「只有 SYSTEM 行」的地址（真实 NOMENCLATURE 的行为之一）
  stub.stubSetAddress('VH-331', stub.starOnlyAddress('VH-331'));
  stub.stubSetStations('VH-331', ['HRT']);
}

await check('行星直接解析，不做反查', async failures => {
  prepare();
  const endpoint = await resolveFormulaEndpoint('vh-874b ');
  expectEqual(failures, 'naturalId', 'VH-874b', endpoint.naturalId);
  expectEqual(failures, 'systemId', 'VH-874', endpoint.systemId);
  expectEqual(failures, 'encoded', 'id-VH-874|PLA,id-VH-874b', endpoint.encoded);
  expectEqual(failures, '未触发反查查询', ['VH-874B'], stub.state.resolveCalls);
});

await check('空间站直接解析', async failures => {
  prepare();
  const endpoint = await resolveFormulaEndpoint('HRT');
  expectEqual(failures, 'naturalId', 'HRT', endpoint.naturalId);
  expectEqual(failures, 'systemId', 'VH-331', endpoint.systemId);
  expectEqual(failures, 'encoded', 'id-VH-331|STA,id-HRT', endpoint.encoded);
});

await check('星系 id（SFC 规范化后的目的地）→ 回推唯一空间站', async failures => {
  prepare();
  const endpoint = await resolveFormulaEndpoint('VH-331');
  expectEqual(failures, 'naturalId', 'HRT', endpoint.naturalId);
  expectEqual(failures, 'systemId', 'VH-331', endpoint.systemId);
  expectEqual(failures, 'encoded', 'id-VH-331|STA,id-HRT', endpoint.encoded);
});

await check('星系 id 完全查不到时也走反查（解析为空）', async failures => {
  prepare();
  stub.state.addresses.delete('VH-331');
  const endpoint = await resolveFormulaEndpoint('VH-331');
  expectEqual(failures, 'naturalId', 'HRT', endpoint.naturalId);
});

await check('同星系多站：报错列出候选，绝不猜', async failures => {
  prepare();
  stub.stubSetStations('VH-331', ['HRT', 'ZZZ']);
  await expectThrows(
    failures,
    '多站',
    resolveFormulaEndpoint('VH-331'),
    '是星系且有多个空间站（HRT、ZZZ）',
  );
});

await check('星系无站点 / 无法解析：给出可操作错误', async failures => {
  prepare();
  stub.stubSetStations('VH-331', []);
  await expectThrows(
    failures,
    '无站',
    resolveFormulaEndpoint('VH-331'),
    '无法解析 VH-331：请填写具体行星或空间站代号',
  );
  await expectThrows(failures, '乱填', resolveFormulaEndpoint('NOPE'), '无法解析 NOPE');
});

await check('地址缓存：同一 naturalId 只查询一次', async failures => {
  prepare();
  // 用未出现过的 id，避免前面的用例已经把它写进缓存。
  stub.stubSetAddress('VH-999A', stub.address('VH-999', 'PLANET', 'VH-999a'));
  await resolveFormulaEndpoint('VH-999a');
  await resolveFormulaEndpoint('VH-999A ');
  expectEqual(failures, '查询次数', 1, stub.state.resolveCalls.length);
  expectEqual(failures, '查询的键', ['VH-999A'], stub.state.resolveCalls);
});

await check('空输入直接拒绝', async failures => {
  prepare();
  await expectThrows(failures, '空串', resolveFormulaEndpoint('   '), '请输入起点和终点');
  expectEqual(failures, '未查询', 0, stub.state.resolveCalls.length);
});

console.log(
  summary.fail === 0
    ? `PASS ${summary.pass}/${summary.pass}`
    : `FAIL ${summary.pass}/${summary.pass + summary.fail}`,
);
process.exitCode = summary.fail === 0 ? 0 : 1;
