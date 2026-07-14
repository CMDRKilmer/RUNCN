<script setup lang="ts">
import { computed } from 'vue';
import LoadingSpinner from '@src/components/LoadingSpinner.vue';
import { contractsStore } from '@src/infrastructure/prun-api/data/contracts';
import { shipsStore } from '@src/infrastructure/prun-api/data/ships';
import { flightsStore } from '@src/infrastructure/prun-api/data/flights';
import { getEntityNameFromAddress } from '@src/infrastructure/prun-api/data/addresses';
import { materialsStore } from '@src/infrastructure/prun-api/data/materials';
import { timestampEachMinute } from '@src/utils/dayjs';
import { formatEta } from '@src/utils/format';

interface ShipmentRow {
  contractId: string;
  contractName: string;
  material: string;
  quantity: number;
  weight: number;
  volume: number;
  origin: string;
  destination: string;
  shipName?: string;
  shipRegistration?: string;
  arrivalMs?: number;
  segmentType?: string;
  status: 'in-transit' | 'awaiting-pickup' | 'delivered';
}

const SEGMENT_LABELS: Record<string, string> = {
  TAKE_OFF: '起飞',
  DEPARTURE: '出发',
  TRANSIT: '飞行中',
  CHARGE: '充能中',
  JUMP: '跳跃中',
  FLOAT: '漂浮',
  APPROACH: '接近',
  LANDING: '降落中',
  LOCK: '锁定',
  DECAY: '衰减',
  JUMP_GATEWAY: '星门跳跃',
};

// 构建 shipId -> ship 的映射（shipsStore 没有 getById）
const shipMap = computed(() => {
  const map = new Map<string, PrunApi.Ship>();
  for (const ship of shipsStore.all.value ?? []) {
    map.set(ship.id, ship);
  }
  return map;
});

const rows = computed<ShipmentRow[] | undefined>(() => {
  const contracts = contractsStore.active.value;
  const flights = flightsStore.all.value;
  if (!contracts || !flights) {
    return undefined;
  }

  const result: ShipmentRow[] = [];

  for (const contract of contracts) {
    // 查找运输相关条件
    const delivery = contract.conditions.find(c => c.type === 'DELIVERY_SHIPMENT');
    const pickup = contract.conditions.find(c => c.type === 'PICKUP_SHIPMENT');
    const provision = contract.conditions.find(c => c.type === 'PROVISION_SHIPMENT');

    if (!delivery) continue;

    // 货物信息
    const cargoCondition = provision ?? pickup ?? delivery;
    const material = cargoCondition.quantity?.material;
    const quantity = cargoCondition.quantity?.amount ?? 0;
    const weight = cargoCondition.weight ?? 0;
    const volume = cargoCondition.volume ?? 0;
    const materialTicker = material
      ? (materialsStore.getByTicker(material.id)?.ticker ?? material.id)
      : '';

    const origin = getEntityNameFromAddress(pickup?.address ?? provision?.address) ?? '--';
    const destination = getEntityNameFromAddress(delivery.destination ?? delivery.address) ?? '--';

    // 查找匹配的飞船（通过 origin/destination 匹配 flight）
    let matchedShip: PrunApi.Ship | undefined;
    let matchedFlight: PrunApi.Flight | undefined;

    for (const flight of flights) {
      const flightOrigin = getEntityNameFromAddress(flight.origin);
      const flightDest = getEntityNameFromAddress(flight.destination);
      if (flightOrigin === origin && flightDest === destination) {
        const ship = shipMap.value.get(flight.shipId);
        if (ship) {
          matchedShip = ship;
          matchedFlight = flight;
          break;
        }
      }
    }

    let status: ShipmentRow['status'];
    let arrivalMs: number | undefined;
    let segmentType: string | undefined;

    if (delivery.status === 'FULFILLED') {
      status = 'delivered';
    } else if (matchedFlight && matchedShip) {
      status = 'in-transit';
      arrivalMs = matchedFlight.arrival?.timestamp;
      const currentSegment = matchedFlight.segments[matchedFlight.currentSegmentIndex];
      segmentType = currentSegment?.type;
    } else {
      status = 'awaiting-pickup';
    }

    result.push({
      contractId: contract.localId,
      contractName: contract.name ?? contract.localId,
      material: materialTicker,
      quantity,
      weight,
      volume,
      origin,
      destination,
      shipName: matchedShip?.name,
      shipRegistration: matchedShip?.registration,
      arrivalMs,
      segmentType,
      status,
    });
  }

  return result.sort((a, b) => {
    // 在途优先，按到达时间升序
    if (a.status === 'in-transit' && b.status !== 'in-transit') return -1;
    if (a.status !== 'in-transit' && b.status === 'in-transit') return 1;
    if (a.arrivalMs !== undefined && b.arrivalMs !== undefined) {
      return a.arrivalMs - b.arrivalMs;
    }
    return 0;
  });
});

const STATUS_LABELS: Record<ShipmentRow['status'], string> = {
  'in-transit': '在途',
  'awaiting-pickup': '待提货',
  delivered: '已交付',
};

function statusClass(status: ShipmentRow['status']) {
  if (status === 'in-transit') return C.ColoredValue.positive;
  if (status === 'delivered') return C.ColoredValue.negative;
  return '';
}

function etaText(ms: number | undefined): string {
  if (ms === undefined) return '--';
  const now = timestampEachMinute.value;
  if (ms <= now) return '即将到达';
  return formatEta(now, ms);
}
</script>

<template>
  <LoadingSpinner v-if="rows === undefined" />
  <table v-else>
    <thead>
      <tr>
        <th>合同</th>
        <th>货物</th>
        <th>数量</th>
        <th>起点</th>
        <th>终点</th>
        <th>飞船</th>
        <th>飞行段</th>
        <th>状态</th>
        <th>到达</th>
      </tr>
    </thead>
    <tbody>
      <tr v-if="rows.length === 0">
        <td colspan="9" style="text-align: center; opacity: 0.5; padding: 12px"> 暂无在途货物 </td>
      </tr>
      <tr v-for="row in rows" :key="row.contractId">
        <td>{{ row.contractName }}</td>
        <td>{{ row.material }}</td>
        <td>{{ row.quantity }}</td>
        <td>{{ row.origin }}</td>
        <td>{{ row.destination }}</td>
        <td>{{ row.shipName ?? '--' }}</td>
        <td>{{ row.segmentType ? (SEGMENT_LABELS[row.segmentType] ?? row.segmentType) : '--' }}</td>
        <td :class="statusClass(row.status)">{{ STATUS_LABELS[row.status] }}</td>
        <td>{{ etaText(row.arrivalMs) }}</td>
      </tr>
    </tbody>
  </table>
</template>

<style scoped>
table tr > :not(:first-child) {
  text-align: right;
}
</style>
