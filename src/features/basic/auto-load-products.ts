// BSN「产物」自动装船：某基地有船停靠时，把该基地在 XIT BSN 产物列里登记的
// 最终产出品，从基地仓库静默搬到这条船的货舱。
//
// 全部数据来自游戏本地推送（sitesStore / shipsStore / storagesStore），
// 不连 FIO、不读任何账号硬编码。执行走插件已有的 ACT 静默操作包机制：
// 生成一个只含 MTRA 的一次性包，queueTriggerRun + 隐藏窗口自动执行，
// 与 trigger-engine / FLEET 到港卸货同一套流程。
//
// 默认关闭，开关位于 XIT SET → 功能页的「功能性开关」区。
import { getBaseProducts } from '@src/core/base-products';
import { shipsAtBaseMap } from '@src/core/base-ship-map';
import { getEntityNaturalIdFromAddress } from '@src/infrastructure/prun-api/data/addresses';
import { shipsStore } from '@src/infrastructure/prun-api/data/ships';
import { sitesStore } from '@src/infrastructure/prun-api/data/sites';
import { storagesStore } from '@src/infrastructure/prun-api/data/storage';
import { showBuffer } from '@src/infrastructure/prun-ui/buffers';
import { getPackageFinished, queueTriggerRun } from '@src/features/XIT/ACT/trigger-queue';
import { userData } from '@src/store/user-data';

// 同一艘船两次尝试的最小间隔：生产是持续的，避免库存每次微调就重开一个 ACT 窗口。
const COOLDOWN_MS = 60_000;
// ACT 窗口超时兜底：极端情况下窗口没打开 / 没回报完成，不能让 running 永久卡住。
const RUN_TIMEOUT_MS = 120_000;
const PKG_PREFIX = 'AUTOLOAD';

interface Attempt {
  at: number;
  signature: string;
}

const running = new Set<string>();
const attempts = new Map<string, Attempt>();

function isEnabled() {
  return userData.settings.autoLoadProducts?.enabled === true;
}

// shipsAtBaseMap 的 key 是小写星球编码，sitesStore 的索引保留原始大小写，
// 这里统一按小写比对，避免大小写差异导致匹配不上。
function findSite(naturalId: string): PrunApi.Site | undefined {
  for (const site of sitesStore.all.value ?? []) {
    const id = getEntityNaturalIdFromAddress(site.address);
    if (id !== undefined && id.toLowerCase() === naturalId) {
      return site;
    }
  }
  return undefined;
}

function baseStoreOf(siteId: string) {
  return storagesStore.getByAddressableId(siteId)?.find(x => x.type === 'STORE');
}

function cargoStoreOf(shipId: string) {
  return storagesStore.getByAddressableId(shipId)?.find(x => x.type === 'SHIP_STORE');
}

/** 只搬产物列里登记、且基地仓库当前确有库存的 ticker。 */
function collectProducts(baseStore: PrunApi.Store, products: string[]): Record<string, number> {
  const wanted = new Set(products.map(x => x.toUpperCase()));
  const result: Record<string, number> = {};
  for (const item of baseStore.items) {
    const quantity = item.quantity;
    if (!quantity) {
      continue;
    }
    const ticker = quantity.material.ticker.toUpperCase();
    const amount = quantity.amount ?? 0;
    if (amount > 0 && wanted.has(ticker)) {
      result[ticker] = amount;
    }
  }
  return result;
}

function isCargoFull(cargo: PrunApi.Store) {
  const capacity = cargo.weightCapacity ?? 0;
  // 留 2% 余量：接近满载就不再尝试，避免 MTRA 每轮都 clamp 成 0 空跑。
  return capacity > 0 && cargo.weightLoad >= capacity * 0.98;
}

function stageAndRun(
  registration: string,
  fromId: string,
  toId: string,
  materials: Record<string, number>,
  signature: string,
  now: number,
) {
  const pkgName = `${PKG_PREFIX} ${registration}`;
  const pkg: UserData.ActionPackageData = {
    global: { name: pkgName },
    // 执行成功后由 ExecuteActionPackage 自动删除，不在 ACT 列表里留垃圾。
    autoDelete: true,
    groups: [{ type: 'Manual', name: '产物', materials }],
    actions: [
      {
        type: 'MTRA',
        name: '装船',
        group: '产物',
        // deserializeStorage 优先按 store id 直解析，不受基地/飞船改名影响。
        origin: fromId,
        dest: toId,
      },
    ],
  };
  const existing = userData.actionPackages.findIndex(x => x.global.name === pkgName);
  if (existing >= 0) {
    userData.actionPackages[existing] = pkg;
  } else {
    userData.actionPackages.push(pkg);
  }

  const finished = getPackageFinished(pkgName);
  finished.value = false;
  running.add(registration);
  attempts.set(registration, { at: now, signature });

  // 与 trigger-engine.execute(silent) 完全相同的静默执行范式：
  // 队列让 ACT 窗口自动开跑，autoClose + closeWhen 让窗口跑完自动消失。
  queueTriggerRun({ triggerId: 'auto-load-products', packageName: pkgName });
  void showBuffer(`XIT ACT_${pkgName.split(' ').join('_')}`, {
    force: true,
    autoClose: true,
    closeWhen: computed(() => finished.value),
  });

  const stop = watch(finished, value => {
    if (value) {
      running.delete(registration);
      stop();
    }
  });
  window.setTimeout(() => {
    running.delete(registration);
    stop();
  }, RUN_TIMEOUT_MS);
}

function runDetection() {
  try {
    if (!isEnabled()) {
      return;
    }
    const now = Date.now();
    const stillDocked = new Set<string>();
    for (const [naturalId, registrations] of Object.entries(shipsAtBaseMap.value)) {
      const site = findSite(naturalId);
      if (!site) {
        continue;
      }
      const products = getBaseProducts(site.siteId);
      // 没在 BSN 产物列里登记的基地一律不动，避免误搬生产原料/消耗品。
      if (products === undefined || products.length === 0) {
        continue;
      }
      const baseStore = baseStoreOf(site.siteId);
      if (!baseStore) {
        continue;
      }
      const materials = collectProducts(baseStore, products);
      if (Object.keys(materials).length === 0) {
        continue;
      }
      for (const registration of registrations) {
        stillDocked.add(registration);
        if (running.has(registration)) {
          continue;
        }
        const ship = shipsStore.getByRegistration(registration);
        if (!ship) {
          continue;
        }
        const cargo = cargoStoreOf(ship.id);
        if (!cargo || isCargoFull(cargo)) {
          continue;
        }
        // 指纹 = 船 + 基地 + 当前可搬清单 + 货舱载重；状态不变就不重复搬。
        const signature = [
          registration,
          naturalId,
          JSON.stringify(materials),
          cargo.weightLoad,
        ].join('|');
        const previous = attempts.get(registration);
        if (previous?.signature === signature) {
          continue;
        }
        if (previous && now - previous.at < COOLDOWN_MS) {
          continue;
        }
        stageAndRun(registration, baseStore.id, cargo.id, materials, signature, now);
      }
    }
    // 船已离港 / 不再有产物：清掉本地记录，下次重新靠港时能立刻触发。
    for (const registration of attempts.keys()) {
      if (!stillDocked.has(registration)) {
        attempts.delete(registration);
      }
    }
  } catch {
    // watcher 吞错，不中断后续检测（与 auto-refuel 一致）。
  }
}

// 供检测用的组合签名：停靠关系、库存内容、产物配置、开关任一变化都重新检测。
function detectionSignature() {
  const stores = (storagesStore.all.value ?? [])
    .filter(x => x.type === 'STORE' || x.type === 'SHIP_STORE')
    .map(x =>
      [
        x.id,
        x.weightLoad,
        x.items
          .map(item =>
            item.quantity ? `${item.quantity.material.ticker}:${item.quantity.amount ?? 0}` : '',
          )
          .join(','),
      ].join('~'),
    )
    .join('\n');
  return [
    JSON.stringify(shipsAtBaseMap.value),
    JSON.stringify(userData.baseProducts),
    stores,
    isEnabled() ? 'on' : 'off',
  ].join('||');
}

function init() {
  runDetection();
  watch(detectionSignature, runDetection);
}

features.add(
  import.meta.url,
  init,
  'BSN 产物自动装船：基地有船停靠时，把该基地产物列的最终产出品静默搬进船货舱（开关在 XIT ABCC 面板 XIT FLT 标题栏右侧）。',
  true,
);
