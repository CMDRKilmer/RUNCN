<script setup lang="ts">
// 基地别名管理面板：列出玩家所有基地，
// 已设置别名的可在此修改或清除，未设置的可直接填写新别名。
import { computed } from 'vue';
import { userData } from '@src/store/user-data';
import { sitesStore } from '@src/infrastructure/prun-api/data/sites';
import { getEntityNameFromAddress } from '@src/infrastructure/prun-api/data/addresses';
import { setBaseAlias, clearBaseAlias } from '@src/core/base-aliases';
import PrunButton from '@src/components/PrunButton.vue';
import PrunLink from '@src/components/PrunLink.vue';
import SectionHeader from '@src/components/SectionHeader.vue';

interface BaseRow {
  siteId: string;
  naturalId: string;
  planetName: string;
  alias: string;
}

const baseRows = computed<BaseRow[]>(() => {
  const allSites = sitesStore.all.value ?? [];
  const out: BaseRow[] = [];
  for (const site of allSites) {
    const naturalId = site.address.lines.find(x => x.type === 'PLANET')?.entity.naturalId;
    if (!naturalId) {
      continue;
    }
    out.push({
      siteId: site.siteId,
      naturalId,
      planetName: getEntityNameFromAddress(site.address) ?? naturalId,
      alias: userData.baseAliases[site.siteId] ?? '',
    });
  }
  // 有别名的基地按别名排序；其余按 naturalId 排在末尾。
  out.sort((a, b) => {
    if (a.alias && b.alias) {
      return a.alias.toLowerCase().localeCompare(b.alias.toLowerCase());
    }
    if (a.alias) {
      return -1;
    }
    if (b.alias) {
      return 1;
    }
    return a.naturalId.localeCompare(b.naturalId);
  });
  return out;
});

const aliasedCount = computed(() => baseRows.value.filter(x => x.alias.length > 0).length);

function onAliasChange(siteId: string, value: string) {
  setBaseAlias(siteId, value);
}

function onClear(siteId: string) {
  clearBaseAlias(siteId);
}
</script>

<template>
  <SectionHeader>基地别名（{{ aliasedCount }} / {{ baseRows.length }}）</SectionHeader>
  <table v-if="baseRows.length > 0">
    <thead>
      <tr>
        <th>别名</th>
        <th>基地</th>
        <th>星球标识符</th>
        <th />
      </tr>
    </thead>
    <tbody>
      <tr v-for="row in baseRows" :key="row.siteId">
        <td :class="$style.aliasCell">
          <input
            :value="row.alias"
            :class="$style.aliasInput"
            type="text"
            autocomplete="off"
            spellcheck="false"
            placeholder="输入别名…"
            @input="onAliasChange(row.siteId, ($event.target as HTMLInputElement).value)" />
        </td>
        <td>{{ row.planetName }}</td>
        <td>
          <PrunLink :command="`BS ${row.naturalId}`">{{ row.naturalId }}</PrunLink>
        </td>
        <td>
          <PrunButton danger :disabled="!row.alias" @click="onClear(row.siteId)">清除</PrunButton>
        </td>
      </tr>
    </tbody>
  </table>
  <div v-else :class="$style.empty">还没有任何基地。先建一个基地再来设置别名。</div>
</template>

<style module>
.empty {
  padding: 10px;
  color: #888;
}

.aliasCell {
  width: 140px;
  padding: 2px;
}

.aliasInput {
  width: 100%;
  box-sizing: border-box;
  background-color: rgba(255, 255, 255, 0.06);
  border: 1px solid rgba(255, 255, 255, 0.18);
  border-radius: 2px;
  color: #e0e0e0;
  padding: 3px 6px;
  font-family: inherit;
  font-size: 12px;
  line-height: 1.4;
}

.aliasInput:hover {
  border-color: rgba(255, 255, 255, 0.32);
}

.aliasInput:focus {
  outline: none;
  border-color: #66afe9;
  background-color: rgba(255, 255, 255, 0.09);
}

.aliasInput::placeholder {
  color: rgba(255, 255, 255, 0.35);
}
</style>
