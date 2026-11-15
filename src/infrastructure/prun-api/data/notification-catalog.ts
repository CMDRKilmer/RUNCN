// 游戏通知类型清单：运行时单一事实源。
// PrunApi.AlertType 只是 TS 联合类型，运行时不存在，因此这里显式列出全部类型。
// 消费方：XIT DNOT 设置页、桌面通知发送端、NOTS 游戏内彩色标签。
export interface NotificationTypeEntry {
  type: PrunApi.AlertType;
  /** 中文事件名，用于设置页展示与桌面通知正文兜底 */
  name: string;
}

export interface NotificationGroup {
  /** 分组短标签，同时作为桌面通知标题（APEX — <label>） */
  label: string;
  /** 游戏内 NOTS 彩色标签用色 */
  color: string;
  types: NotificationTypeEntry[];
}

export const NOTIFICATION_GROUPS: NotificationGroup[] = [
  {
    label: '动议',
    color: '#ffda94',
    types: [
      { type: 'ADMIN_CENTER_MOTION_VOTING_STARTED', name: '动议投票开始' },
      { type: 'ADMIN_CENTER_MOTION_PASSED', name: '动议通过' },
      { type: 'ADMIN_CENTER_MOTION_ENDED', name: '动议结束' },
    ],
  },
  {
    label: '选举',
    color: '#ffda94',
    types: [
      { type: 'ADMIN_CENTER_ELECTION_REMINDER', name: '选举提醒' },
      { type: 'ADMIN_CENTER_ELECTION_STARTED', name: '选举开始' },
      { type: 'ADMIN_CENTER_GOVERNOR_ELECTED', name: '总督选出' },
      { type: 'ADMIN_CENTER_NO_GOVERNOR_ELECTED', name: '未产生总督' },
      { type: 'ADMIN_CENTER_RUN_SUCCEEDED', name: '竞选成功' },
    ],
  },
  {
    label: '合同',
    color: '#f0ad4e',
    types: [
      { type: 'CONTRACT_CONDITION_FULFILLED', name: '合同条件完成' },
      { type: 'CONTRACT_CONDITION_PICKUP_CONDITION_PENDING', name: '取货条件待处理' },
      { type: 'CONTRACT_CONTRACT_BREACHED', name: '合同违约' },
      { type: 'CONTRACT_CONTRACT_CANCELLED', name: '合同取消' },
      { type: 'CONTRACT_CONTRACT_CLOSED', name: '合同签订' },
      { type: 'CONTRACT_CONTRACT_EXTENDED', name: '合同延期' },
      { type: 'CONTRACT_CONTRACT_RECEIVED', name: '收到合同' },
      { type: 'CONTRACT_CONTRACT_REJECTED', name: '合同被拒绝' },
      { type: 'CONTRACT_CONTRACT_TERMINATED', name: '合同终止' },
      { type: 'CONTRACT_CONTRACT_TERMINATION_REQUESTED', name: '收到合同终止请求' },
      { type: 'CONTRACT_DEADLINE_EXCEEDED_WITH_CONTROL', name: '合同超期（可控）' },
      { type: 'CONTRACT_DEADLINE_EXCEEDED_WITHOUT_CONTROL', name: '合同超期（失控）' },
      { type: 'COMEX_PICKUP_CONTRACT_CREATED', name: '取货合同创建' },
    ],
  },
  {
    label: '订单',
    color: '#e85c5c',
    types: [
      { type: 'COMEX_ORDER_FILLED', name: '商品订单成交' },
      { type: 'FOREX_ORDER_FILLED', name: '外汇订单成交' },
    ],
  },
  {
    label: '交易',
    color: '#5cb85c',
    types: [
      { type: 'COMEX_TRADE', name: '商品交易完成' },
      { type: 'FOREX_TRADE', name: '外汇交易完成' },
    ],
  },
  {
    label: '已生产',
    color: '#9cbcff',
    types: [{ type: 'PRODUCTION_ORDER_FINISHED', name: '生产完成' }],
  },
  {
    label: '专家',
    color: '#ff8a00',
    types: [{ type: 'SITE_EXPERT_DROPPED', name: '专家离开' }],
  },
  {
    label: '飞船',
    color: '#ff8a00',
    types: [{ type: 'SHIPYARD_PROJECT_FINISHED', name: '造船完成' }],
  },
  {
    label: 'COGC',
    color: '#3fa2de',
    types: [
      { type: 'COGC_PROGRAM_CHANGED', name: 'COGC 计划变更' },
      { type: 'COGC_STATUS_CHANGED', name: 'COGC 状态变更' },
      { type: 'COGC_UPKEEP_STARTED', name: 'COGC 维护开始' },
    ],
  },
  {
    label: '人口',
    color: '#3fa2de',
    types: [{ type: 'POPULATION_PROJECT_UPGRADED', name: '人口项目升级' }],
  },
  {
    label: '基建',
    color: '#3fa2de',
    types: [
      { type: 'PLANETARY_PROJECT_FINISHED', name: '星球项目完成' },
      { type: 'INFRASTRUCTURE_OPERATIONAL_STATE_CHANGED', name: '基建运行状态变更' },
      { type: 'INFRASTRUCTURE_PROJECT_COMPLETED', name: '基建项目完成' },
      { type: 'INFRASTRUCTURE_UPGRADE_COMPLETED', name: '基建升级完成' },
      { type: 'INFRASTRUCTURE_UPKEEP_PHASE_STARTED', name: '基建维护开始' },
    ],
  },
  {
    label: '星门',
    color: '#3fa2de',
    types: [
      { type: 'GATEWAY_JUMP_ABORTED_LINK_CHANGED', name: '跳跃中止：链路变更' },
      { type: 'GATEWAY_JUMP_ABORTED_LINK_NOT_ESTABLISHED', name: '跳跃中止：链路未建立' },
      { type: 'GATEWAY_JUMP_ABORTED_MISSING_FUNDS', name: '跳跃中止：资金不足' },
      { type: 'GATEWAY_JUMP_ABORTED_NO_CAPACITY', name: '跳跃中止：容量不足' },
      { type: 'GATEWAY_JUMP_ABORTED_NO_FUEL', name: '跳跃中止：燃料不足' },
      { type: 'GATEWAY_JUMP_ABORTED_NOT_OPERATIONAL', name: '跳跃中止：星门未运行' },
      { type: 'GATEWAY_LINK_ESTABLISHED', name: '星门链路建立' },
      { type: 'GATEWAY_LINK_REQUEST_RECEIVED', name: '收到星门链路请求' },
      { type: 'GATEWAY_LINK_UNLINKED', name: '星门链路断开' },
    ],
  },
  {
    label: '到达',
    color: '#c084fc',
    types: [{ type: 'SHIP_FLIGHT_ENDED', name: '飞船到达' }],
  },
  {
    label: '报告',
    color: '#00c9b7',
    types: [{ type: 'POPULATION_REPORT_AVAILABLE', name: '人口报告发布' }],
  },
  {
    label: '广告',
    color: '#00bd29',
    types: [
      { type: 'LOCAL_MARKET_AD_ACCEPTED', name: '本地广告被接受' },
      { type: 'LOCAL_MARKET_AD_EXPIRED', name: '本地广告过期' },
    ],
  },
  {
    label: '物资',
    color: '#ff3f3f',
    types: [
      { type: 'WORKFORCE_LOW_SUPPLIES', name: '物资不足' },
      { type: 'WORKFORCE_OUT_OF_SUPPLIES', name: '物资耗尽' },
      { type: 'WORKFORCE_UNSATISFIED', name: '劳动力不满' },
    ],
  },
  {
    label: '仓库',
    color: '#ff3f3f',
    types: [
      { type: 'WAREHOUSE_STORE_LOCKED_INSUFFICIENT_FUNDS', name: '仓库因资金不足锁定' },
      { type: 'WAREHOUSE_STORE_UNLOCKED', name: '仓库解锁' },
    ],
  },
  {
    label: '公司',
    color: '#ea698f',
    types: [
      { type: 'CORPORATION_MANAGER_INVITE_ACCEPTED', name: '公司邀请被接受' },
      { type: 'CORPORATION_MANAGER_INVITE_REJECTED', name: '公司邀请被拒绝' },
      { type: 'CORPORATION_MANAGER_SHAREHOLDER_LEFT', name: '公司股东离开' },
      { type: 'CORPORATION_PROJECT_FINISHED', name: '公司项目完成' },
      { type: 'CORPORATION_SHAREHOLDER_DIVIDEND_RECEIVED', name: '收到公司分红' },
      { type: 'CORPORATION_SHAREHOLDER_INVITE_RECEIVED', name: '收到股东邀请' },
    ],
  },
  {
    label: '欢迎',
    color: '#eeeeee',
    types: [
      { type: 'TUTORIAL_TASK_FINISHED', name: '教程任务完成' },
      { type: 'WELCOME', name: '欢迎' },
    ],
  },
  {
    label: '系统',
    color: '#eeeeee',
    types: [
      { type: 'RELEASE_NOTES', name: '版本公告' },
      { type: 'USER_CONVERSION_REMINDER_LICENSE', name: '许可证转换提醒' },
      { type: 'USER_LICENSE_ABOUT_TO_EXPIRE', name: '许可证即将到期' },
      { type: 'USER_LICENSE_EXPIRED', name: '许可证已到期' },
      { type: 'USER_LICENSE_GIFT_RECEIVED', name: '收到许可证赠礼' },
      { type: 'USER_STEAM_REVIEW', name: 'Steam 评价提示' },
    ],
  },
];

/** 全部可推送类型（顺序与设置页展示一致） */
export const ALL_NOTIFICATION_TYPES: PrunApi.AlertType[] = NOTIFICATION_GROUPS.flatMap(group =>
  group.types.map(entry => entry.type),
);

export interface NotificationMeta {
  label: string;
  name: string;
  color: string;
}

export const NOTIFICATION_META = new Map<PrunApi.AlertType, NotificationMeta>(
  NOTIFICATION_GROUPS.flatMap(group =>
    group.types.map(
      entry =>
        [entry.type, { label: group.label, name: entry.name, color: group.color }] as [
          PrunApi.AlertType,
          NotificationMeta,
        ],
    ),
  ),
);

/** 新装用户默认只推送这一组常用通知；存量用户由迁移按旧屏蔽配置还原。 */
export const DEFAULT_DESKTOP_NOTIFICATION_TYPES: PrunApi.AlertType[] = [
  'PRODUCTION_ORDER_FINISHED',
  'SHIP_FLIGHT_ENDED',
  'COMEX_ORDER_FILLED',
  'FOREX_ORDER_FILLED',
  'CONTRACT_CONTRACT_RECEIVED',
  'CONTRACT_CONTRACT_BREACHED',
  'CONTRACT_CONDITION_FULFILLED',
  'SITE_EXPERT_DROPPED',
  'WORKFORCE_LOW_SUPPLIES',
  'WORKFORCE_OUT_OF_SUPPLIES',
  'WAREHOUSE_STORE_LOCKED_INSUFFICIENT_FUNDS',
];
