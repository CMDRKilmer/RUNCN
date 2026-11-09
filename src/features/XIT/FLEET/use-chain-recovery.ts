import { ref, watch } from 'vue';
import { userData } from '@src/store/user-data';
import { shipsStore } from '@src/infrastructure/prun-api/data/ships';
import { getEntityNaturalIdFromAddress } from '@src/infrastructure/prun-api/data/addresses';
import { runProgress, normalizeChainRun } from './chain-run';
import { collectPendingChainSteps, verifyAllChainRuns } from './chain-recovery';
import { runChainStepSilently } from './chain-execution';
import { onApiMessage } from '@src/infrastructure/prun-api/data/api-messages';

// 模块级状态：跨组件实例共享（ChainView 在切换页签时会卸载/重挂载，
// 组件内 let 每实例一份，无法跨实例共享）。
// 自动恢复每个「数据就绪周期」至多执行一次；服务器重连时重置以便再次恢复。
let chainAutoRecovered = false;
// 区分首次连接与重连：首次连接在扩展加载早期触发，先于本面板挂载。
let chainFirstConnect = true;
// 重连提示：由模块级连接监听置位，组件数据就绪时消费并展示。
let chainReconnectNotice = false;

// 服务器重连检测：断联后游戏通常原地重连而非整页刷新，各数据 store 会重置后
// 重新推送。重置自动恢复标志，数据重载完成后自动重新检测环线断线阶段
//（断联期间到港告警可能错过，页面未刷新导致原先的自动恢复不会再次触发）。
onApiMessage({
  CLIENT_CONNECTION_OPENED() {
    if (chainFirstConnect) {
      chainFirstConnect = false;
      return;
    }
    chainAutoRecovered = false;
    chainReconnectNotice = true;
  },
});

export function useChainRecovery(autoRecover: () => boolean) {
  const statusCheckNotice = ref<string>();
  // ── 状态检查（断线恢复） ─────────────────────────────────────
  // 环线运行中若网页关闭，到港触发器（FLIGHT_ENDED 告警事件）错过触发，
  // 重新打开页面后环线会卡在当前阶段。状态检查依据船当前停靠位置与
  // 持久化阶段状态，判断当前阶段并自动执行下一步操作包。
  // 状态检查：自动判断当前阶段并自动处理下一步。
  function onStatusCheckClick() {
    const steps = collectPendingChainSteps();
    if (steps.length === 0) {
      // 诊断：无运行中环线 vs 船已就位但未匹配到可执行阶段。
      // 后一种情况给出每艘船的实际停靠位置与预期阶段，便于核对位置/脚本差异。
      const runs = Object.values(userData.chainRuns).filter(
        r => shipsStore.getById(r.shipId) !== undefined,
      );
      if (runs.length === 0) {
        statusCheckNotice.value =
          '状态检查：未发现需要恢复的环线步骤（无运行中的环线，或船数据未加载完成，可稍后再试）。';
      } else {
        const details = runs.map(run => {
          const ship = shipsStore.getById(run.shipId)!;
          const dockedAt = ship.address ? getEntityNaturalIdFromAddress(ship.address) : undefined;
          const progress = runProgress(run);
          const next = progress.stops.find(s => s.state !== 'done');
          const expected = next ? `${next.planetName}（${next.naturalId}）` : '归航';
          return `${run.shipName}：停靠 ${dockedAt ?? '未知'}，预期 ${expected}`;
        });
        statusCheckNotice.value =
          `状态检查：${runs.length} 艘运行中但无待恢复步骤 —— ` +
          details.join('；') +
          '。请核对停靠位置、货舱与操作包是否一致。';
      }
      return;
    }
    for (const step of steps) {
      runChainStepSilently(step.pkgName);
    }
    statusCheckNotice.value = `状态检查：${steps.length} 个阶段待恢复，已自动执行 —— ${steps
      .map(s => s.label)
      .join('、')}。`;
  }

  // ── 自动恢复（断线自动续跑） ────────────────────────────────
  // 船数据就绪且「自动恢复」开启后运行：扫描运行中的环线，自动执行断线阶段。
  // 服务器重连（页面未自动刷新）时 store 会重置后重新推送；数据就绪时若本次
  // 来自重连（模块级监听置位）则提示用户，并自动再次检测断线阶段。
  watch(
    () => shipsStore.fetched.value,
    fetched => {
      if (!fetched) {
        return;
      }
      // 刷新后脚本一致性校验：未完成阶段的脚本应仍存在；缺失则提示差异，
      // 且不自动恢复（避免执行到错误/被另一端改动的脚本）。
      for (const run of Object.values(userData.chainRuns)) {
        normalizeChainRun(run);
      }
      const { ok, diffs } = verifyAllChainRuns();
      if (!ok) {
        statusCheckNotice.value = `环线脚本差异：${diffs.join('；')}。请检查 ACT/TRIGGER 列表或执行云端同步。`;
        return;
      }
      // 消费重连提示（模块级标志跨实例共享，避免首次连接误报）。
      if (chainReconnectNotice) {
        chainReconnectNotice = false;
        if (autoRecover() && Object.keys(userData.chainRuns).length > 0) {
          statusCheckNotice.value = '检测到服务器重连（页面未自动刷新），自动恢复已重新启用。';
        }
      }
      if (!autoRecover() || chainAutoRecovered) {
        return;
      }
      chainAutoRecovered = true;
      // 刷新后不自动执行第 0 步（出发）：状态显示「未开始」，出发由用户手动触发。
      const steps = collectPendingChainSteps(false);
      if (steps.length === 0) {
        return;
      }
      for (const step of steps) {
        runChainStepSilently(step.pkgName);
      }
      statusCheckNotice.value = `自动恢复：检测到 ${steps.length} 个环线阶段断线，已自动执行 —— ${steps
        .map(s => s.label)
        .join('、')}。`;
    },
    { immediate: true },
  );

  return { statusCheckNotice, onStatusCheckClick };
}
