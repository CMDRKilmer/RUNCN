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
import TextInput from '@src/components/forms/TextInput.vue';
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
        <td>
          <TextInput
            :model-value="row.alias"
            @update:model-value="(v: string) => onAliasChange(row.siteId, v ?? '')" />
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
</style>
