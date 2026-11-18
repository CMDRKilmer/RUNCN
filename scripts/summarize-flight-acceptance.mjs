// Usage: node scripts/summarize-flight-acceptance.mjs [--segments] [--blind-manifest <manifest.json>] <family> <replay|holdout|blind> <report.json> [...]
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { flightSample } from './lib/flight-acceptance.mjs';
import { readFlightObservations } from './lib/flight-observations.mjs';

const readRows = {
  'same-system': report => Object.values(report).flatMap(route => route.offlineHoldout),
  natural: report => report.rows,
  mixed: report => report.rows,
  gateway: report => report,
};
const groups = new Map();
const missions = new Map();
const models = new Map();
const segmentMode = process.argv[2] === '--segments';
const args = process.argv.slice(segmentMode ? 3 : 2);
const usesBlindManifest = args[0] === '--blind-manifest';
const readJson = path => JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, ''));
let blindManifest;
if (usesBlindManifest) {
  const [, path] = args.splice(0, 2);
  assert(path, '请提供盲测清单路径');
  blindManifest = readBlindManifest(path);
}
assert(args.length > 0 && args.length % 3 === 0, '请按航线类型、样本用途、报告路径传入参数');

function readBlindManifest(path) {
  const { frozenAt, models: frozenModels, sources } = readJson(path);
  const cutoff = Date.parse(frozenAt);
  assert(Number.isFinite(cutoff), '盲测清单缺少有效的模型冻结时间');
  assert(frozenModels && typeof frozenModels === 'object', '盲测清单缺少冻结模型标识');
  assert(Array.isArray(sources) && sources.length > 0, '盲测清单缺少原始采集批次');
  const observations = new Map();
  for (const source of sources) {
    for (const row of readFlightObservations(resolve(dirname(path), source))) {
      const { request, response, blueprint, flightInputs, requestedAt, receivedAt } = row;
      const capturedAt = flightInputs?.capturedAt;
      assert(
        [capturedAt, requestedAt, receivedAt].every(Number.isFinite) &&
          capturedAt > cutoff &&
          capturedAt <= requestedAt &&
          requestedAt <= receivedAt,
        '盲测批次需在模型冻结后完成快照和采集',
      );
      if (row.error !== undefined || response?.status !== 'OK') {
        continue;
      }
      assert(request?.missionId && response.missionId === request.missionId, '试飞任务标识不匹配');
      assert(!observations.has(request.missionId), '原始盲测批次存在重复任务');
      const natural = response.segments.some(segment => segment.type === 'JUMP');
      const gateway = response.segments.some(segment => segment.type === 'JUMP_GATEWAY');
      const family = gateway
        ? natural
          ? 'mixed'
          : 'gateway'
        : natural
          ? 'natural'
          : 'same-system';
      observations.set(request.missionId, { family, ...flightSample(request, blueprint, natural) });
    }
  }
  assert(observations.size > 0, '盲测清单缺少有效原始试飞');
  return { frozenModels, observations };
}

function segmentOutcomes(scores) {
  assert(scores?.length > 0, '报告缺少分段评分');
  const byType = new Map();
  for (const { type, passed } of scores) {
    assert(type && typeof passed === 'boolean', '分段评分不完整');
    byType.set(type, (byType.get(type) ?? true) && passed);
  }
  return [...byType.entries()];
}

for (let i = 0; i < args.length; i += 3) {
  const [family, evidence, path] = args.slice(i, i + 3);
  assert(Object.hasOwn(readRows, family), '无对应验收报告的航线类型');
  assert(['replay', 'holdout', 'blind'].includes(evidence), '无效的样本用途');
  const report = readJson(path);
  for (const {
    missionId,
    configuration,
    arrival,
    model,
    score,
    segmentScores,
    usedArchivedGatewaySnapshot,
  } of readRows[family](report)) {
    assert(missionId && configuration && typeof score?.passed === 'boolean', '报告记录不完整');
    assert(['surface', 'orbit', 'station'].includes(arrival), '请重新生成带到达方式的报告');
    if (evidence === 'blind') {
      assert(blindManifest, '盲测评分需提供 --blind-manifest');
      assert(!usedArchivedGatewaySnapshot, '较早的网关快照仅用于诊断');
      assert(model && model === blindManifest.frozenModels[family], '报告模型与冻结清单不一致');
      const raw = blindManifest.observations.get(missionId);
      assert(
        raw?.family === family && raw.configuration === configuration && raw.arrival === arrival,
        '报告记录与原始盲测数据不一致',
      );
    }
    if (family === 'gateway' || family === 'natural' || family === 'mixed') {
      const currentModel = family === 'mixed' ? (model ?? 'mixed-original') : model;
      assert(currentModel, '报告缺少模型标识');
      assert(
        !models.has(family) || models.get(family) === currentModel,
        '同类航线必须使用同一模型',
      );
      models.set(family, currentModel);
    }
    const key = JSON.stringify([family, configuration, evidence, arrival]);
    const outcomes = segmentMode ? segmentOutcomes(segmentScores) : [[undefined, score.passed]];
    const outcomeRecord = JSON.stringify(outcomes);
    const prior = missions.get(missionId);
    if (prior) {
      assert(
        prior.key === key && prior.outcomeRecord === outcomeRecord,
        '同一任务在报告中的分组或评分冲突',
      );
      continue;
    }
    missions.set(missionId, { evidence, key, outcomeRecord });
    for (const [segment, passed] of outcomes) {
      const groupKey = JSON.stringify([family, configuration, evidence, arrival, segment]);
      const group = groups.get(groupKey) ?? {
        family,
        configuration,
        evidence,
        arrival,
        segment,
        count: 0,
        passing: 0,
      };
      group.count++;
      group.passing += Number(passed);
      groups.set(groupKey, group);
    }
  }
}

if (blindManifest) {
  for (const { missionId } of blindManifest.observations.values()) {
    const evaluated = missions.get(missionId);
    assert(evaluated?.evidence === 'blind', '有效原始盲测试飞缺少评分');
  }
}

const results = [...groups.values()].map(group => ({
  ...group,
  passingRate: group.passing / group.count,
  qualifies:
    group.evidence === 'blind' &&
    group.count >= 40 &&
    group.passing >= Math.ceil(0.95 * group.count),
}));
console.log(JSON.stringify(results, null, 2));
