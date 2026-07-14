<script setup lang="ts">
import { computed } from 'vue';
import LoadingSpinner from '@src/components/LoadingSpinner.vue';
import { localAdsStore } from '@src/infrastructure/prun-api/data/local-ads';
import { companyStore } from '@src/infrastructure/prun-api/data/company';
import {
  getEntityNaturalIdFromAddress,
  getDestinationName,
} from '@src/infrastructure/prun-api/data/addresses';
import { timestampEachMinute } from '@src/utils/dayjs';
import { fixed0, fixed2 } from '@src/utils/format';
import { isEmpty } from 'ts-extras';
import { showBuffer } from '@src/infrastructure/prun-ui/buffers';
import $style from '../CONTS/conts-shared.module.css';

const DAY_MS = 24 * 60 * 60 * 1000;

// 仅展示自己创建的在挂广告
const ownAds = computed(() => {
  const companyId = companyStore.value?.id;
  if (!companyId) return [];
  return (localAdsStore.all.value ?? [])
    .filter(ad => ad.creator.id === companyId && ad.status === 'ACTIVE')
    .sort((a, b) => a.expiry.timestamp - b.expiry.timestamp);
});

const buyAds = computed(() => ownAds.value.filter(ad => ad.type === 'COMMODITY_BUYING'));
const sellAds = computed(() => ownAds.value.filter(ad => ad.type === 'COMMODITY_SELLING'));
const shippingAds = computed(() => ownAds.value.filter(ad => ad.type === 'COMMODITY_SHIPPING'));

// 到期剩余毫秒
function remainingMs(ad: PrunApi.LocalAd) {
  return ad.expiry.timestamp - timestampEachMinute.value;
}

function expiryStyle(ad: PrunApi.LocalAd) {
  const r = remainingMs(ad);
  if (r < DAY_MS) return 'color: #d9534f';
  if (r < DAY_MS * 3) return 'color: #f0ad4e';
  return '';
}

function expiryText(ad: PrunApi.LocalAd) {
  const r = remainingMs(ad);
  if (r <= 0) return '已过期';
  const days = Math.floor(r / DAY_MS);
  const hours = Math.floor((r % DAY_MS) / (60 * 60 * 1000));
  if (days > 0) return `${days}d ${hours}h`;
  const minutes = Math.floor((r % (60 * 60 * 1000)) / (60 * 1000));
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

function originName(ad: PrunApi.LocalAd) {
  return getEntityNaturalIdFromAddress(ad.address) ?? '--';
}

function destinationName(ad: PrunApi.LocalAd) {
  return getDestinationName(ad.destination) ?? '--';
}

function materialTicker(ad: PrunApi.LocalAd) {
  return ad.quantity?.material.ticker ?? '--';
}

function typeLabel(t: PrunApi.LocalAdType) {
  switch (t) {
    case 'COMMODITY_BUYING':
      return '求购';
    case 'COMMODITY_SELLING':
      return '出售';
    case 'COMMODITY_SHIPPING':
      return '运输';
  }
}

// 求购总额（按币种汇总）
const buyTotals = computed(() => {
  const m = new Map<string, number>();
  for (const ad of buyAds.value) {
    if (!ad.quantity) continue;
    const cur = ad.price.currency;
    m.set(cur, (m.get(cur) ?? 0) + ad.quantity.amount * ad.price.amount);
  }
  return m;
});

// 出售总额（按币种汇总）
const sellTotals = computed(() => {
  const m = new Map<string, number>();
  for (const ad of sellAds.value) {
    if (!ad.quantity) continue;
    const cur = ad.price.currency;
    m.set(cur, (m.get(cur) ?? 0) + ad.quantity.amount * ad.price.amount);
  }
  return m;
});

function formatMap(m: Map<string, number>) {
  if (m.size === 0) return '--';
  return Array.from(m.entries())
    .map(([cur, val]) => `${fixed0(val)} ${cur}`)
    .join(' | ');
}

function openLM(ad: PrunApi.LocalAd) {
  const planet = getEntityNaturalIdFromAddress(ad.address);
  if (planet) {
    void showBuffer(`LM ${planet}`);
  }
}
</script>

<template>
  <LoadingSpinner v-if="!localAdsStore.fetched" />
  <div v-else :class="[$style.container, C.type.typeRegular, C.fonts.fontRegular]">
    <!-- 求购广告 -->
    <table>
      <thead>
        <tr>
          <th colspan="7" :class="$style.sectionHeader">
            📥 求购广告
            <span v-if="!isEmpty(buyAds)" :class="$style.summary">
              共 {{ buyAds.length }} 单 | 求购总额: {{ formatMap(buyTotals) }}
            </span>
          </th>
        </tr>
        <tr>
          <th>物料</th>
          <th>数量</th>
          <th>单价</th>
          <th>总额</th>
          <th>星球</th>
          <th>状态</th>
          <th>到期</th>
        </tr>
      </thead>
      <tbody>
        <tr v-if="isEmpty(buyAds)">
          <td colspan="7" :class="$style.empty">无在挂求购广告</td>
        </tr>
        <tr v-for="ad in buyAds" :key="ad.id">
          <td>{{ materialTicker(ad) }}</td>
          <td :class="C.ComExOrdersTable.number">{{ fixed0(ad.quantity?.amount ?? 0) }}</td>
          <td :class="C.ComExOrdersTable.number"
            >{{ fixed2(ad.price.amount) }} {{ ad.price.currency }}</td
          >
          <td :class="[$style.payable, C.ComExOrdersTable.number]">
            {{ fixed0((ad.quantity?.amount ?? 0) * ad.price.amount) }} {{ ad.price.currency }}
          </td>
          <td>
            <span :class="C.Link.link" @click="openLM(ad)">{{ originName(ad) }}</span>
          </td>
          <td>{{ typeLabel(ad.type) }}</td>
          <td :style="expiryStyle(ad)">{{ expiryText(ad) }}</td>
        </tr>
      </tbody>
    </table>

    <!-- 出售广告 -->
    <table :class="$style.secondTable">
      <thead>
        <tr>
          <th colspan="7" :class="$style.sectionHeader">
            📤 出售广告
            <span v-if="!isEmpty(sellAds)" :class="$style.summary">
              共 {{ sellAds.length }} 单 | 出售总额: {{ formatMap(sellTotals) }}
            </span>
          </th>
        </tr>
        <tr>
          <th>物料</th>
          <th>数量</th>
          <th>单价</th>
          <th>总额</th>
          <th>星球</th>
          <th>状态</th>
          <th>到期</th>
        </tr>
      </thead>
      <tbody>
        <tr v-if="isEmpty(sellAds)">
          <td colspan="7" :class="$style.empty">无在挂出售广告</td>
        </tr>
        <tr v-for="ad in sellAds" :key="ad.id">
          <td>{{ materialTicker(ad) }}</td>
          <td :class="C.ComExOrdersTable.number">{{ fixed0(ad.quantity?.amount ?? 0) }}</td>
          <td :class="C.ComExOrdersTable.number"
            >{{ fixed2(ad.price.amount) }} {{ ad.price.currency }}</td
          >
          <td :class="[$style.receivable, C.ComExOrdersTable.number]">
            {{ fixed0((ad.quantity?.amount ?? 0) * ad.price.amount) }} {{ ad.price.currency }}
          </td>
          <td>
            <span :class="C.Link.link" @click="openLM(ad)">{{ originName(ad) }}</span>
          </td>
          <td>{{ typeLabel(ad.type) }}</td>
          <td :style="expiryStyle(ad)">{{ expiryText(ad) }}</td>
        </tr>
      </tbody>
    </table>

    <!-- 运输广告 -->
    <table :class="$style.secondTable">
      <thead>
        <tr>
          <th colspan="7" :class="$style.sectionHeader">
            🚚 运输广告
            <span v-if="!isEmpty(shippingAds)" :class="$style.summary">
              共 {{ shippingAds.length }} 单
            </span>
          </th>
        </tr>
        <tr>
          <th>物料</th>
          <th>数量</th>
          <th>单价</th>
          <th>起点</th>
          <th>终点</th>
          <th>状态</th>
          <th>到期</th>
        </tr>
      </thead>
      <tbody>
        <tr v-if="isEmpty(shippingAds)">
          <td colspan="7" :class="$style.empty">无在挂运输广告</td>
        </tr>
        <tr v-for="ad in shippingAds" :key="ad.id">
          <td>{{ materialTicker(ad) }}</td>
          <td :class="C.ComExOrdersTable.number">{{ fixed0(ad.quantity?.amount ?? 0) }}</td>
          <td :class="C.ComExOrdersTable.number"
            >{{ fixed2(ad.price.amount) }} {{ ad.price.currency }}</td
          >
          <td>
            <span :class="C.Link.link" @click="openLM(ad)">{{ originName(ad) }}</span>
          </td>
          <td>{{ destinationName(ad) }}</td>
          <td>{{ typeLabel(ad.type) }}</td>
          <td :style="expiryStyle(ad)">{{ expiryText(ad) }}</td>
        </tr>
      </tbody>
    </table>
  </div>
</template>
