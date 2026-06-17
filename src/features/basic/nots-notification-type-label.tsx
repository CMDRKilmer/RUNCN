import $style from './nots-notification-type-label.module.css';
import { getPrunId } from '@src/infrastructure/prun-ui/attributes';
import { alertsStore } from '@src/infrastructure/prun-api/data/alerts';
import { waitNotificationLoaded } from '@src/infrastructure/prun-ui/notifications';

function onTileReady(tile: PrunTile) {
  subscribe($$(tile.anchor, C.AlertListItem.container), processNotification);
}

async function processNotification(container: HTMLElement) {
  const content = await waitNotificationLoaded(container);

  const id = getPrunId(container);
  const alert = alertsStore.getById(id);
  if (!alert) {
    return;
  }

  const label = labelMap.get(alert.type);
  if (!label) {
    return;
  }

  const textSpan = _$(content, 'span');
  if (!textSpan) {
    return;
  }

  createFragmentApp(() => (
    <div class={$style.label} style={{ color: label.color }}>
      {label.label}
    </div>
  )).before(textSpan);
}

interface NotificationTypeLabel {
  types: PrunApi.AlertType[];
  label: string;
  color: string;
}

const labels: NotificationTypeLabel[] = [
  {
    types: [
      'ADMIN_CENTER_MOTION_ENDED',
      'ADMIN_CENTER_MOTION_PASSED',
      'ADMIN_CENTER_MOTION_VOTING_STARTED',
    ],
    label: '动议',
    color: '#ffda94',
  },
  {
    types: [
      'ADMIN_CENTER_ELECTION_REMINDER',
      'ADMIN_CENTER_ELECTION_STARTED',
      'ADMIN_CENTER_GOVERNOR_ELECTED',
      'ADMIN_CENTER_NO_GOVERNOR_ELECTED',
      'ADMIN_CENTER_RUN_SUCCEEDED',
    ],
    label: '选举',
    color: '#ffda94',
  },
  {
    types: [
      'CONTRACT_CONDITION_FULFILLED',
      'CONTRACT_CONDITION_PICKUP_CONDITION_PENDING',
      'CONTRACT_CONTRACT_BREACHED',
      'CONTRACT_CONTRACT_CANCELLED',
      'CONTRACT_CONTRACT_CLOSED',
      'CONTRACT_CONTRACT_EXTENDED',
      'CONTRACT_CONTRACT_RECEIVED',
      'CONTRACT_CONTRACT_REJECTED',
      'CONTRACT_CONTRACT_TERMINATED',
      'CONTRACT_CONTRACT_TERMINATION_REQUESTED',
      'CONTRACT_DEADLINE_EXCEEDED_WITH_CONTROL',
      'CONTRACT_DEADLINE_EXCEEDED_WITHOUT_CONTROL',
      'COMEX_PICKUP_CONTRACT_CREATED',
    ],
    label: '合同',
    color: '#f0ad4e',
  },
  {
    types: ['COMEX_ORDER_FILLED', 'FOREX_ORDER_FILLED'],
    label: '订单',
    color: '#e85c5c',
  },
  {
    types: ['COMEX_TRADE', 'FOREX_TRADE'],
    label: '交易',
    color: '#5cb85c',
  },
  {
    types: ['PRODUCTION_ORDER_FINISHED'],
    label: '已生产',
    color: '#9cbcff',
  },
  {
    types: ['SITE_EXPERT_DROPPED'],
    label: '专家',
    color: '#ff8a00',
  },
  {
    types: ['SHIPYARD_PROJECT_FINISHED'],
    label: '飞船',
    color: '#ff8a00',
  },
  {
    types: ['COGC_PROGRAM_CHANGED', 'COGC_STATUS_CHANGED', 'COGC_UPKEEP_STARTED'],
    label: 'COGC',
    color: '#3fa2de',
  },
  {
    types: ['POPULATION_PROJECT_UPGRADED'],
    label: '人口',
    color: '#3fa2de',
  },
  {
    types: [
      'PLANETARY_PROJECT_FINISHED',
      'INFRASTRUCTURE_OPERATIONAL_STATE_CHANGED',
      'INFRASTRUCTURE_PROJECT_COMPLETED',
      'INFRASTRUCTURE_UPGRADE_COMPLETED',
      'INFRASTRUCTURE_UPKEEP_PHASE_STARTED',
    ],
    label: '基建',
    color: '#3fa2de',
  },
  {
    types: [
      'GATEWAY_JUMP_ABORTED_LINK_CHANGED',
      'GATEWAY_JUMP_ABORTED_LINK_NOT_ESTABLISHED',
      'GATEWAY_JUMP_ABORTED_MISSING_FUNDS',
      'GATEWAY_JUMP_ABORTED_NO_CAPACITY',
      'GATEWAY_JUMP_ABORTED_NO_FUEL',
      'GATEWAY_JUMP_ABORTED_NOT_OPERATIONAL',
      'GATEWAY_LINK_ESTABLISHED',
      'GATEWAY_LINK_REQUEST_RECEIVED',
      'GATEWAY_LINK_UNLINKED',
    ],
    label: '星门',
    color: '#3fa2de',
  },
  {
    types: ['SHIP_FLIGHT_ENDED'],
    label: '到达',
    color: '#c084fc',
  },
  {
    types: ['POPULATION_REPORT_AVAILABLE'],
    label: '报告',
    color: '#00c9b7',
  },
  {
    types: ['LOCAL_MARKET_AD_ACCEPTED', 'LOCAL_MARKET_AD_EXPIRED'],
    label: '广告',
    color: '#00bd29',
  },
  {
    types: ['WORKFORCE_LOW_SUPPLIES', 'WORKFORCE_OUT_OF_SUPPLIES', 'WORKFORCE_UNSATISFIED'],
    label: '物资',
    color: '#ff3f3f',
  },
  {
    types: ['WAREHOUSE_STORE_LOCKED_INSUFFICIENT_FUNDS', 'WAREHOUSE_STORE_UNLOCKED'],
    label: '仓库',
    color: '#ff3f3f',
  },
  {
    types: [
      'CORPORATION_MANAGER_INVITE_ACCEPTED',
      'CORPORATION_MANAGER_INVITE_REJECTED',
      'CORPORATION_MANAGER_SHAREHOLDER_LEFT',
      'CORPORATION_PROJECT_FINISHED',
      'CORPORATION_SHAREHOLDER_DIVIDEND_RECEIVED',
      'CORPORATION_SHAREHOLDER_INVITE_RECEIVED',
    ],
    label: '公司',
    color: '#ea698f',
  },
  {
    types: ['TUTORIAL_TASK_FINISHED', 'WELCOME'],
    label: '欢迎',
    color: '#eeeeee',
  },
  {
    types: [
      'RELEASE_NOTES',
      'USER_CONVERSION_REMINDER_LICENSE',
      'USER_LICENSE_ABOUT_TO_EXPIRE',
      'USER_LICENSE_EXPIRED',
      'USER_LICENSE_GIFT_RECEIVED',
      'USER_STEAM_REVIEW',
    ],
    label: '系统',
    color: '#eeeeee',
  },
];

const labelMap = new Map(labels.flatMap(x => x.types.map(y => [y, x])));

function init() {
  applyCssRule('NOTS', `.${C.AlertListItem.content}`, $style.content);
  applyCssRule('NOTS', `.${C.AlertListItem.time}`, $style.time);

  tiles.observe('NOTS', onTileReady);
}

features.add(import.meta.url, init, 'NOTS：添加彩色通知类型标签。');
