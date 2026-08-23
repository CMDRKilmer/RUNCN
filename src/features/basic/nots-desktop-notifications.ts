import { alertsStore } from '@src/infrastructure/prun-api/data/alerts';
import { userData } from '@src/store/user-data';
import { watchUntil } from '@src/utils/watch';

// ── 类型标签映射（与 nots-notification-type-label 保持一致）────────────────
const labelMap = new Map<PrunApi.AlertType, string>([
  ['ADMIN_CENTER_MOTION_ENDED', '动议'],
  ['ADMIN_CENTER_MOTION_PASSED', '动议'],
  ['ADMIN_CENTER_MOTION_VOTING_STARTED', '动议'],
  ['ADMIN_CENTER_ELECTION_STARTED', '选举'],
  ['ADMIN_CENTER_GOVERNOR_ELECTED', '选举'],
  ['ADMIN_CENTER_NO_GOVERNOR_ELECTED', '选举'],
  ['ADMIN_CENTER_RUN_SUCCEEDED', '选举'],
  ['CONTRACT_CONDITION_FULFILLED', '合同'],
  ['CONTRACT_CONTRACT_BREACHED', '合同'],
  ['CONTRACT_CONTRACT_CANCELLED', '合同'],
  ['CONTRACT_CONTRACT_CLOSED', '合同'],
  ['CONTRACT_CONTRACT_EXTENDED', '合同'],
  ['CONTRACT_CONTRACT_RECEIVED', '合同'],
  ['CONTRACT_CONTRACT_REJECTED', '合同'],
  ['CONTRACT_CONTRACT_TERMINATED', '合同'],
  ['CONTRACT_CONTRACT_TERMINATION_REQUESTED', '合同'],
  ['CONTRACT_DEADLINE_EXCEEDED_WITH_CONTROL', '合同'],
  ['CONTRACT_DEADLINE_EXCEEDED_WITHOUT_CONTROL', '合同'],
  ['COMEX_PICKUP_CONTRACT_CREATED', '合同'],
  ['COMEX_ORDER_FILLED', '订单'],
  ['FOREX_ORDER_FILLED', '订单'],
  ['COMEX_TRADE', '交易'],
  ['FOREX_TRADE', '交易'],
  ['PRODUCTION_ORDER_FINISHED', '已生产'],
  ['SITE_EXPERT_DROPPED', '专家'],
  ['CORPORATION_PROJECT_FINISHED', '飞船'],
  ['SHIPYARD_PROJECT_FINISHED', '飞船'],
  ['COGC_PROGRAM_CHANGED', 'COGC'],
  ['COGC_STATUS_CHANGED', 'COGC'],
  ['COGC_UPKEEP_STARTED', 'COGC'],
  ['POPULATION_PROJECT_UPGRADED', '人口'],
  ['PLANETARY_PROJECT_FINISHED', '基建'],
  ['INFRASTRUCTURE_OPERATIONAL_STATE_CHANGED', '基建'],
  ['INFRASTRUCTURE_PROJECT_COMPLETED', '基建'],
  ['INFRASTRUCTURE_UPGRADE_COMPLETED', '基建'],
  ['INFRASTRUCTURE_UPKEEP_PHASE_STARTED', '基建'],
  ['GATEWAY_JUMP_ABORTED_LINK_CHANGED', '星门'],
  ['GATEWAY_JUMP_ABORTED_LINK_NOT_ESTABLISHED', '星门'],
  ['GATEWAY_JUMP_ABORTED_MISSING_FUNDS', '星门'],
  ['GATEWAY_JUMP_ABORTED_NO_CAPACITY', '星门'],
  ['GATEWAY_JUMP_ABORTED_NO_FUEL', '星门'],
  ['GATEWAY_JUMP_ABORTED_NOT_OPERATIONAL', '星门'],
  ['GATEWAY_LINK_ESTABLISHED', '星门'],
  ['GATEWAY_LINK_REQUEST_RECEIVED', '星门'],
  ['GATEWAY_LINK_UNLINKED', '星门'],
  ['SHIP_FLIGHT_ENDED', '到达'],
  ['POPULATION_REPORT_AVAILABLE', '报告'],
  ['LOCAL_MARKET_AD_ACCEPTED', '合同'],
  ['LOCAL_MARKET_AD_EXPIRED', '合同'],
  ['WORKFORCE_LOW_SUPPLIES', '物资'],
  ['WORKFORCE_OUT_OF_SUPPLIES', '物资'],
  ['WORKFORCE_UNSATISFIED', '物资'],
  ['WAREHOUSE_STORE_LOCKED_INSUFFICIENT_FUNDS', '仓库'],
  ['WAREHOUSE_STORE_UNLOCKED', '仓库'],
  ['CORPORATION_MANAGER_INVITE_ACCEPTED', '公司'],
  ['CORPORATION_MANAGER_INVITE_REJECTED', '公司'],
  ['CORPORATION_MANAGER_SHAREHOLDER_LEFT', '公司'],
  ['CORPORATION_SHAREHOLDER_DIVIDEND_RECEIVED', '公司'],
  ['CORPORATION_SHAREHOLDER_INVITE_RECEIVED', '公司'],
  ['TUTORIAL_TASK_FINISHED', '欢迎'],
  ['WELCOME', '欢迎'],
]);

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

// ── 通知正文格式化 ─────────────────────────────────────────────────────────────
function formatAlertBody(alert: PrunApi.Alert): string {
  switch (alert.type) {
    case 'SHIP_FLIGHT_ENDED': {
      const reg = getData(alert, 'registration') as string | undefined;
      const dest = getData(alert, 'destination') as { address: PrunApi.Address } | undefined;
      const destStr = dest ? formatAddress(dest.address) : '';
      if (reg && destStr) {
        return `舰只 ${reg} 已到达 ${destStr}`;
      }
      if (reg) {
        return `舰只 ${reg} 已到达目的地`;
      }
      return '飞船已到达目的地';
    }
    case 'COMEX_ORDER_FILLED': {
      const commodity = getData(alert, 'commodity') as string | undefined;
      const quantity = getData(alert, 'quantity') as number | undefined;
      const exchange = getData(alert, 'exchange') as string | undefined;
      const parts = [
        commodity && `商品 ${commodity}`,
        quantity != null && `数量 ${quantity}`,
        exchange && `交易所 ${exchange}`,
      ].filter(Boolean);
      return parts.length > 0 ? parts.join('，') + ' — 订单成交' : '商品交易所订单已成交';
    }
    case 'FOREX_ORDER_FILLED': {
      const ticker = getData(alert, 'ticker') as string | undefined;
      return ticker ? `外汇 ${ticker} 订单已成交` : '外汇订单已成交';
    }
    case 'COMEX_TRADE': {
      const commodity = getData(alert, 'commodity') as string | undefined;
      const quantity = getData(alert, 'quantity') as number | undefined;
      const parts = [
        commodity && `商品 ${commodity}`,
        quantity != null && `数量 ${quantity}`,
      ].filter(Boolean);
      return parts.length > 0 ? parts.join('，') + ' — 交易完成' : '商品交易完成';
    }
    case 'FOREX_TRADE':
      return '外汇交易完成';
    case 'PRODUCTION_ORDER_FINISHED': {
      const material = getData(alert, 'material') as string | undefined;
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
      const contract = getData(alert, 'contract') as string | undefined;
      const partner = getData(alert, 'partner') as PrunApi.ContractPartner | undefined;
      const partnerStr = partner?.name ? `（${partner.name}）` : '';
      return contract ? `合同 ${contract}${partnerStr} 的一项条件已完成` : '合同条件已完成';
    }
    case 'CONTRACT_CONTRACT_RECEIVED': {
      const contract = getData(alert, 'contract') as string | undefined;
      const partner = getData(alert, 'partner') as PrunApi.ContractPartner | undefined;
      const partnerStr = partner?.name ? `，对方：${partner.name}` : '';
      return `收到合同${contract ? ' ' + contract : ''}${partnerStr}`;
    }
    case 'CONTRACT_CONTRACT_CLOSED': {
      const contract = getData(alert, 'contract') as string | undefined;
      return contract ? `合同 ${contract} 已关闭` : '合同已关闭';
    }
    case 'CONTRACT_CONTRACT_BREACHED': {
      const contract = getData(alert, 'contract') as string | undefined;
      return contract ? `合同 ${contract} 已违约！` : '合同已违约！';
    }
    case 'CONTRACT_CONTRACT_CANCELLED': {
      const contract = getData(alert, 'contract') as string | undefined;
      return contract ? `合同 ${contract} 已取消` : '合同已取消';
    }
    case 'CONTRACT_CONTRACT_TERMINATED': {
      const contract = getData(alert, 'contract') as string | undefined;
      return contract ? `合同 ${contract} 已终止` : '合同已终止';
    }
    case 'CONTRACT_CONTRACT_TERMINATION_REQUESTED': {
      const contract = getData(alert, 'contract') as string | undefined;
      return contract ? `合同 ${contract} 收到终止请求` : '合同请求终止';
    }
    case 'CONTRACT_DEADLINE_EXCEEDED_WITH_CONTROL':
    case 'CONTRACT_DEADLINE_EXCEEDED_WITHOUT_CONTROL': {
      const contract = getData(alert, 'contract') as string | undefined;
      return contract ? `合同 ${contract} 已超期` : '合同已超期';
    }
    case 'CONTRACT_CONTRACT_EXTENDED': {
      const contract = getData(alert, 'contract') as string | undefined;
      return contract ? `合同 ${contract} 已延期` : '合同已延期';
    }
    case 'CONTRACT_CONTRACT_REJECTED': {
      const contract = getData(alert, 'contract') as string | undefined;
      return contract ? `合同 ${contract} 已被拒绝` : '合同已被拒绝';
    }
    case 'COMEX_PICKUP_CONTRACT_CREATED': {
      const contract = getData(alert, 'contract') as string | undefined;
      return contract ? `取货合同 ${contract} 已创建` : '取货合同已创建';
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
      const program = getData(alert, 'program') as string | undefined;
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
      return alert.type;
  }
}

// ── 发送桌面通知 ──────────────────────────────────────────────────────────────
function sendDesktopNotification(alert: PrunApi.Alert) {
  if (Notification.permission !== 'granted') {
    return;
  }
  if (userData.settings.mutedDesktopNotifications.includes(alert.type)) {
    return;
  }
  const label = labelMap.get(alert.type) ?? '通知';
  const body = formatAlertBody(alert);
  new Notification(`APEX — ${label}`, {
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

  // 请求桌面通知权限（如用户尚未决定）
  if (Notification.permission === 'default') {
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

features.add(import.meta.url, init, 'NOTS：将游戏内通知同步到桌面右下角（浏览器通知）。');
