import { alertsStore } from '@src/infrastructure/prun-api/data/alerts';
import {
  ALL_NOTIFICATION_TYPES,
  NOTIFICATION_META,
} from '@src/infrastructure/prun-api/data/notification-catalog';
import { exchangesStore } from '@src/infrastructure/prun-api/data/exchanges';
import { materialsStore } from '@src/infrastructure/prun-api/data/materials';
import { shipsStore } from '@src/infrastructure/prun-api/data/ships';
import { getI18nValue } from '@src/infrastructure/prun-ui/i18n';
import { userData } from '@src/store/user-data';
import { watchUntil } from '@src/utils/watch';

// 类型标签与中文事件名统一取自 notification-catalog.ts（全部 69 种），
// 与 XIT DNOT 设置页、游戏内 NOTS 彩色标签共用同一份清单。
const labelMap = new Map<PrunApi.AlertType, string>(
  ALL_NOTIFICATION_TYPES.map(type => [type, NOTIFICATION_META.get(type)!.label]),
);

// ── 工具函数 ──────────────────────────────────────────────────────────────────
function getData(alert: PrunApi.Alert, key: string): unknown {
  return alert.data.find(x => x.key === key)?.value;
}

const EXPERTISE_LABELS: Record<string, string> = {
  AGRICULTURE: '农业',
  CHEMISTRY: '化学',
  CONSTRUCTION: '建筑材料',
  ELECTRONICS: '电子',
  FOOD_INDUSTRIES: '食品工业',
  FUEL_REFINING: '燃料精炼',
  MANUFACTURING: '制造',
  METALLURGY: '冶金',
  RESOURCE_EXTRACTION: '资源开采',
};

function formatAddress(address: PrunApi.Address): string {
  for (const line of address.lines) {
    if (line.type === 'PLANET' || line.type === 'STATION') {
      const entity = (line as PrunApi.PlanetAddressLine | PrunApi.StationAddressLine).entity;
      return entity.name || entity.naturalId;
    }
  }
  // 降级：取第一个有 entity 的行
  for (const line of address.lines) {
    const l = line as PrunApi.UnknownAddressLine;
    if (l.entity) {
      return l.entity.name || l.entity.naturalId;
    }
  }
  return '';
}

// 服务器推送的商品/物料是材料 id（如 drinkingWater），转成玩家熟悉的物料代码（DW）。
function formatMaterial(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value) {
    return undefined;
  }
  return materialsStore.getByName(value)?.ticker ?? value;
}

// exchange 是对象（{ name, code, ... }），旧代码直接插值会得到 [object Object]。
// 这里取交易所代码，并从本地 exchangesStore 补上站点编码（如 IC1（HRT））。
function formatExchange(value: unknown): string | undefined {
  let code: string | undefined;
  if (typeof value === 'string') {
    code = value;
  } else if (value && typeof value === 'object') {
    const exchange = value as { code?: string; name?: string };
    code = exchange.code;
    if (!code) {
      return exchange.name;
    }
  }
  if (!code) {
    return undefined;
  }
  const naturalId = exchangesStore.getNaturalIdFromCode(code);
  return naturalId ? `${code}（${naturalId}）` : code;
}

// COGC 计划名直接复用游戏内置中文文本（CoGCProgram.*），与 COGCPEX 投票界面一致。
// 优先全名（宣传活动：化工 / 教育活动：先驱者），缺失时退回短名，最后才是英文枚举。
function formatCogcProgram(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value) {
    return undefined;
  }
  return (
    getI18nValue(`CoGCProgram.${value}`) ?? getI18nValue(`CoGCProgram.${value}_SHORT`) ?? value
  );
}

// 只取玩家设置的外显船名；绝不回退到应答器代码（registration）。
function resolveShipName(alert: PrunApi.Alert): string | undefined {
  const shipId = getData(alert, 'shipId') as string | undefined;
  const registration = getData(alert, 'registration') as string | undefined;
  const ship =
    (shipId ? shipsStore.getById(shipId) : undefined) ??
    (registration ? shipsStore.getByRegistration(registration) : undefined);
  const name = ship?.name?.trim();
  return name || undefined;
}

// 合同类通知的字段并不统一：有的是 contract 编号，有的只有 partner。
// 统一在这里组装，避免正文里出现空泛的「合同已…」或丢掉对方名。
function contractRef(alert: PrunApi.Alert): string {
  const contract = getData(alert, 'contract') as string | undefined;
  const partner = getData(alert, 'partner') as PrunApi.ContractPartner | undefined;
  const partnerName = partner?.name;
  if (contract && partnerName) {
    return `合同 ${contract}（${partnerName}）`;
  }
  if (contract) {
    return `合同 ${contract}`;
  }
  if (partnerName) {
    return `合同（${partnerName}）`;
  }
  return '合同';
}

function contractAction(alert: PrunApi.Alert, action: string): string {
  const ref = contractRef(alert);
  if (ref === '合同') {
    return `合同${action}`;
  }
  return ref.includes(' ') ? `${ref} ${action}` : `${ref}${action}`;
}

// ── 通知正文格式化 ─────────────────────────────────────────────────────────────
function formatAlertBody(alert: PrunApi.Alert): string {
  switch (alert.type) {
    case 'SHIP_FLIGHT_ENDED': {
      const shipName = resolveShipName(alert);
      const dest = getData(alert, 'destination') as { address: PrunApi.Address } | undefined;
      const destStr = dest ? formatAddress(dest.address) : '';
      if (shipName && destStr) {
        return `舰只 ${shipName} 已到达 ${destStr}`;
      }
      if (shipName) {
        return `舰只 ${shipName} 已到达目的地`;
      }
      return destStr ? `飞船已到达 ${destStr}` : '飞船已到达目的地';
    }
    case 'COMEX_ORDER_FILLED': {
      const commodity = formatMaterial(getData(alert, 'commodity'));
      const exchange = formatExchange(getData(alert, 'exchange'));
      const parts = [commodity && `商品 ${commodity}`, exchange && `交易所 ${exchange}`].filter(
        Boolean,
      );
      return parts.length > 0 ? parts.join('，') + ' — 订单成交' : '商品交易所订单已成交';
    }
    case 'FOREX_ORDER_FILLED': {
      const pair = getData(alert, 'pair') as
        { base?: { code?: string }; quote?: { code?: string } } | undefined;
      const pairStr =
        pair?.base?.code && pair?.quote?.code ? `${pair.base.code}/${pair.quote.code}` : undefined;
      return pairStr ? `外汇 ${pairStr} 订单已成交` : '外汇订单已成交';
    }
    case 'COMEX_TRADE': {
      const commodity = formatMaterial(getData(alert, 'commodity'));
      const trades = getData(alert, 'trades') as number | undefined;
      const exchange = formatExchange(getData(alert, 'exchange'));
      const parts = [
        commodity && `商品 ${commodity}`,
        trades != null && `成交 ${trades} 笔`,
        exchange && `交易所 ${exchange}`,
      ].filter(Boolean);
      return parts.length > 0 ? parts.join('，') + ' — 交易完成' : '商品交易完成';
    }
    case 'FOREX_TRADE':
      return '外汇交易完成';
    case 'PRODUCTION_ORDER_FINISHED': {
      const material = formatMaterial(getData(alert, 'material'));
      const quantity = getData(alert, 'quantity') as number | undefined;
      if (material && quantity != null) {
        return `${material} × ${quantity} 生产完成`;
      }
      if (material) {
        return `${material} 生产完成`;
      }
      return '生产订单已完成';
    }
    case 'CONTRACT_CONDITION_FULFILLED': {
      const partner = getData(alert, 'partner') as PrunApi.ContractPartner | undefined;
      return partner?.name ? `合同条件已完成（${partner.name}）` : '合同条件已完成';
    }
    case 'CONTRACT_CONTRACT_RECEIVED': {
      const contract = getData(alert, 'contract') as string | undefined;
      const partner = getData(alert, 'partner') as PrunApi.ContractPartner | undefined;
      const partnerStr = partner?.name ? `，对方：${partner.name}` : '';
      return `收到合同${contract ? ' ' + contract : ''}${partnerStr}`;
    }
    case 'CONTRACT_CONTRACT_CLOSED':
      // 游戏里这个告警在双方签完字、合同正式生效时发出，中文语境是「签订」，
      // 直译成「关闭」会让人误以为合同被取消。
      return contractAction(alert, '已签订');
    case 'CONTRACT_CONTRACT_BREACHED':
      return contractAction(alert, '已违约！');
    case 'CONTRACT_CONTRACT_CANCELLED':
      return contractAction(alert, '已取消');
    case 'CONTRACT_CONTRACT_TERMINATED':
      return contractAction(alert, '已终止');
    case 'CONTRACT_CONTRACT_TERMINATION_REQUESTED':
      return contractAction(alert, '收到终止请求');
    case 'CONTRACT_DEADLINE_EXCEEDED_WITH_CONTROL':
    case 'CONTRACT_DEADLINE_EXCEEDED_WITHOUT_CONTROL':
      return contractAction(alert, '已超期');
    case 'CONTRACT_CONTRACT_EXTENDED':
      return contractAction(alert, '已延期');
    case 'CONTRACT_CONTRACT_REJECTED':
      return contractAction(alert, '已被拒绝');
    case 'COMEX_PICKUP_CONTRACT_CREATED': {
      const contract = getData(alert, 'contract') as string | undefined;
      const partner = (getData(alert, 'partner') as PrunApi.ContractPartner | undefined)?.name;
      if (contract) {
        return `取货合同 ${contract}${partner ? `（${partner}）` : ''} 已创建`;
      }
      return partner ? `与 ${partner} 的取货合同已创建` : '取货合同已创建';
    }
    case 'WORKFORCE_LOW_SUPPLIES': {
      const addr = getData(alert, 'address') as { address: PrunApi.Address } | undefined;
      const addrStr = addr ? formatAddress(addr.address) : '';
      return addrStr ? `${addrStr} 物资不足` : '物资不足警告';
    }
    case 'WORKFORCE_OUT_OF_SUPPLIES': {
      const addr = getData(alert, 'address') as { address: PrunApi.Address } | undefined;
      const addrStr = addr ? formatAddress(addr.address) : '';
      return addrStr ? `${addrStr} 物资已耗尽！` : '物资已耗尽！';
    }
    case 'WORKFORCE_UNSATISFIED': {
      const addr = getData(alert, 'address') as { address: PrunApi.Address } | undefined;
      const addrStr = addr ? formatAddress(addr.address) : '';
      return addrStr ? `${addrStr} 劳动力不满` : '劳动力不满警告';
    }
    case 'LOCAL_MARKET_AD_ACCEPTED':
      return '本地合同已被接受';
    case 'LOCAL_MARKET_AD_EXPIRED':
      return '本地合同已过期';
    case 'WAREHOUSE_STORE_LOCKED_INSUFFICIENT_FUNDS':
      return '仓库因资金不足被锁定';
    case 'WAREHOUSE_STORE_UNLOCKED':
      return '仓库已解锁';
    case 'CORPORATION_SHAREHOLDER_DIVIDEND_RECEIVED':
      return '收到公司分红';
    case 'CORPORATION_SHAREHOLDER_INVITE_RECEIVED':
      return '收到公司股东邀请';
    case 'CORPORATION_MANAGER_INVITE_ACCEPTED':
      return '公司邀请已被接受';
    case 'CORPORATION_MANAGER_INVITE_REJECTED':
      return '公司邀请已被拒绝';
    case 'CORPORATION_MANAGER_SHAREHOLDER_LEFT':
      return '公司股东已离开';
    case 'CORPORATION_PROJECT_FINISHED':
      return '公司项目已完成';
    case 'SHIPYARD_PROJECT_FINISHED':
      return '造船厂项目已完成';
    case 'PLANETARY_PROJECT_FINISHED':
      return '星球项目已完成';
    case 'INFRASTRUCTURE_PROJECT_COMPLETED':
      return '基础设施项目已完成';
    case 'INFRASTRUCTURE_UPGRADE_COMPLETED':
      return '基础设施升级已完成';
    case 'INFRASTRUCTURE_UPKEEP_PHASE_STARTED':
      return '基础设施维护阶段已开始';
    case 'INFRASTRUCTURE_OPERATIONAL_STATE_CHANGED':
      return '基础设施运行状态变更';
    case 'GATEWAY_LINK_ESTABLISHED':
      return '星门链路已建立';
    case 'GATEWAY_LINK_REQUEST_RECEIVED':
      return '收到星门链路请求';
    case 'GATEWAY_LINK_UNLINKED':
      return '星门链路已断开';
    case 'GATEWAY_JUMP_ABORTED_NO_FUEL':
      return '星门跳跃中止：燃料不足';
    case 'GATEWAY_JUMP_ABORTED_MISSING_FUNDS':
      return '星门跳跃中止：资金不足';
    case 'GATEWAY_JUMP_ABORTED_NO_CAPACITY':
      return '星门跳跃中止：容量不足';
    case 'GATEWAY_JUMP_ABORTED_NOT_OPERATIONAL':
      return '星门跳跃中止：星门未运行';
    case 'GATEWAY_JUMP_ABORTED_LINK_CHANGED':
      return '星门跳跃中止：链路已变更';
    case 'GATEWAY_JUMP_ABORTED_LINK_NOT_ESTABLISHED':
      return '星门跳跃中止：链路未建立';
    case 'SITE_EXPERT_DROPPED': {
      const category = getData(alert, 'expertiseCategory') as string | undefined;
      const planet = getData(alert, 'planet') as { address: PrunApi.Address } | undefined;
      const addr = getData(alert, 'address') as { address: PrunApi.Address } | undefined;
      const catStr = category ? (EXPERTISE_LABELS[category] ?? category) : '';
      const locStr = (planet ?? addr) ? formatAddress((planet ?? addr)!.address) : '';
      const parts = [locStr, catStr].filter(Boolean);
      return parts.length > 0 ? `${parts.join(' ')} 专家通知` : '专家通知';
    }
    case 'POPULATION_PROJECT_UPGRADED':
      return '人口项目已升级';
    case 'POPULATION_REPORT_AVAILABLE':
      return '人口报告已发布';
    case 'COGC_PROGRAM_CHANGED': {
      const program = formatCogcProgram(getData(alert, 'program'));
      const planet = getData(alert, 'planet') as { address: PrunApi.Address } | undefined;
      const addr = getData(alert, 'address') as { address: PrunApi.Address } | undefined;
      const locStr = (planet ?? addr) ? formatAddress((planet ?? addr)!.address) : '';
      const parts = [locStr, program].filter(Boolean);
      return parts.length > 0 ? `COGC 计划变更：${parts.join(' ')}` : 'COGC 计划已变更';
    }
    case 'COGC_STATUS_CHANGED': {
      const planet = getData(alert, 'planet') as { address: PrunApi.Address } | undefined;
      const addr = getData(alert, 'address') as { address: PrunApi.Address } | undefined;
      const locStr = (planet ?? addr) ? formatAddress((planet ?? addr)!.address) : '';
      return locStr ? `${locStr} COGC 状态已变更` : 'COGC 状态已变更';
    }
    case 'COGC_UPKEEP_STARTED': {
      const planet = getData(alert, 'planet') as { address: PrunApi.Address } | undefined;
      const addr = getData(alert, 'address') as { address: PrunApi.Address } | undefined;
      const locStr = (planet ?? addr) ? formatAddress((planet ?? addr)!.address) : '';
      return locStr ? `${locStr} COGC 维护已开始` : 'COGC 维护已开始';
    }
    case 'ADMIN_CENTER_MOTION_VOTING_STARTED':
      return '行政中心动议投票已开始';
    case 'ADMIN_CENTER_MOTION_PASSED':
      return '行政中心动议已通过';
    case 'ADMIN_CENTER_MOTION_ENDED':
      return '行政中心动议已结束';
    case 'ADMIN_CENTER_ELECTION_STARTED':
      return '行政中心选举已开始';
    case 'ADMIN_CENTER_GOVERNOR_ELECTED':
      return '行政中心总督已选出';
    case 'ADMIN_CENTER_NO_GOVERNOR_ELECTED':
      return '行政中心未产生总督';
    case 'ADMIN_CENTER_RUN_SUCCEEDED':
      return '行政中心竞选成功';
    default:
      // 没有专属正文模板的类型也给出中文事件名，避免弹出英文枚举。
      return NOTIFICATION_META.get(alert.type)?.name ?? alert.type;
  }
}

// ── 桌面通知可见文本 ──────────────────────────────────────────────────────────
export interface DesktopNotificationText {
  title: string;
  body: string;
}

export function formatDesktopNotification(alert: PrunApi.Alert): DesktopNotificationText {
  return {
    title: `APEX — ${labelMap.get(alert.type) ?? '通知'}`,
    body: formatAlertBody(alert),
  };
}

// ── 发送桌面通知 ──────────────────────────────────────────────────────────────
function sendDesktopNotification(alert: PrunApi.Alert) {
  if (Notification.permission !== 'granted') {
    return;
  }
  // 白名单模式：只有在 XIT DNOT 中勾选的类型才会推送到桌面。
  if (!userData.settings.desktopNotificationTypes.includes(alert.type)) {
    return;
  }
  const { title, body } = formatDesktopNotification(alert);
  new Notification(title, {
    body,
    tag: `apex-alert-${alert.id}`,
    icon: '/favicon.ico',
    silent: false,
  });
}

// ── 功能入口 ──────────────────────────────────────────────────────────────────
async function init() {
  // 等待通知 store 完成初始加载
  await watchUntil(() => alertsStore.fetched.value);

  // 记录已存在的通知 ID（页面加载时已有的不再弹出）
  const knownIds = new Set<string>(alertsStore.all.value?.map(a => a.id) ?? []);

  // 只有在 XIT DNOT 里至少勾选了一项时才申请站点通知权限，
  // 避免「全关」状态下仍弹出无意义的浏览器权限请求。
  if (
    Notification.permission === 'default' &&
    userData.settings.desktopNotificationTypes.length > 0
  ) {
    await Notification.requestPermission();
  }

  // 监听 store 变化，对新增通知发送桌面提示
  watch(
    () => alertsStore.all.value,
    alerts => {
      if (!alerts || Notification.permission !== 'granted') {
        return;
      }
      for (const alert of alerts) {
        if (!knownIds.has(alert.id)) {
          knownIds.add(alert.id);
          sendDesktopNotification(alert);
        }
      }
    },
  );
}

features.add(import.meta.url, init, 'NOTS：仅把 XIT DNOT 中勾选的通知类型推送到浏览器桌面通知。');
