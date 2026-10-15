// PrUn 服务器直连采集器（2026-10-14）
//
// 协议（已实测打通）：
//   1. EIO polling handshake  GET  ...?EIO=4&transport=polling          -> 0{"sid":...}
//   2. 必须回传 INGRESSCOOKIE（ingress 粘性会话），否则 400 Session ID unknown
//   3. socket.io CONNECT      POST body "40"                             -> 200 "ok"
//   4. 长轮询 GET             收到 40{"sid":...} + 42["event",{SERVER_CONNECTION_OPENED}]
//   5. 业务请求               POST body '42["message",{...}]'
//   6. 响应                   42["event",{messageType:"ACTION_COMPLETED",payload:{messageType:"SHIP_FLIGHT_MISSION",...}}]
//
// ⚠️ 全流程**不需要 cookie**（至少连接与计算请求不需要）—— 实测匿名可用。
//    曾误判为"认证问题"，实为 CONNECT 包写错（写了 440，正解 40）。

import { encodePayload, decodePayload } from 'engine.io-parser';
import { Encoder, PacketType } from 'socket.io-parser';

const BASE = 'https://apex.prosperousuniverse.com/socket.io/';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) PrUn-DirectCollect/0.1';
const SEP = String.fromCharCode(30); // EIO payload 记录分隔符

// ---- 已知常量（取自实机导出 / 生产代码）----
const BLUEPRINT_ID = '75c5ef2bd7839f83bb649c88abf7003f'; // BP-FRVZ-6104 (uuid)
const ORIGIN = 'f2f57766ebaca9d69efae41ccf4d8853|PLA,89ef328fe940baf271b2b6ca73cae335'; // VH-331g
const DEST = 'f2f57766ebaca9d69efae41ccf4d8853|PLA,51b2df4f33c14a8e0ea3280520a5ad5e'; // VH-331e

function headers(cookie) {
  const h = {
    'User-Agent': UA,
    Origin: 'https://apex.prosperousuniverse.com',
    Referer: 'https://apex.prosperousuniverse.com/',
  };
  if (cookie) h.Cookie = cookie;
  return h;
}

async function createSession(userCookie) {
  const jar = new Map();
  const absorb = res => {
    const raw = res.headers.getSetCookie?.() ?? [];
    for (const c of raw) {
      const [pair] = c.split(';');
      const i = pair.indexOf('=');
      if (i > 0) jar.set(pair.slice(0, i).trim(), pair.slice(i + 1).trim());
    }
  };
  const cookieHeader = extra => {
    const parts = [];
    if (userCookie) parts.push(userCookie);
    if (jar.size) parts.push([...jar].map(([k, v]) => k + '=' + v).join('; '));
    if (extra) parts.push(extra);
    return parts.join('; ');
  };

  // 1. handshake
  const hr = await fetch(BASE + '?EIO=4&transport=polling&t=' + Date.now(), { headers: headers(userCookie) });
  absorb(hr);
  const hb = await hr.text();
  const sid = JSON.parse(hb.slice(1)).sid;

  const url = () => BASE + '?EIO=4&transport=polling&t=' + Date.now() + '&sid=' + encodeURIComponent(sid);
  const post = async body => {
    const r = await fetch(url(), {
      method: 'POST',
      headers: { ...headers(userCookie), Cookie: cookieHeader(), 'Content-Type': 'text/plain;charset=UTF-8' },
      body,
    });
    absorb(r);
    return { status: r.status, text: await r.text() };
  };
  // ⚠️ 不要频繁 abort 长轮询 —— 实测 abort 会让服务端判定客户端消失，
  // 后续 POST 直接 400 {"code":1,"message":"Session ID unknown"}（会话已死）。
  // 服务器 pingInterval=15s，所以给 25s：正常情况下服务器会先发 ping 返回。
  const poll = async (timeoutMs = 25000) => {
    const ac = new AbortController();
    const to = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const r = await fetch(url(), { headers: { ...headers(userCookie), Cookie: cookieHeader() }, signal: ac.signal });
      absorb(r);
      return { status: r.status, text: await r.text() };
    } catch (e) {
      return { status: 0, text: '', error: e.name === 'AbortError' ? 'timeout' : String(e) };
    } finally { clearTimeout(to); }
  };

  // 2. socket.io CONNECT
  const enc = new Encoder();
  const sioConnect = enc.encode({ type: PacketType.CONNECT, nsp: '/', data: undefined })[0];
  let connectEio;
  encodePayload([{ type: 'message', data: sioConnect }], d => { connectEio = d; });
  const cr = await post(connectEio);
  if (cr.status !== 200) throw new Error('CONNECT failed: ' + cr.status + ' ' + cr.text.slice(0, 120));

  return { sid, post, poll, enc, cookieHeader, userCookie };
}

// 解析一次下行 payload，返回 { eioType, sioEvent, data } 列表
function parseFrames(text) {
  const out = [];
  const clean = text.replace(/^\d+:/, ''); // 某些 framing 前缀
  for (const chunk of clean.split(SEP)) {
    if (!chunk) continue;
    const t = chunk[0];
    const rest = chunk.slice(1);
    if (t === '2') { out.push({ eio: 'ping' }); continue; }
    if (t === '6') { out.push({ eio: 'noop' }); continue; }
    if (t === '1') { out.push({ eio: 'close' }); continue; }
    if (t === '4') {
      // socket.io packet 在 rest 里
      const st = rest[0];
      let data;
      try { data = JSON.parse(rest.slice(1)); } catch { data = rest.slice(1); }
      out.push({ eio: 'message', sioType: st, data });
      continue;
    }
    out.push({ eio: 'other', raw: chunk.slice(0, 80) });
  }
  return out;
}

function logFrame(f) {
  if (f.eio === 'message') {
    const ev = Array.isArray(f.data) ? f.data[0] : undefined;
    const payload = Array.isArray(f.data) ? f.data[1] : undefined;
    const inner = payload?.payload?.messageType ?? payload?.messageType;
    console.log('    sio=' + f.sioType + ' event=' + JSON.stringify(ev) + (inner ? ' messageType=' + inner : ''));
    return { ev, payload };
  }
  console.log('    eio=' + f.eio + (f.raw ? ' raw=' + f.raw : ''));
  return {};
}

async function requestFlight(s, opts) {
  const missionId = crypto.randomUUID();
  const msg = {
    actionId: crypto.randomUUID(),
    contextId: opts.contextId ?? '',
    messageType: 'SHIP_FLIGHT_CALCULATE_TEST_FLIGHT',
    payload: {
      missionId,
      blueprintId: BLUEPRINT_ID,
      origin: ORIGIN,
      destination: DEST,
      landing: true,
      fuelUsageFactor: opts.f,
      reactorUsageFactor: 0.6510416666666667,
      payload: 0,
      condition: 1,
      stlFuel: opts.stlFuel,
      ftlFuel: 300,
      preferences: { ftlPreference: 'LEAST_JUMPS', useGateways: true },
    },
  };
  let body;
  encodePayload([{ type: 'message', data: s.enc.encode({ type: PacketType.EVENT, nsp: '/', data: ['message', msg] })[0] }], d => { body = d; });
  const pr = await s.post(body);
  console.log('    → POST status=' + pr.status + ' body=' + JSON.stringify(pr.text.slice(0, 120)));

  // 轮询直到拿到本 missionId 的响应
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    const r = await s.poll(6000);
    if (r.error === 'timeout') continue;
    for (const f of parseFrames(r.text)) {
      if (f.eio === 'ping') { await s.post('3'); continue; }
      if (f.eio === 'close') return { error: 'server closed session' };
      if (f.eio !== 'message') continue;
      const d = f.data;
      const payload = Array.isArray(d) ? d[1] : undefined;
      if (!payload) continue;
      // ACTION_COMPLETED 里再包一层
      const inner = payload.payload ?? payload;
      const type = payload.messageType === 'ACTION_COMPLETED' ? (inner.messageType ?? inner?.payload?.messageType) : payload.messageType;
      const plan = payload.messageType === 'ACTION_COMPLETED' ? (inner.payload ?? inner) : payload;
      if (type === 'SHIP_FLIGHT_MISSION' && plan?.missionId === missionId) return { plan };
      if (type === 'ACTION_ERROR' || payload.messageType === 'ACTION_ERROR') return { error: JSON.stringify(payload).slice(0, 300) };
      console.log('    (其它消息 ' + (type ?? '?') + ')');
    }
  }
  return { error: 'timeout 20s' };
}

// ---- 通用：发一条业务消息并等待匹配的响应 ----
async function sendAndWait(s, msg, match, label, timeoutMs = 15000) {
  let body;
  encodePayload([{ type: 'message', data: s.enc.encode({ type: PacketType.EVENT, nsp: '/', data: ['message', msg] })[0] }], d => { body = d; });
  const pr = await s.post(body);
  console.log('    → POST ' + label + ' status=' + pr.status + ' body=' + JSON.stringify(pr.text.slice(0, 100)));
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const r = await s.poll(5000);
    if (r.error === 'timeout') { process.stdout.write('.'); continue; }
    for (const f of parseFrames(r.text)) {
      if (f.eio === 'ping') { await s.post('3'); continue; }
      if (f.eio === 'close') return { error: 'closed' };
      if (f.eio !== 'message') continue;
      const payload = Array.isArray(f.data) ? f.data[1] : undefined;
      if (!payload) continue;
      const inner = payload.messageType === 'ACTION_COMPLETED' ? payload.payload : payload;
      const type = inner?.messageType ?? payload.messageType;
      console.log('    ← ' + (type ?? JSON.stringify(payload).slice(0, 80)));
      const hit = match(type, inner, payload);
      if (hit) return { hit };
    }
  }
  return { error: 'timeout' };
}

// ================= 主流程 =================
const userCookie = process.env.PRUN_COOKIE || undefined;
console.log('=== PrUn 直连采集探测 ===');
console.log('cookie: ' + (userCookie ? '已提供(' + userCookie.length + ' 字符)' : '未提供（匿名）'));
console.log('contextId: ' + (process.env.PRUN_CONTEXT_ID || '(空)'));

const s = await createSession(userCookie);
console.log('sid=' + s.sid);

// 连上后**立即**发飞行请求（不给会话因长轮询空闲而死的机会）
console.log('\n>>> SHIP_FLIGHT_CALCULATE_TEST_FLIGHT (f=0.05, stlFuel=1500)');
const missionId = crypto.randomUUID();
const msg = {
  actionId: crypto.randomUUID(),
  contextId: process.env.PRUN_CONTEXT_ID ?? '',
  messageType: 'SHIP_FLIGHT_CALCULATE_TEST_FLIGHT',
  payload: {
    missionId,
    blueprintId: BLUEPRINT_ID,
    origin: ORIGIN,
    destination: DEST,
    landing: true,
    fuelUsageFactor: 0.05,
    reactorUsageFactor: 0.6510416666666667,
    payload: 0,
    condition: 1,
    stlFuel: 1500,
    ftlFuel: 300,
    preferences: { ftlPreference: 'LEAST_JUMPS', useGateways: true },
  },
};
let body;
encodePayload([{ type: 'message', data: s.enc.encode({ type: PacketType.EVENT, nsp: '/', data: ['message', msg] })[0] }], d => { body = d; });
const pr = await s.post(body);
console.log('POST status=' + pr.status + ' body=' + JSON.stringify(pr.text.slice(0, 120)));

const deadline = Date.now() + 60000;
let got = null;
while (Date.now() < deadline && !got) {
  const r = await s.poll(25000);
  if (r.error === 'timeout') { process.stdout.write('.'); continue; }
  if (r.status === 400) { console.log('\n✗ 会话 400: ' + r.text.slice(0, 120)); break; }
  for (const f of parseFrames(r.text)) {
    if (f.eio === 'ping') { await s.post('3'); process.stdout.write('p'); continue; }
    if (f.eio === 'close') { console.log('\n✗ 服务器 CLOSE'); break; }
    if (f.eio !== 'message') { console.log('\n  eio=' + f.eio + ' raw=' + (f.raw ?? '')); continue; }
    const payload = Array.isArray(f.data) ? f.data[1] : undefined;
    if (!payload) continue;
    const isCompleted = payload.messageType === 'ACTION_COMPLETED';
    const inner = isCompleted ? payload.payload : payload;
    const type = inner?.messageType ?? payload.messageType;
    console.log('\n  ← ' + type + (isCompleted ? ' (in ACTION_COMPLETED)' : ''));
    if (type === 'SHIP_FLIGHT_MISSION' || type === 'ACTION_ERROR') got = { type, inner };
    else console.log('     ' + JSON.stringify(inner).slice(0, 200));
  }
}

if (!got) {
  console.log('\n\n✗ 60s 内没有响应。业务请求被静默丢弃 => 需要认证/contextId。');
} else if (got.type === 'ACTION_ERROR') {
  console.log('\nACTION_ERROR: ' + JSON.stringify(got.inner).slice(0, 400));
} else {
  const plan = got.inner.payload ?? got.inner;
  console.log('\n✓ FlightPlan segments=' + (plan.segments?.length ?? '?'));
  for (const seg of plan.segments ?? []) {
    const secs = ((seg.arrival?.timestamp ?? 0) - (seg.departure?.timestamp ?? 0)) / 1000;
    console.log('   ' + String(seg.type).padEnd(12) + ' secs=' + String(Math.round(secs)).padStart(7) +
      ' stlKm=' + String(Math.round(seg.stlDistance ?? 0)).padStart(12) +
      ' stlFuel=' + String(seg.stlFuelConsumption ?? 0).padStart(6));
  }
}
console.log('\n[结束] 未改动生产代码；未写数据文件。');
