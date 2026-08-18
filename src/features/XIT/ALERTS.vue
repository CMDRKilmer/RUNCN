<script setup lang="ts">
import LoadingSpinner from '@src/components/LoadingSpinner.vue';
import PrunLink from '@src/components/PrunLink.vue';
import BaseAlias from '@src/components/BaseAlias.vue';
import { showBuffer } from '@src/infrastructure/prun-ui/buffers';
import { sitesStore } from '@src/infrastructure/prun-api/data/sites';
import { warehousesStore } from '@src/infrastructure/prun-api/data/warehouses';
import { contractsStore } from '@src/infrastructure/prun-api/data/contracts';
import { cogcsStore } from '@src/infrastructure/prun-api/data/cogcs';
import { alertsStore } from '@src/infrastructure/prun-api/data/alerts';
import { expertsStore } from '@src/infrastructure/prun-api/data/experts';
import { productionStore } from '@src/infrastructure/prun-api/data/production';
import { timestampEachSecond } from '@src/utils/dayjs';
import {
  getEntityNameFromAddress,
  getEntityNaturalIdFromAddress,
} from '@src/infrastructure/prun-api/data/addresses';
import { calculateDeadline } from '@src/core/balance/contract-conditions';
import { calculateEta, getTotalExperts } from '@src/core/experts';
import { calcCompletionDate } from '@src/core/production-line';
import dayjs from 'dayjs';

const dayMs = dayjs.duration(1, 'day').asMilliseconds();

// --- Alert item type ---

interface AlertItem {
  category: string;
  title: string;
  naturalId: string;
  detail: string;
  deadline?: number;
  action?: () => void;
  actionLabel?: string;
}

// --- Urgency helpers ---

function isExpired(ms: number) {
  return ms <= timestampEachSecond.value;
}

function isUrgent(ms: number) {
  const remaining = ms - timestampEachSecond.value;
  return remaining <= dayMs;
}

function isWarning(ms: number) {
  const remaining = ms - timestampEachSecond.value;
  return remaining <= dayMs * 3;
}

function formatDuration(timestamp: number) {
  const now = timestampEachSecond.value;
  if (timestamp <= now) {
    return '已过期';
  }
  let duration = dayjs.duration({ milliseconds: timestamp - now });
  const days = Math.floor(duration.asDays());
  duration = duration.subtract(days, 'days');
  const hours = Math.floor(duration.asHours());
  if (days > 0) {
    return `${days}d ${hours}h`;
  }
  duration = duration.subtract(hours, 'hours');
  const minutes = Math.floor(duration.asMinutes());
  if (hours > 0) {
    return `${hours}h ${minutes}m`;
  }
  duration = duration.subtract(minutes, 'minutes');
  const seconds = Math.floor(duration.asSeconds());
  if (minutes > 0) {
    return `${minutes}m ${seconds}s`;
  }
  return `${seconds}s`;
}

function deadlineClass(ms?: number) {
  if (ms === undefined) {
    return '';
  }
  if (isExpired(ms)) {
    return C.ColoredValue.negative;
  }
  if (isUrgent(ms)) {
    return C.ColoredValue.negative;
  }
  if (isWarning(ms)) {
    return '';
  }
  return C.ColoredValue.positive;
}

function deadlineStyle(ms?: number) {
  if (ms === undefined) {
    return '';
  }
  if (isExpired(ms) || isUrgent(ms)) {
    return 'color: #d9534f';
  }
  if (isWarning(ms)) {
    return 'color: #f0ad4e';
  }
  return '';
}

// --- Warehouse rent ---

const warehouseItems = computed<AlertItem[]>(() => {
  return (warehousesStore.all.value ?? []).map(w => {
    const naturalId = getEntityNaturalIdFromAddress(w.address) ?? '';
    const name = getEntityNameFromAddress(w.address) ?? '';
    return {
      category: '仓库租金',
      title: `${name} (${naturalId})`,
      naturalId,
      detail: `${w.fee.amount.toFixed(2)} ${w.fee.currency}`,
      deadline: w.nextPayment.timestamp,
      action: () => showBuffer(`WAR ${w.warehouseId}`),
      actionLabel: 'WAR',
    };
  });
});

// --- Contract deadlines ---

const contractItems = computed<AlertItem[]>(() => {
  const active = contractsStore.active.value;
  if (!active) {
    return [];
  }
  const items: AlertItem[] = [];
  for (const contract of active) {
    for (const condition of contract.conditions) {
      if (condition.status === 'FULFILLED') {
        continue;
      }
      const deadline = calculateDeadline(contract, condition);
      if (!Number.isFinite(deadline) || deadline > timestampEachSecond.value + dayMs * 30) {
        continue;
      }
      const typeLabel = condition.type.replace(/_/g, ' ');
      const isSelf = condition.party === contract.party;
      items.push({
        category: '合同截止',
        title: `${contract.localId} — ${isSelf ? '我方' : '对方'}: ${typeLabel}`,
        naturalId: '',
        detail: contract.partner.name,
        deadline,
        action: () => showBuffer(`CONT ${contract.id}`),
        actionLabel: 'CONT',
      });
    }
  }
  return items;
});

// --- CoGC upkeep ---

const cogcItems = computed<AlertItem[]>(() => {
  return (cogcsStore.all.value ?? [])
    .filter(c => c.upkeep?.dueDate)
    .map(c => {
      const naturalId = c.planet.naturalId;
      const name = c.planet.name;
      const upkeep = c.upkeep!;
      const missing = upkeep.billOfMaterial
        .filter(x => x.currentAmount < x.amount)
        .map(x => x.material.ticker);

      return {
        category: 'CoGC 维护',
        title: `${name} (${naturalId})`,
        naturalId,
        detail: missing.length > 0 ? `缺: ${missing.join(', ')}` : '已足额',
        deadline: upkeep.dueDate.timestamp,
        action: () => showBuffer(`COGCU ${naturalId}`),
        actionLabel: 'COGCU',
      };
    });
});

// --- Elections ---

const electionItems = computed<AlertItem[]>(() => {
  const sites = sitesStore.all.value;
  if (!sites) {
    return [];
  }
  const items: AlertItem[] = [];
  const govStartedAt = getLatestAlertTimestampByPlanet('ADMIN_CENTER_ELECTION_STARTED');
  const govElectedAt = getLatestAlertTimestampByPlanet('ADMIN_CENTER_GOVERNOR_ELECTED');
  const govReminderAt = getLatestAlertTimestampByPlanet('ADMIN_CENTER_ELECTION_REMINDER');
  const cogcChangedAt = getLatestAlertTimestampByPlanet('COGC_PROGRAM_CHANGED');

  for (const site of sites) {
    const naturalId = getEntityNaturalIdFromAddress(site.address);
    const name = getEntityNameFromAddress(site.address);
    if (!naturalId || !name) {
      continue;
    }
    const key = naturalId.toUpperCase();

    // GOV
    const govWindow = getGovWindow(
      govStartedAt.get(key),
      govElectedAt.get(key),
      govReminderAt.get(key),
    );
    if (govWindow.deadline !== undefined) {
      items.push({
        category: '选举',
        title: `${name} (${naturalId})`,
        naturalId,
        detail: `GOV — ${govWindow.isOpen ? '投票中' : '即将开始'}`,
        deadline: govWindow.isOpen ? govWindow.end : govWindow.deadline,
        action: () => showBuffer(`ADM ${naturalId}`),
        actionLabel: 'ADM',
      });
    }

    // COGC
    const cogcWindow = getCogcWindow(cogcChangedAt.get(key));
    if (cogcWindow.deadline !== undefined) {
      items.push({
        category: '选举',
        title: `${name} (${naturalId})`,
        naturalId,
        detail: `COGC — ${cogcWindow.isOpen ? '投票中' : '即将开始'}`,
        deadline: cogcWindow.isOpen ? cogcWindow.end : cogcWindow.deadline,
        action: () => showBuffer(`COGCPEX ${naturalId}`),
        actionLabel: 'COGCPEX',
      });
    }
  }
  return items;
});

interface ElectionWindow {
  deadline?: number;
  isOpen?: boolean;
  end?: number;
}

function getGovWindow(started?: number, elected?: number, reminder?: number): ElectionWindow {
  let latestAt = -Infinity;
  let result: ElectionWindow = {};
  if (elected !== undefined && elected > latestAt) {
    latestAt = elected;
    const end = elected + dayMs * 20;
    result = {
      deadline: elected + dayMs * 20,
      isOpen: timestampEachSecond.value >= elected + dayMs * 12 && timestampEachSecond.value < end,
      end,
    };
  }
  if (started !== undefined && started > latestAt) {
    latestAt = started;
    const end = started + dayMs * 8;
    result = {
      deadline: started,
      isOpen: timestampEachSecond.value >= started && timestampEachSecond.value < end,
      end,
    };
  }
  if (reminder !== undefined && reminder > latestAt) {
    result = {
      deadline: reminder,
      isOpen: false,
      end: reminder + dayMs,
    };
  }
  return result;
}

function getCogcWindow(start?: number): ElectionWindow {
  if (start === undefined) {
    return {};
  }
  const end = start + dayMs * 7;
  return {
    deadline: start,
    isOpen: timestampEachSecond.value >= start && timestampEachSecond.value < end,
    end,
  };
}

function getLatestAlertTimestampByPlanet(type: PrunApi.AlertType) {
  const timestamps = new Map<string, number>();
  for (const alert of alertsStore.all.value ?? []) {
    if (alert.type !== type) {
      continue;
    }
    const naturalId = getNaturalIdFromAlert(alert)?.toUpperCase();
    if (!naturalId) {
      continue;
    }
    const timestamp = alert.time.timestamp;
    const existing = timestamps.get(naturalId);
    if (existing === undefined || timestamp > existing) {
      timestamps.set(naturalId, timestamp);
    }
  }
  return timestamps;
}

function getNaturalIdFromAlert(alert: PrunApi.Alert) {
  for (const item of alert.data) {
    if (item.key === 'planet' || item.key === 'address') {
      const address = (item.value as { address?: PrunApi.Address } | undefined)?.address;
      const naturalId = getEntityNaturalIdFromAddress(address);
      if (naturalId) {
        return naturalId;
      }
    }
  }
  return alert.naturalId;
}

// --- Expert ETA ---

const expertItems = computed<AlertItem[]>(() => {
  const sites = sitesStore.all.value;
  if (!sites) {
    return [];
  }
  const items: AlertItem[] = [];
  for (const site of sites) {
    const entry = expertsStore.getById(site.siteId);
    if (!entry) {
      continue;
    }
    const total = getTotalExperts(entry);
    if (total >= entry.limit) {
      continue;
    }
    const lines = (productionStore.getBySiteId(site.siteId) ?? []).filter(line =>
      line.efficiencyFactors.some(
        x => x.type === 'EXPERTS' && x.expertiseCategory === entry.category,
      ),
    );
    const eta = calculateEta(entry, lines);
    if (!eta) {
      continue;
    }
    const naturalId = getEntityNaturalIdFromAddress(site.address) ?? '';
    const name = getEntityNameFromAddress(site.address) ?? '';
    const deadline = eta.type === 'precise' ? eta.ms : timestampEachSecond.value + eta.ms;

    items.push({
      category: '专家进度',
      title: `${name} (${naturalId})`,
      naturalId,
      detail: `${entry.category} ${total}/${entry.limit} — ${eta.type === 'precise' ? '精确' : `~${(eta.ms / 86400000).toFixed(1)}d`}`,
      deadline,
      action: () => showBuffer(`EXP ${site.siteId}`),
      actionLabel: 'EXP',
    });
  }
  return items;
});

// --- Production halt ---

const productionItems = computed<AlertItem[]>(() => {
  const sites = sitesStore.all.value;
  if (!sites) {
    return [];
  }
  const items: AlertItem[] = [];
  for (const site of sites) {
    const lines = productionStore.getBySiteId(site.siteId);
    if (!lines) {
      continue;
    }
    const naturalId = getEntityNaturalIdFromAddress(site.address) ?? '';
    const name = getEntityNameFromAddress(site.address) ?? '';

    for (const line of lines) {
      const activeOrders = line.orders.filter(x => x.started !== null && !x.halted);
      const queuedOrders = line.orders.filter(x => x.started === null || x.halted);

      if (activeOrders.length === 0) {
        items.push({
          category: '产线停机',
          title: `${name} (${naturalId})`,
          naturalId,
          detail: `${line.type} — 完全空闲`,
          action: () => showBuffer(`PRODQ ${line.id}`),
          actionLabel: 'PRODQ',
        });
      } else if (queuedOrders.length === 0) {
        let earliest = Infinity;
        for (const order of activeOrders) {
          const completion = calcCompletionDate(line, order);
          if (completion !== undefined && completion < earliest) {
            earliest = completion;
          }
        }
        items.push({
          category: '产线停机',
          title: `${name} (${naturalId})`,
          naturalId,
          detail: `${line.type} — 队列已空 (${activeOrders.length}/${line.capacity})`,
          deadline: earliest === Infinity ? undefined : earliest,
          action: () => showBuffer(`PRODQ ${line.id}`),
          actionLabel: 'PRODQ',
        });
      } else if (activeOrders.length < line.capacity) {
        items.push({
          category: '产线停机',
          title: `${name} (${naturalId})`,
          naturalId,
          detail: `${line.type} — 有空槽 (${activeOrders.length}/${line.capacity})`,
          action: () => showBuffer(`PRODQ ${line.id}`),
          actionLabel: 'PRODQ',
        });
      }
    }
  }
  return items;
});

// --- Merge & sort ---

const allItems = computed<AlertItem[]>(() => {
  const items = [
    ...warehouseItems.value,
    ...contractItems.value,
    ...cogcItems.value,
    ...electionItems.value,
    ...expertItems.value,
    ...productionItems.value,
  ];
  items.sort((a, b) => {
    const aUrgent =
      a.deadline !== undefined && isExpired(a.deadline)
        ? 0
        : a.deadline !== undefined && isUrgent(a.deadline)
          ? 1
          : a.deadline !== undefined && isWarning(a.deadline)
            ? 2
            : a.deadline !== undefined
              ? 3
              : 4;
    const bUrgent =
      b.deadline !== undefined && isExpired(b.deadline)
        ? 0
        : b.deadline !== undefined && isUrgent(b.deadline)
          ? 1
          : b.deadline !== undefined && isWarning(b.deadline)
            ? 2
            : b.deadline !== undefined
              ? 3
              : 4;
    if (aUrgent !== bUrgent) {
      return aUrgent - bUrgent;
    }
    if (a.deadline !== undefined && b.deadline !== undefined) {
      return a.deadline - b.deadline;
    }
    return 0;
  });
  return items;
});

const fetched = computed(() => sitesStore.fetched.value && contractsStore.fetched.value);
</script>

<template>
  <LoadingSpinner v-if="!fetched" />
  <table v-else :style="{ width: '100%' }">
    <thead>
      <tr>
        <th>类别</th>
        <th>地点</th>
        <th>详情</th>
        <th>截止</th>
        <th>操作</th>
      </tr>
    </thead>
    <tbody>
      <tr v-if="allItems.length === 0">
        <td colspan="5" style="text-align: center; opacity: 0.5; padding: 12px">
          没有待处理的提醒
        </td>
      </tr>
      <tr v-for="(item, i) in allItems" :key="i">
        <td>{{ item.category }}</td>
        <td>
          <PrunLink v-if="item.naturalId" inline :command="`PLI ${item.naturalId}`">
            {{ item.title }}
            <BaseAlias :natural-id="item.naturalId" />
          </PrunLink>
          <template v-else>{{ item.title }}</template>
        </td>
        <td>{{ item.detail }}</td>
        <td :class="deadlineClass(item.deadline)" :style="deadlineStyle(item.deadline)">
          {{ item.deadline !== undefined ? formatDuration(item.deadline) : '--' }}
        </td>
        <td>
          <button
            v-if="item.action"
            :class="[C.Button.btn, C.Button.primary, C.Button.inline]"
            @click="item.action()">
            {{ item.actionLabel }}
          </button>
        </td>
      </tr>
    </tbody>
  </table>
</template>

<style scoped>
table {
  table-layout: auto;
}
tr > :not(:first-child) {
  text-align: right;
}
</style>
