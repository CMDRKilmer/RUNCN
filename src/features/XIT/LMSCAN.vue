<script setup lang="ts">
import LoadingSpinner from '@src/components/LoadingSpinner.vue';
import PrunLink from '@src/components/PrunLink.vue';
import MaterialIcon from '@src/components/MaterialIcon.vue';
import { showBuffer } from '@src/infrastructure/prun-ui/buffers';
import { localAdsStore } from '@src/infrastructure/prun-api/data/local-ads';
import { getEntityNameFromAddress } from '@src/infrastructure/prun-api/data/addresses';
import { getPrice } from '@src/infrastructure/fio/cx';
import { fixed1 } from '@src/utils/format';

interface AdSpread {
  adId: string;
  location: string;
  ticker: string;
  type: 'BUYING' | 'SELLING';
  lmPrice: number;
  cxPrice: number;
  spread: number;
  spreadPct: number;
  quantity: number;
  currency: string;
}

const rows = computed<AdSpread[] | undefined>(() => {
  const ads = localAdsStore.all.value;
  if (!ads) {
    return undefined;
  }

  const result: AdSpread[] = [];
  for (const ad of ads) {
    if (ad.type !== 'COMMODITY_BUYING' && ad.type !== 'COMMODITY_SELLING') {
      continue;
    }

    const ticker = ad.quantity?.material.ticker;
    if (!ticker) {
      continue;
    }

    const cxPrice = getPrice(ticker);
    if (cxPrice === undefined || cxPrice === 0) {
      continue;
    }

    const lmPrice = ad.price.amount;
    const spread = ad.type === 'COMMODITY_SELLING' ? cxPrice - lmPrice : lmPrice - cxPrice;
    const spreadPct = cxPrice > 0 ? (spread / cxPrice) * 100 : 0;

    const location = getEntityNameFromAddress(ad.address) ?? '';

    result.push({
      adId: ad.id,
      location,
      ticker,
      type: ad.type === 'COMMODITY_BUYING' ? 'BUYING' : 'SELLING',
      lmPrice,
      cxPrice,
      spread,
      spreadPct,
      quantity: ad.quantity?.amount ?? 0,
      currency: ad.price.currency,
    });
  }

  return result.sort((a, b) => b.spreadPct - a.spreadPct);
});

function formatCurrency(value: number, currency: string) {
  return `${value.toFixed(2)} ${currency}`;
}

function spreadClass(pct: number) {
  if (pct > 10) {
    return C.ColoredValue.positive;
  }
  if (pct > 0) {
    return '';
  }
  return C.ColoredValue.negative;
}
</script>

<template>
  <LoadingSpinner v-if="rows === undefined" />
  <table v-else :style="{ width: '100%' }">
    <thead>
      <tr>
        <th>地点</th>
        <th>物品</th>
        <th>类型</th>
        <th>数量</th>
        <th>LM 价格</th>
        <th>CX 价格</th>
        <th>价差</th>
        <th>价差%</th>
        <th>操作</th>
      </tr>
    </thead>
    <tbody>
      <tr v-if="rows.length === 0">
        <td colspan="9" style="text-align: center; opacity: 0.5; padding: 12px">
          暂无 LM 广告数据 - 请打开 LM 面板
        </td>
      </tr>
      <tr v-for="row in rows" :key="row.adId">
        <td>{{ row.location }}</td>
        <td>
          <MaterialIcon :ticker="row.ticker" size="small" compact />
          <PrunLink inline :command="`MAT ${row.ticker}`">{{ row.ticker }}</PrunLink>
        </td>
        <td>{{ row.type === 'BUYING' ? '收购' : '出售' }}</td>
        <td>{{ row.quantity.toLocaleString() }}</td>
        <td>{{ formatCurrency(row.lmPrice, row.currency) }}</td>
        <td>{{ formatCurrency(row.cxPrice, row.currency) }}</td>
        <td :class="spreadClass(row.spreadPct)">
          {{ formatCurrency(row.spread, row.currency) }}
        </td>
        <td :class="spreadClass(row.spreadPct)">{{ fixed1(row.spreadPct) }}%</td>
        <td>
          <button
            :class="[C.Button.btn, C.Button.primary, C.Button.inline]"
            @click="showBuffer(`LMA ${row.adId}`)">
            LMA
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
