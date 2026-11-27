// 会计科目编号 → 中文名。
//
// 编号来自游戏下发的 ACCOUNTING_BALANCES（type/number），名字按「看得懂优先」的原则
// 自己起，不复用游戏原生汉化（原生那套有歧义，例如 EQUITY 被译成「总资产」）。
// 只列目前能对上号的科目；未列出的类型在页面上显示为「科目 #编号」，方便后续补。
export type AccountSection = 'revenue' | 'expense' | 'asset' | 'liability' | 'equity';

// 支出再分一层：利润表按金额降序排时，资本性出资、一次性冲账会和日常费用混排，
// 看起来无从下手。分组后组内仍按金额排，组间按经营逻辑排（材料→人工→设施→出资→其他）。
export type ExpenseGroup = 'material' | 'labor' | 'facility' | 'capital' | 'other';

export const EXPENSE_GROUPS: { id: ExpenseGroup; name: string; hint?: string }[] = [
  { id: 'material', name: '材料与燃料' },
  { id: 'labor', name: '人工' },
  { id: 'facility', name: '生产与设施' },
  {
    id: 'capital',
    name: '资本性出资',
    hint: '投入总部升级、行星项目、代表中心的资产与资金，不是日常经营开支',
  },
  { id: 'other', name: '其他与一次性' },
];

export interface AccountLabel {
  name: string;
  section: AccountSection;
  /** 仅支出类使用：所在的小组，缺省归入 other */
  group?: ExpenseGroup;
  hint?: string;
}

export const ACCOUNT_LABELS: Record<number, AccountLabel> = {
  // ── 收入 ──
  4000: {
    name: '其他收入',
    section: 'revenue',
    hint: '销售、生产费、运输、利息之外的收入，如合同收款',
  },
  4200: { name: '材料销售收入', section: 'revenue', hint: '在交易所/本地市场卖出材料确认的收入' },
  4208: { name: '运输收入', section: 'revenue' },
  7100: { name: '利息收入', section: 'revenue', hint: '放贷收到的利息' },

  // ── 支出 ──
  5000: {
    name: '材料消耗',
    section: 'expense',
    group: 'material',
    hint: '生产、建造消耗的材料（按市值计价）',
  },
  5010: { name: '燃料消耗', section: 'expense', group: 'material' },
  5200: {
    name: '已收到材料',
    section: 'expense',
    group: 'material',
    hint: '收到别人交付的材料，按市值冲减成本，所以是负数',
  },
  5880: {
    name: '已交付材料',
    section: 'expense',
    group: 'material',
    hint: '按合同交付给对方的材料，按市值计入成本',
  },
  6072: {
    name: '劳动力消耗品',
    section: 'expense',
    group: 'labor',
    hint: '工人消耗的 DW/RAT/OVE 等',
  },
  6110: { name: '生产费用', section: 'expense', group: 'facility' },
  6115: { name: '基地设立税', section: 'expense', group: 'facility' },
  6221: { name: '建筑折旧', section: 'expense', group: 'facility' },
  6280: {
    name: '合同作废冲账',
    section: 'expense',
    group: 'other',
    hint: '合同签了又终止：签订时挂的应收/应付被冲平，没有现金进出',
  },
  6310: {
    name: '仓储费用',
    section: 'expense',
    group: 'facility',
    hint: '存放在别人仓库付的仓储费',
  },
  6345: {
    name: '总部出资',
    section: 'expense',
    group: 'capital',
    hint: '投入公司总部升级的资产/资金',
  },
  6390: { name: '行星项目出资', section: 'expense', group: 'capital' },
  6460: { name: '船只维护', section: 'expense', group: 'facility' },
  6855: { name: '交易手续费', section: 'expense', group: 'facility' },
  6880: { name: '汇率波动损失', section: 'expense', group: 'other' },
  6890: { name: '跃迁点收费', section: 'expense', group: 'facility' },

  // ── 资产 ──
  1000: { name: '库存', section: 'asset' },
  1200: { name: '应收账款', section: 'asset' },
  1300: { name: '托管材料', section: 'asset' },
  1350: { name: '挂单冻结资金', section: 'asset' },
  1360: { name: '应收贷款', section: 'asset' },
  250: { name: '基地建筑', section: 'asset', hint: '基地上每一栋建筑的账面净值（成本−折旧）' },
  850: { name: '持有股份', section: 'asset' },
  1800: { name: '现金', section: 'asset' },

  // ── 权益 ──
  2000: { name: '固定资本', section: 'equity' },
  2970: { name: '结转利润', section: 'equity' },
};

export function labelOf(type: number): AccountLabel {
  return ACCOUNT_LABELS[type] ?? { name: `科目 #${type}`, section: 'expense' };
}

/** 支出科目所属小组；未收录的科目归「其他与一次性」。 */
export function expenseGroupOf(type: number): ExpenseGroup {
  return ACCOUNT_LABELS[type]?.group ?? 'other';
}
