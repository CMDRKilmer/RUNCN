<script setup lang="ts">
// 基地别名管理面板：列出玩家所有基地，
// 已设置别名的可在此修改或清除，未设置的可直接填写新别名。
import { computed, reactive } from 'vue';
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

// 输入草稿：编辑期间只写本地草稿，不立即写回 userData，
// 避免每次按键触发 baseRows 重排导致列表跳动、输入框失焦。
const drafts = reactive<Record<string, string>>({});

function draftFor(siteId: string): string {
  return drafts[siteId] ?? userData.baseAliases[siteId] ?? '';
}

function onAliasInput(siteId: string, value: string) {
  drafts[siteId] = value;
}

function commitAlias(siteId: string) {
  const draft = drafts[siteId];
  if (draft === undefined) {
    return;
  }
  setBaseAlias(siteId, draft);
  delete drafts[siteId];
}

function onAliasBlur(siteId: string) {
  commitAlias(siteId);
}

function onAliasEnter(siteId: string, event: KeyboardEvent) {
  commitAlias(siteId);
  (event.target as HTMLInputElement).blur();
}

function onAliasEscape(siteId: string, event: KeyboardEvent) {
  delete drafts[siteId];
  (event.target as HTMLInputElement).blur();
}

function onClear(siteId: string) {
  delete drafts[siteId];
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
            :value="draftFor(row.siteId)"
            :class="$style.aliasInput"
            type="text"
            autocomplete="off"
            spellcheck="false"
            placeholder="输入别名…"
            @input="onAliasInput(row.siteId, ($event.target as HTMLInputElement).value)"
            @blur="onAliasBlur(row.siteId)"
            @keydown.enter.prevent="onAliasEnter(row.siteId, $event)"
            @keydown.esc="onAliasEscape(row.siteId, $event)" />
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
