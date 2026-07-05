export function isFactionContract(contract: PrunApi.Contract) {
  return !!contract.partner.countryCode;
}

export function canAcceptContract(contract: PrunApi.Contract) {
  return contract.party === 'CUSTOMER' && contract.status === 'OPEN';
}

export function canPartnerAcceptContract(contract: PrunApi.Contract) {
  return contract.party === 'PROVIDER' && contract.status === 'OPEN';
}

export function isSelfCondition(contract: PrunApi.Contract, condition: PrunApi.ContractCondition) {
  return contract.party === condition.party;
}

export function isPartnerCondition(
  contract: PrunApi.Contract,
  condition: PrunApi.ContractCondition,
) {
  return contract.party !== condition.party;
}

export interface ContractTotals {
  receivable: number;
  payable: number;
  currency: string;
  hasMixedCurrency: boolean;
}

/**
 * 支付条件处理回调函数类型
 * @param condition 支付条件
 * @param contract 所属合同
 */
type PaymentConditionProcessor = (
  condition: PrunApi.ContractCondition,
  contract: PrunApi.Contract,
) => void;

/**
 * 处理合同中未完成的支付条件
 * @param contract 合同对象
 * @param processor 处理每个支付条件的回调函数
 */
function processPaymentConditions(
  contract: PrunApi.Contract,
  processor: PaymentConditionProcessor,
): void {
  for (const condition of contract.conditions) {
    // 只处理未完成的支付条件
    if (condition.type === 'PAYMENT' && condition.amount && condition.status !== 'FULFILLED') {
      processor(condition, contract);
    }
  }
}

/**
 * 计算合同列表的应收应付总额
 * @param contracts 合同列表
 * @returns 统计结果，包含应收、应付、货币代码和是否混合货币的标志
 */
export function calculateContractTotals(contracts: PrunApi.Contract[]): ContractTotals {
  let receivable = 0;
  let payable = 0;
  let currency = '';
  let hasMixedCurrency = false;

  for (const contract of contracts) {
    processPaymentConditions(contract, condition => {
      // 检查货币一致性
      if (condition.amount) {
        if (currency && condition.amount.currency !== currency) {
          hasMixedCurrency = true;
        } else if (!currency) {
          currency = condition.amount.currency;
        }

        // 根据条件方判断是应收还是应付
        if (condition.party !== contract.party) {
          receivable += condition.amount.amount;
        } else {
          payable += condition.amount.amount;
        }
      }
    });
  }

  return { receivable, payable, currency, hasMixedCurrency };
}

export function friendlyConditionText(type: PrunApi.ContractConditionType) {
  switch (type) {
    case 'BASE_CONSTRUCTION':
      return '建造基地';
    case 'COMEX_PURCHASE_PICKUP':
      return '材料提取';
    case 'CONSTRUCT_SHIP':
      return '建造飞船';
    case 'CONTRIBUTION':
      return '贡献';
    case 'DELIVERY':
      return '交付';
    case 'DELIVERY_SHIPMENT':
      return '交付货物';
    case 'EXPLORATION':
      return '探索';
    case 'FINISH_FLIGHT':
      return '完成飞行';
    case 'GATEWAY_FUEL':
      return '星门燃料';
    case 'HEADQUARTERS_UPGRADE':
      return '升级总部';
    case 'INFRASTRUCTURE_CONSTRUCTION_FINISH':
      return '基建建设完成';
    case 'INFRASTRUCTURE_CONSTRUCTION_START':
      return '基建建设开始';
    case 'INFRASTRUCTURE_UPGRADE_FINISH':
      return '基建升级完成';
    case 'INFRASTRUCTURE_UPGRADE_START':
      return '基建升级开始';
    case 'INFRASTRUCTURE_UPKEEP':
      return '基建维护';
    case 'LOAN_INSTALLMENT':
      return '贷款分期';
    case 'LOAN_PAYOUT':
      return '贷款发放';
    case 'PAYMENT':
      return '付款';
    case 'PICKUP':
      return '提取';
    case 'PICKUP_SHIPMENT':
      return '提取';
    case 'PLACE_ORDER':
      return '下单';
    case 'POWER':
      return '成为总督';
    case 'PRODUCTION_ORDER_COMPLETED':
      return '完成生产订单';
    case 'PRODUCTION_RUN':
      return '运行生产';
    case 'PROVISION':
      return '供应';
    case 'PROVISION_SHIPMENT':
      return '供应';
    case 'REPAIR_SHIP':
      return '修复飞船';
    case 'REPUTATION':
      return '声望';
    case 'START_FLIGHT':
      return '开始飞行';
    case 'WORKFORCE_PROGRAM_PAYMENT':
      return '劳动力付款';
    case 'WORKFORCE_PROGRAM_START':
      return '劳动力项目启动';
    default:
      return type;
  }
}

/**
 * 获取合同状态的友好文本
 * @param status 合同状态
 * @returns 友好的状态文本
 */
export function getStatusText(status: string): string {
  const statusMap = {
    OPEN: '待接受',
    CLOSED: '进行中',
    FULFILLED: '已完成',
    PARTIALLY_FULFILLED: '部分完成',
    BREACHED: '已违约',
    TERMINATED: '已终止',
    CANCELLED: '已取消',
    REJECTED: '已拒绝',
    DEADLINE_EXCEEDED: '已逾期',
  };
  return statusMap[status as keyof typeof statusMap] || status;
}

/**
 * 获取合同状态的样式类名
 * @param status 合同状态
 * @returns 样式类名
 */
export function getStatusClass(status: string): string {
  switch (status) {
    case 'FULFILLED':
      return 'fulfilled';
    case 'CLOSED':
    case 'PARTIALLY_FULFILLED':
      return 'active';
    case 'BREACHED':
    case 'TERMINATED':
    case 'DEADLINE_EXCEEDED':
      return 'failed';
    case 'OPEN':
      return 'pending';
    default:
      return '';
  }
}

/**
 * 计算合同条件的完成进度
 * @param contract 合同对象
 * @returns 进度信息，包含已完成数、总数和百分比
 */
export function calculateProgress(contract: PrunApi.Contract) {
  const fulfilledCount = contract.conditions.filter(c => c.status === 'FULFILLED').length;
  const totalCount = contract.conditions.length;
  if (totalCount === 0) return { fulfilled: 0, total: 0, percentage: 0 };
  return {
    fulfilled: fulfilledCount,
    total: totalCount,
    percentage: Math.round((fulfilledCount / totalCount) * 100),
  };
}

/**
 * 格式化金额
 * @param amount 金额
 * @param currency 货币代码
 * @returns 格式化后的金额字符串
 */
export function formatAmount(amount: number, currency: string): string {
  if (!currency || amount === 0) return '-';
  return `${amount.toLocaleString()} ${currency}`;
}

/**
 * 获取进度条的样式类
 * @param progress 进度百分比
 * @returns 样式类名
 */
export function getProgressClass(progress: number): string {
  if (progress >= 100) return 'fulfilled';
  if (progress > 50) return 'active';
  return 'pending';
}

/**
 * 判断是否为贷款合同
 * @param contract 合同对象
 * @returns 是否为贷款合同
 */
export function isLoanContract(contract: PrunApi.Contract): boolean {
  return contract.conditions.some(c => c.type === 'LOAN_PAYOUT' || c.type === 'LOAN_INSTALLMENT');
}

/**
 * 判断是否为运输合同
 * @param contract 合同对象
 * @returns 是否为运输合同
 */
export function isTransportContract(contract: PrunApi.Contract): boolean {
  const transportTypes: PrunApi.ContractConditionType[] = [
    'DELIVERY_SHIPMENT',
    'PICKUP_SHIPMENT',
    'PROVISION_SHIPMENT',
  ];
  return contract.conditions.some(c => transportTypes.includes(c.type));
}

/**
 * 计算单个合同的应收款
 * @param contract 合同对象
 * @returns 应收款信息，包含金额和货币代码
 */
export function calculateContractReceivable(contract: PrunApi.Contract): {
  total: number;
  currency: string;
} {
  let total = 0;
  let currency = '';

  processPaymentConditions(contract, condition => {
    // 判断是否为应收款（条件方不等于合同方）
    if (condition.party !== contract.party && condition.amount) {
      total += condition.amount.amount;
      if (!currency) {
        currency = condition.amount.currency;
      }
    }
  });

  return { total, currency };
}

export interface ShipmentIconItem {
  type: 'SHIPMENT';
  shipmentId: string;
  fulfilled: boolean;
}

export interface MaterialIconItem {
  type: 'MATERIAL';
  ticker: string;
  amount: number;
  fulfilled: boolean;
}

export type ContractIconItem = ShipmentIconItem | MaterialIconItem;

/**
 * 提取合同条件中的物品图标列表
 * @param contract 合同对象
 * @returns 图标项列表，包含货物装运和材料图标
 */
export function getContractIcons(contract: PrunApi.Contract): ContractIconItem[] {
  const result: ContractIconItem[] = [];
  for (const condition of contract.conditions) {
    switch (condition.type) {
      case 'DELIVERY_SHIPMENT': {
        if (isSelfCondition(contract, condition)) {
          result.push({
            type: 'SHIPMENT',
            shipmentId: condition.shipmentItemId!,
            fulfilled: condition.status === 'FULFILLED',
          });
          continue;
        }
        break;
      }
      case 'PROVISION':
      case 'PICKUP_SHIPMENT': {
        continue;
      }
    }

    const quantity = condition.quantity;
    if (!quantity?.material) {
      continue;
    }

    result.push({
      type: 'MATERIAL',
      ticker: quantity.material.ticker,
      amount: quantity.amount,
      fulfilled: condition.status === 'FULFILLED',
    });
  }
  return result;
}
