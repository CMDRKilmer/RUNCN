import NX from '@src/features/XIT/NX/NX.vue';
import { userData } from '@src/store/user-data';
import { storagesStore } from '@src/infrastructure/prun-api/data/storage';
import { warehousesStore } from '@src/infrastructure/prun-api/data/warehouses';
import { buyFuel, EXCHANGE_CODES, getAmountOf, getCxStore } from '@src/features/XIT/NX/nx-utils';

xit.add({
  command: 'NX',
  name: '快捷买油',
  description:
    '显示四大交易所空间站（ANT/BEN/HRT/MOR）仓库油量，一键补油到目标；自动补油开关位于 XIT TRIGGER。',
  component: () => NX,
  bufferSize: [680, 340],
});

// 自动补油：仓库油量低于目标则自动购买补足。
// lastBoughtAt 冷却防止库存推送延迟导致同一 ticker 在短时间内重复下单。
const cooldownMs = 20_000;
const lastBoughtAt = new Map<string, number>();

async function runAutoBuy() {
  const nx = userData.settings.nx;
  if (!nx?.enabled) {
    return;
  }
  for (const code of EXCHANGE_CODES) {
    const targets = nx.targets?.[code];
    if (targets === undefined) {
      continue;
    }
    const store = getCxStore(code);
    for (const ticker of ['SF', 'FF'] as const) {
      const target = targets[ticker.toLowerCase() as 'sf' | 'ff'];
      if (target <= 0) {
        continue;
      }
      const current = getAmountOf(store, ticker);
      if (current >= target) {
        continue;
      }
      const key = `${code}|${ticker}`;
      if (Date.now() - (lastBoughtAt.get(key) ?? 0) < cooldownMs) {
        continue;
      }
      console.log(`[NX] ${code} ${ticker} 当前 ${current} < 目标 ${target}，开始补油`);
      const result = await buyFuel(code, ticker, target - current);
      console.log(`[NX] ${code} ${ticker}: ${result.ok ? '成功' : '失败'} - ${result.msg}`);
      if (result.ok) {
        lastBoughtAt.set(key, Date.now());
      }
    }
  }
}

function init() {
  // 事件驱动：数据就绪、开关、目标或四大仓库 SF/FF 油量任一变化即检测补油。
  // 相比轮询：油量一变立即检测（无 5 秒延迟），且只在相关数据变化时唤醒，开销更小，
  // 因此无需 2 分钟窗口限制，监听随页面会话常驻。
  let running = false;

  async function run() {
    if (running) {
      return;
    }
    if (!storagesStore.fetched.value || !warehousesStore.fetched.value) {
      return;
    }
    if (!userData.settings.nx?.enabled) {
      return;
    }
    running = true;
    try {
      await runAutoBuy();
    } catch (error) {
      console.error('[NX] 自动补油失败', error);
    } finally {
      running = false;
    }
  }

  // 指纹：数据就绪 + 开关 + 目标 + 四大仓库当前油量，任一变化即触发检测。
  watch(
    () => {
      const fetched = storagesStore.fetched.value && warehousesStore.fetched.value;
      const enabled = userData.settings.nx?.enabled ?? false;
      const targets = EXCHANGE_CODES.map(code => {
        const t = userData.settings.nx?.targets?.[code];
        return `${t?.sf ?? 0}|${t?.ff ?? 0}`;
      }).join(',');
      const amounts = EXCHANGE_CODES.map(code => {
        const store = getCxStore(code);
        return `${getAmountOf(store, 'SF')}|${getAmountOf(store, 'FF')}`;
      }).join(',');
      return `${fetched}|${enabled}|${targets}|${amounts}`;
    },
    () => {
      void run();
    },
    { immediate: true },
  );
}

features.add(
  import.meta.url,
  init,
  'NX：开启自动补油后，实时监听四大空间站仓库油量，低于目标自动购买。',
);
