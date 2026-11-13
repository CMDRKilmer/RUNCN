import $style from './nots-notification-type-label.module.css';
import { getPrunId } from '@src/infrastructure/prun-ui/attributes';
import { alertsStore } from '@src/infrastructure/prun-api/data/alerts';
import { NOTIFICATION_GROUPS } from '@src/infrastructure/prun-api/data/notification-catalog';
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

// 分组、颜色与全部 69 种类型统一取自 notification-catalog.ts，
// 避免与 XIT DNOT 设置页、桌面通知发送端各维护一份清单。
const labels: NotificationTypeLabel[] = NOTIFICATION_GROUPS.map(group => ({
  types: group.types.map(entry => entry.type),
  label: group.label,
  color: group.color,
}));

const labelMap = new Map(labels.flatMap(x => x.types.map(y => [y, x])));

function init() {
  applyCssRule('NOTS', `.${C.AlertListItem.content}`, $style.content);
  applyCssRule('NOTS', `.${C.AlertListItem.time}`, $style.time);

  tiles.observe('NOTS', onTileReady);
}

features.add(import.meta.url, init, 'NOTS：添加彩色通知类型标签。');
