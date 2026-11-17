// 用法：node --experimental-strip-types scripts/verify-gateway-loader.mjs
// 网关数据运行时加载（真实模块 src/features/XIT/FTC/gateway-loader.ts）。
// 退出码：0 = 全通过（末行 PASS n/n）；1 = 有失败（FAIL <场景> expected=… actual=…）。
//
// 覆盖：① 已有网关连接 → 直接返回 true，不发请求、不开窗口（零副作用）；
//      ② 无连接 → 直接向服务器发 DATA_GET_DATA{path:['gateways']}（原生星图发的同一条请求），
//         回包即返回 true，且**不打开星图窗口**（这是本回归的核心：曾因开隐藏星图而失败）；
//      ③ socket 未就绪 → 立刻退回开一次隐藏星图（MAP）兜底；
//      ④ 请求发出但没回包 → 等 requestTimeoutMs 后仍退回隐藏星图兜底；
//      ⑤ 超时仍无数据 → 返回 false；
//      ⑥ 冷却期内不重复请求（避免每次输入都打服务器）。
// 局限：不触发真实游戏 socket；回包由替身的 deliverOnRequest / deliverOnOpen 模拟。
import { register } from 'node:module';

register('./lib/gateway-loader-loader.mjs', import.meta.url);

const stub = await import('./lib/gateway-loader-stub.mjs');
const { ensureGatewayConnections } = await import('../src/features/XIT/FTC/gateway-loader.ts');

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

await check('已有网关连接：直接可用，不发请求不开窗口', async failures => {
  stub.stubReset();
  stub.state.connectionCount = 3;
  const ok = await ensureGatewayConnections({ timeoutMs: 0 });
  expectEqual(failures, '返回值', true, ok);
  expectEqual(failures, '请求数', 0, stub.requests.length);
  expectEqual(failures, '窗口数', 0, stub.buffers.length);
});

await check('无连接：直接请求网关数据（不开星图），回包即返回', async failures => {
  stub.stubReset();
  stub.state.deliverOnRequest = true;
  const ok = await ensureGatewayConnections({ timeoutMs: 1000, pollMs: 1, cooldownMs: 0 });
  expectEqual(failures, '返回值', true, ok);
  expectEqual(failures, '窗口数', 0, stub.buffers.length);
  expectEqual(failures, '请求数', 1, stub.requests.length);
  const message = stub.requests[0] ?? {};
  expectEqual(failures, '请求类型', 'DATA_GET_DATA', message.messageType);
  expectEqual(failures, '请求路径', ['gateways'], message.payload?.path);
  expectEqual(failures, '请求上下文', 'ctx-test', message.contextId);
  expectEqual(failures, 'actionId 是 UUID', true, typeof message.payload?.actionId === 'string');
});

await check('socket 未就绪：退回打开隐藏星图兜底', async failures => {
  stub.stubReset();
  stub.state.socketReady = false;
  stub.state.deliverOnOpen = true;
  const ok = await ensureGatewayConnections({ timeoutMs: 1000, pollMs: 1, cooldownMs: 0 });
  expectEqual(failures, '返回值', true, ok);
  expectEqual(
    failures,
    '窗口命令',
    ['MAP'],
    stub.buffers.map(x => x.command),
  );
  expectEqual(failures, '自动关闭', true, stub.buffers[0]?.options?.autoClose);
});

await check('请求发出但没回包：等 requestTimeoutMs 后退回隐藏星图兜底', async failures => {
  stub.stubReset();
  stub.state.deliverOnOpen = true;
  const ok = await ensureGatewayConnections({
    timeoutMs: 1000,
    requestTimeoutMs: 0,
    pollMs: 1,
    cooldownMs: 0,
  });
  expectEqual(failures, '返回值', true, ok);
  expectEqual(failures, '请求数', 1, stub.requests.length);
  expectEqual(
    failures,
    '窗口命令',
    ['MAP'],
    stub.buffers.map(x => x.command),
  );
});

await check('超时仍无数据：返回 false', async failures => {
  stub.stubReset();
  const ok = await ensureGatewayConnections({ timeoutMs: 0, requestTimeoutMs: 0, cooldownMs: 0 });
  expectEqual(failures, '返回值', false, ok);
  expectEqual(failures, '请求数', 1, stub.requests.length);
  expectEqual(
    failures,
    '窗口命令',
    ['MAP'],
    stub.buffers.map(x => x.command),
  );
});

await check('冷却期内不重复请求', async failures => {
  // 上一条用例刚触发过；这里用默认冷却（1 分钟）再调一次。
  const before = stub.requests.length;
  stub.state.connectionCount = 0;
  const ok = await ensureGatewayConnections({ timeoutMs: 0 });
  expectEqual(failures, '返回值', false, ok);
  expectEqual(failures, '请求数不变', before, stub.requests.length);
});

console.log(
  summary.fail === 0
    ? `PASS ${summary.pass}/${summary.pass}`
    : `FAIL ${summary.pass}/${summary.pass + summary.fail}`,
);
process.exitCode = summary.fail === 0 ? 0 : 1;
