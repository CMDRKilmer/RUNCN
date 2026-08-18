<script setup lang="ts">
import LoadingSpinner from '@src/components/LoadingSpinner.vue';
import MaterialIcon from '@src/components/MaterialIcon.vue';
import { showBuffer } from '@src/infrastructure/prun-ui/buffers';
import { getPrunId } from '@src/infrastructure/prun-ui/attributes';
import { localAdsStore } from '@src/infrastructure/prun-api/data/local-ads';
import {
  getEntityNameFromAddress,
  getEntityNaturalIdFromAddress,
  getSystemLineFromAddress,
} from '@src/infrastructure/prun-api/data/addresses';
import { exchangesStore } from '@src/infrastructure/prun-api/data/exchanges';
import { sitesStore } from '@src/infrastructure/prun-api/data/sites';
import { starsStore } from '@src/infrastructure/prun-api/data/stars';
import { cxStore } from '@src/infrastructure/fio/cx';
import { fixed1 } from '@src/utils/format';
import { sleep } from '@src/utils/sleep';

interface CxPrice {
  code: string;
  price: number;
  currency: string;
}

interface AdSpread {
  adId: number;
  location: string;
  marketNaturalId?: string;
  ticker: string;
  type: 'BUYING' | 'SELLING';
  lmPrice: number;
  nearestCx: CxPrice;
  highestCx: CxPrice;
  spread: number;
  spreadPct: number;
  quantity: number;
  currency: string;
}

// Planets where the player owns at least one base.
const ownedPlanetIds = computed(() => {
  const sites = sitesStore.all.value;
  if (!sites) {
    return undefined;
  }
  return new Set(sites.map(x => getEntityNaturalIdFromAddress(x.address)));
});

// LM ad data is only pushed while an LM panel is open. Silently open the BS
// panel (to get the owned base list) and then each owned planet's LM panel to
// trigger the server push. Each panel uses the same silent pattern as BURN's
// request hooks: autoClose keeps it hidden and closeWhen closes it once its
// ads arrive (or after a short timeout for empty markets).
const dataLoading = ref(true);

// Read the actual LM command from the tile containing each ad. LocalAd.address
// only contains the station/system, while the LMA command uses the full planet
// naturalId (for example: LMA VH-331a/92398).
const lmaCommandByAdId = shallowReactive(new Map<number, string>());

function collectLmaCommand(container: HTMLElement) {
  const prunId = getPrunId(container);
  if (!prunId) {
    return;
  }
  // DOM IDs are lower-case while EntityStore's getById uppercases its lookup.
  // Match case-insensitively so ad containers are associated with LocalAd data.
  const ad = localAdsStore.all.value?.find(x => x.id.toUpperCase() === prunId.toUpperCase());
  if (!ad) {
    return;
  }

  const tile = container.closest(`.${C.Tile.tile}`) as HTMLElement | null;
  if (!tile) {
    return;
  }
  const command = _$(tile, C.TileFrame.cmd)?.textContent?.trim();
  if (!command) {
    return;
  }

  const lmaCommand = command.match(/^LMA?\s*(.*)$/i);
  if (!lmaCommand) {
    return;
  }
  const value = lmaCommand[1].trim();
  if (!value) {
    return;
  }

  const lmaParts = value.split('/');
  let planetNaturalId: string | undefined;
  let adNaturalId: string | undefined;
  if (lmaParts.length === 2) {
    [planetNaturalId, adNaturalId] = lmaParts;
  } else if (!value.includes(' ')) {
    planetNaturalId = value;
    adNaturalId = String(ad.naturalId);
  }
  if (planetNaturalId && Number(adNaturalId) === ad.naturalId) {
    lmaCommandByAdId.set(ad.naturalId, `LMA ${planetNaturalId}/${adNaturalId}`);
  }
  if (command.toUpperCase().startsWith('LMA ')) {
    lmaCommandByAdId.set(ad.naturalId, command);
  }
}

subscribe($$(document, C.CommodityAd.container), collectLmaCommand);

async function autoLoadLm() {
  // The base list is only pushed while a base panel is open. Trigger it silently
  // so we know which planets we own.
  if (!sitesStore.fetched.value) {
    void showBuffer('BS', {
      autoClose: true,
      closeWhen: computed(() => sitesStore.fetched.value),
    }).catch(() => undefined);
    const sitesDeadline = Date.now() + 5000;
    while (!sitesStore.fetched.value && Date.now() < sitesDeadline) {
      await sleep(200);
    }
  }

  const planets = ownedPlanetIds.value;
  if (!planets || planets.size === 0) {
    return;
  }
  if (localAdsStore.all.value && localAdsStore.all.value.length > 0) {
    return;
  }

  // Open each owned planet's LM panel silently. Panels auto-close after a short
  // window, long enough for the ad DOM to render so the prun-id collector above
  // can read each ad's real identifier.
  const started = Date.now();
  for (const naturalId of planets) {
    void showBuffer(`LM ${naturalId}`, {
      force: true,
      autoClose: true,
      closeWhen: computed(() => Date.now() - started > 5000),
    }).catch(() => undefined);
  }

  // Wait for ads data before clearing the loading state.
  const deadline = Date.now() + 8000;
  while (
    Date.now() < deadline &&
    !(localAdsStore.all.value && localAdsStore.all.value.length > 0)
  ) {
    await sleep(200);
  }
}

onMounted(() => {
  void autoLoadLm()
    .catch(() => undefined)
    .finally(() => {
      dataLoading.value = false;
    });
});

const rows = computed<AdSpread[] | undefined>(() => {
  const ads = localAdsStore.all.value ?? [];
  const planets = ownedPlanetIds.value;
  if (dataLoading.value || !cxStore.fetched) {
    return undefined;
  }

  const result: AdSpread[] = [];
  for (const ad of ads) {
    if (ad.type !== 'COMMODITY_BUYING' && ad.type !== 'COMMODITY_SELLING') {
      continue;
    }

    // Filter to owned planets only when the base list is available; otherwise
    // fall back to showing all ads so the table is never blank.
    const lma = lmaCommandByAdId.get(ad.naturalId);
    const lmaPlanetId = lma?.match(/^LMA\s+([^/]+)\//)?.[1];
    const adPlanetId = lmaPlanetId ?? getEntityNaturalIdFromAddress(ad.address);
    if (planets && (!adPlanetId || !planets.has(adPlanetId))) {
      continue;
    }

    const quantity = ad.quantity;
    if (quantity === null || quantity.amount <= 0) {
      continue;
    }

    const ticker = quantity.material.ticker;
    if (!ticker) {
      continue;
    }

    const nearestCx = findNearestCx(ad.address, ticker);
    const highestCx = findHighestCx(ticker);
    if (!nearestCx || !highestCx) {
      continue;
    }

    const lmPrice = ad.price.amount / quantity.amount;
    const spread =
      ad.type === 'COMMODITY_SELLING' ? highestCx.price - lmPrice : lmPrice - highestCx.price;
    if (spread < 0) {
      continue;
    }
    const spreadPct = highestCx.price > 0 ? (spread / highestCx.price) * 100 : 0;

    const location = getEntityNameFromAddress(ad.address) ?? '';

    result.push({
      adId: ad.naturalId,
      location,
      marketNaturalId: lma,
      ticker,
      type: ad.type === 'COMMODITY_BUYING' ? 'BUYING' : 'SELLING',
      lmPrice,
      nearestCx,
      highestCx,
      spread,
      spreadPct,
      quantity: quantity.amount,
      currency: ad.price.currency,
    });
  }

  return result.sort((a, b) => b.spreadPct - a.spreadPct);
});

// Reads the CX buy (bid) price for a ticker at one exchange. The bid is what a
// seller would receive, so it is the relevant reference for hauling deals.
// Falls back to other reference prices so a row is not dropped when FIO has no
// live bid for a ticker.
function getBidPrice(ticker: string, exchange: PrunApi.Exchange) {
  const info = cxStore.prices.get(exchange.code)?.get(ticker);
  const price = info?.Bid ?? info?.VWAP7D ?? info?.PriceAverage ?? info?.Ask;
  return price === undefined || price === null || price <= 0 ? undefined : price;
}

// Resolves the position of the system an address belongs to.
function getSystemPosition(address?: PrunApi.Address): PrunApi.Position | undefined {
  const systemNaturalId = getSystemLineFromAddress(address)?.entity.naturalId;
  return systemNaturalId ? starsStore.getByNaturalId(systemNaturalId)?.position : undefined;
}

function distance(a: PrunApi.Position, b: PrunApi.Position) {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  const dz = a.z - b.z;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

// Finds the exchange whose system is closest to the ad's system.
function findNearestCx(address: PrunApi.Address, ticker: string): CxPrice | undefined {
  const position = getSystemPosition(address);
  if (!position) {
    return undefined;
  }

  let nearest: CxPrice | undefined;
  let nearestDistance = Infinity;
  for (const exchange of exchangesStore.all.value ?? []) {
    const price = getBidPrice(ticker, exchange);
    const exchangePosition = getSystemPosition(exchange.address);
    if (price === undefined || !exchangePosition) {
      continue;
    }
    const currentDistance = distance(position, exchangePosition);
    if (currentDistance < nearestDistance) {
      nearestDistance = currentDistance;
      nearest = { code: exchange.code, price, currency: exchange.currency.code };
    }
  }
  return nearest;
}

// Finds the exchange offering the highest buy (bid) price for the ticker.
function findHighestCx(ticker: string): CxPrice | undefined {
  let highest: CxPrice | undefined;
  for (const exchange of exchangesStore.all.value ?? []) {
    const price = getBidPrice(ticker, exchange);
    if (price === undefined) {
      continue;
    }
    if (!highest || price > highest.price) {
      highest = { code: exchange.code, price, currency: exchange.currency.code };
    }
  }
  return highest;
}

function formatCurrency(value: number, currency: string) {
  return `${value.toFixed(2)} ${currency}`;
}

function formatCx(cx: CxPrice) {
  return `${cx.code} ${formatCurrency(cx.price, cx.currency)}`;
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
        <th class="colItem">物品</th>
        <th class="colType">类型</th>
        <th>数量</th>
        <th>LM 单价</th>
        <th>最近CX</th>
        <th>最高CX</th>
        <th class="colSpread">价差</th>
        <th>价差%</th>
        <th class="colAction">操作</th>
      </tr>
    </thead>
    <tbody>
      <tr v-if="rows.length === 0">
        <td colspan="10" style="text-align: center; opacity: 0.5; padding: 12px">
          暂无 LM 广告数据
        </td>
      </tr>
      <tr v-for="row in rows" :key="row.adId">
        <td>{{ row.location }}</td>
        <td class="colItem">
          <MaterialIcon :ticker="row.ticker" size="small" compact />
        </td>
        <td class="colType">{{ row.type === 'BUYING' ? '收购' : '出售' }}</td>
        <td>{{ row.quantity.toLocaleString() }}</td>
        <td>{{ formatCurrency(row.lmPrice, row.currency) }}</td>
        <td>{{ formatCx(row.nearestCx) }}</td>
        <td>{{ formatCx(row.highestCx) }}</td>
        <td :class="[spreadClass(row.spreadPct), 'colSpread']">
          {{ formatCurrency(row.spread, row.currency) }}
        </td>
        <td :class="spreadClass(row.spreadPct)">{{ fixed1(row.spreadPct) }}%</td>
        <td class="colAction">
          <button
            v-if="row.marketNaturalId"
            :class="[C.Button.btn, C.Button.primary, C.Button.inline]"
            @click="showBuffer(row.marketNaturalId)">
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
.colItem {
  width: 32px;
}
.colType {
  width: 52px;
}
.colSpread {
  width: 90px;
}
.colAction {
  width: 56px;
}
</style>
