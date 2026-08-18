import { contractsStore, isFactionContract } from '@src/infrastructure/prun-api/data/contracts';
import dayjs from 'dayjs';
import { timestampEachMinute } from '@src/utils/dayjs';
import { sumBy } from '@src/utils/sum-by';
import { calcMaterialAmountPrice } from '@src/infrastructure/fio/cx';
import { binarySearch } from '@src/utils/binary-search';
import { map } from '@src/utils/map-values';

interface ContractCondition {
  contract: PrunApi.Contract;
  condition: PrunApi.ContractCondition;
  isSelf: boolean;
  deadline: number;
  dependencies: PrunApi.ContractCondition[];
}

const sortedConditions = computed(() => {
  const active = contractsStore.active.value;
  if (!active) {
    return undefined;
  }
  const conditions: ContractCondition[] = [];
  for (const contract of active) {
    const activeConditions = contract.conditions.filter(x => x.status !== 'FULFILLED');
    for (const condition of activeConditions) {
      conditions.push({
        contract,
        condition,
        isSelf: condition.party === contract.party,
        deadline: calculateDeadline(contract, condition),
        dependencies: condition.dependencies
          .map(id => contract.conditions.find(x => x.id === id))
          .filter(x => x !== undefined),
      });
    }
  }
  conditions.sort((a, b) => a.deadline - b.deadline);
  return conditions;
});

export function calculateDeadline(
  contract: PrunApi.Contract,
  condition: PrunApi.ContractCondition,
) {
  if (condition.type === 'COMEX_PURCHASE_PICKUP') {
    // COMEX_PURCHASE_PICKUP 条件有特殊处理：
    // 当所有依赖条件满足后，
    // 玩家需要通过该条件提取材料。
    // 为了确定 COMEX_PURCHASE_PICKUP 条件的截止日期，
    // 我们使用其依赖条件中最晚的截止日期。
    // 这是因为材料可以随时提取，
    // 使得 COMEX_PURCHASE_PICKUP 本身的截止日期不相关。
    return getLatestDependencyDeadline(contract, condition);
  }

  if (condition.deadline) {
    return condition.deadline.timestamp;
  }

  if (!condition.deadlineDuration) {
    return Number.POSITIVE_INFINITY;
  }

  return getLatestDependencyDeadline(contract, condition) + condition.deadlineDuration.millis;
}

function getLatestDependencyDeadline(
  contract: PrunApi.Contract,
  condition: PrunApi.ContractCondition,
) {
  let latestDependency = contract.date.timestamp;
  for (const dependency of condition.dependencies) {
    const dependencyCondition = contract.conditions.find(x => x.id === dependency);
    if (dependencyCondition) {
      latestDependency = Math.max(
        latestDependency,
        calculateDeadline(contract, dependencyCondition),
      );
    }
  }
  return latestDependency;
}

const accountingPeriod = dayjs.duration(1, 'week').asMilliseconds();

const currentSplitIndex = computed(() => {
  const sorted = sortedConditions.value;
  if (!sorted) {
    return undefined;
  }
  const currentSplitDate = timestampEachMinute.value + accountingPeriod;
  return binarySearch(currentSplitDate, sorted, x => x.deadline);
});

export const currentConditions = computed(() => {
  return sortedConditions.value?.slice(0, currentSplitIndex.value);
});

export const selfCurrentConditions = computed(() => {
  return currentConditions.value?.filter(x => x.isSelf);
});

export const partnerCurrentConditions = computed(() => {
  return currentConditions.value?.filter(x => !x.isSelf);
});

export const nonCurrentConditions = computed(() => {
  return sortedConditions.value?.slice(currentSplitIndex.value);
});

export const selfNonCurrentConditions = computed(() => {
  return nonCurrentConditions.value?.filter(x => x.isSelf);
});

export const partnerNonCurrentConditions = computed(() => {
  return nonCurrentConditions.value?.filter(x => !x.isSelf);
});

type MaybeConditions = Ref<ContractCondition[] | undefined>;

export function sumAccountsPayable(conditions: MaybeConditions) {
  return sumConditions(conditions, ['PAYMENT', 'LOAN_PAYOUT'], x => x.amount!.amount);
}

export function sumLoanRepayments(conditions: MaybeConditions) {
  return sumConditions(conditions, ['LOAN_INSTALLMENT'], x => x.repayment!.amount);
}

export function sumLoanInterest(conditions: MaybeConditions) {
  const filtered = conditions.value?.filter(
    x =>
      x.condition.type === 'LOAN_INSTALLMENT' &&
      x.dependencies.every(y => y.status === 'FULFILLED'),
  );
  return sumBy(filtered, x => x.condition.interest!.amount);
}

export function sumDeliveries(conditions: MaybeConditions) {
  return sumConditions(conditions, ['DELIVERY'], getMaterialQuantityValue);
}

export function sumProvisions(conditions: MaybeConditions) {
  return sumConditions(conditions, ['PROVISION'], getMaterialQuantityValue);
}

export function sumFactionProvisions(conditions: MaybeConditions) {
  // 派系物流合同通过 PROVISION_SHIPMENT
  // 合同条件请求材料。将其计为负债。
  const filtered = conditions.value?.filter(
    x => isFactionContract(x.contract) && x.condition.type === 'PROVISION_SHIPMENT',
  );
  return sumBy(filtered, x => getMaterialQuantityValue(x.condition));
}

export function sumMaterialsPickup(conditions: MaybeConditions) {
  return sumConditions(conditions, ['COMEX_PURCHASE_PICKUP'], x => {
    return map(
      [calcMaterialAmountPrice(x.quantity!), calcMaterialAmountPrice(x.pickedUp!)],
      (quantity, pickedUp) => quantity - pickedUp,
    );
  });
}

export function sumShipmentDeliveries(conditions: MaybeConditions) {
  let total = 0;
  const filtered = conditions.value?.filter(x => x.condition.type === 'DELIVERY_SHIPMENT');
  if (!filtered) {
    return undefined;
  }
  for (const cc of filtered) {
    const pickup = findDependency(cc.contract, cc.condition, 'PICKUP_SHIPMENT');
    if (!pickup) {
      continue;
    }
    const provision = findDependency(cc.contract, pickup, 'PROVISION_SHIPMENT');
    if (provision?.status !== 'FULFILLED' || !provision?.quantity) {
      continue;
    }
    const value = getMaterialQuantityValue(provision);
    if (value === undefined) {
      return undefined;
    }
    total += value;
  }
  return total;
}

function findDependency(
  contract: PrunApi.Contract,
  condition: PrunApi.ContractCondition,
  type: PrunApi.ContractConditionType,
) {
  for (const id of condition.dependencies) {
    const match = contract.conditions.find(x => x.id === id);
    if (match?.type === type) {
      return match;
    }
  }
  return undefined;
}

function sumConditions(
  conditions: MaybeConditions,
  types: PrunApi.ContractConditionType[],
  property: (item: PrunApi.ContractCondition) => number | undefined,
) {
  const filtered = conditions.value?.filter(x => types.includes(x.condition.type));
  return sumBy(filtered, x => property(x.condition));
}

function getMaterialQuantityValue(condition: PrunApi.ContractCondition) {
  return calcMaterialAmountPrice(condition.quantity!);
}