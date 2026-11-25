<script lang="ts">
const changed = reactive({});
</script>

<script setup lang="ts">
import SectionHeader from '@src/components/SectionHeader.vue';
import Active from '@src/components/forms/Active.vue';
import TextInput from '@src/components/forms/TextInput.vue';
import { computed, ref } from 'vue';
import { isEmpty } from 'ts-extras';
import PrunButton from '@src/components/PrunButton.vue';
import { userData } from '@src/store/user-data';
import removeArrayElement from '@src/utils/remove-array-element';
import { saveUserData } from '@src/infrastructure/storage/user-data-serializer';
import Commands from '@src/components/forms/Commands.vue';
import { FEATURE_GROUPS, getFeatureGroup, type FeatureGroupId } from '@src/features/feature-groups';

if (userData.settings.mode === undefined) {
  userData.settings.mode = 'BASIC';
}

const isFullMode = userData.settings.mode === 'FULL';

// BSN 产物自动装船的开关已搬到 XIT FB 面板内 XIT FLT 的标题栏右侧
// （basic/flt-autoload-toggle.tsx），此页不再重复放开关。
// 下方列表仍按 feature registry 的 hidden 过滤，避免与其它专门设置项重复。
const listed = features.registry.filter(x => !x.hidden);

const disabledFeatures = computed(
  () => new Set(userData.settings.disabled.filter(id => listed.some(x => x.id === id))),
);

const available = isFullMode ? listed : listed.filter(x => !x.advanced);

const advanced = listed.filter(x => x.advanced);

const sorted = available.sort((a, b) => {
  const aDisabled = disabledFeatures.value.has(a.id);
  const bDisabled = disabledFeatures.value.has(b.id);
  if (aDisabled && !bDisabled) {
    return -1;
  }
  if (!aDisabled && bDisabled) {
    return 1;
  }
  return a.id.localeCompare(b.id);
});

const searchIndex = new Map<string, string>();
for (const feature of sorted) {
  searchIndex.set(feature.id, `${feature.id} ${feature.description}`.toLowerCase());
}

const searchQuery = ref('');

// ── 分组标签 ────────────────────────────────────────────────
// 分组见 src/features/feature-groups.ts（显式映射 + 命令前缀兜底）。
// 选中项记在 userData.settings.featureGroup，重开 XIT SET 停在上次那一组。
type GroupTab = FeatureGroupId | 'all';

const group = ref<GroupTab>((userData.settings.featureGroup as GroupTab | undefined) ?? 'all');

function selectGroup(next: GroupTab) {
  group.value = next;
  userData.settings.featureGroup = next;
  void saveUserData();
}

// 数量按当前模式可见的功能算（BASIC 下不含完整模式专属功能）。
const groupTabs = computed(() => {
  const list = available;
  return [
    { id: 'all' as GroupTab, name: '全部', hint: '不分组，显示全部功能', count: list.length },
    ...FEATURE_GROUPS.map(g => ({
      id: g.id as GroupTab,
      name: g.name,
      hint: g.hint,
      count: list.filter(feature => getFeatureGroup(feature.id) === g.id).length,
    })),
  ];
});

const filtered = computed(() => {
  // 功能列表里 id 是英文、说明是中文，所以切词必须按 Unicode 字母/数字走。
  // 原写法 `.replaceAll(/\W/g, ' ')` 里 \W 只保留 [A-Za-z0-9_]，中文会被整段替换成
  // 空格，于是中文查询切出 0 个关键词、直接返回全部功能（表现为「搜中文没用」）。
  const keywords = searchQuery.value
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean); // Ignore empty strings
  if (keywords.length === 0) {
    // 没在搜索：按当前分组过滤。
    if (group.value === 'all') {
      return sorted;
    }
    return sorted.filter(feature => getFeatureGroup(feature.id) === group.value);
  }
  // 有搜索词时跨全部分组搜，避免「明明有这个功能、只是不在当前标签下」搜不到。
  return sorted.filter(feature => keywords.some(x => searchIndex.get(feature.id)!.includes(x)));
});

function toggleFeature(id: string) {
  if (changed[id]) {
    delete changed[id];
  } else {
    changed[id] = true;
  }
  const disabled = userData.settings.disabled;
  if (disabledFeatures.value.has(id)) {
    removeArrayElement(disabled, id);
  } else {
    disabled.push(id);
  }
  void saveUserData();
}

function toggleClass(id: string) {
  return disabledFeatures.value.has(id) ? undefined : [C.RadioItem.active, C.effects.shadowPrimary];
}

async function onReloadClick() {
  await saveUserData();
  window.location.reload();
}

async function onChangeModeClick() {
  if (isFullMode) {
    userData.settings.mode = 'BASIC';
  } else {
    userData.settings.mode = 'FULL';
  }
  await saveUserData();
  window.location.reload();
}
</script>

<template>
  <div :class="$style.root">
    <form :class="$style.form">
      <Commands label="切换功能集">
        <PrunButton primary @click="onChangeModeClick">
          切换到 {{ isFullMode ? '基础模式' : '完整模式' }}
        </PrunButton>
      </Commands>
      <Active :class="$style.warningRoot" label="搜索">
        <TextInput
          v-model="searchQuery"
          :class="$style.searchInput"
          placeholder="搜索 id 或中文说明"
          title="可搜英文功能 id 或中文说明，例如：库存 / 维修 / cxob" />
        <PrunButton
          v-if="!isEmpty(Object.keys(changed))"
          primary
          :class="$style.warning"
          @click="onReloadClick">
          重启游戏以应用更改
        </PrunButton>
      </Active>
    </form>
    <SectionHeader :class="$style.compactHeader">
      功能: {{ filtered.length }}
      <span v-if="filtered.length !== sorted.length"> / {{ sorted.length }}</span>
      <span v-if="disabledFeatures.size > 0">({{ disabledFeatures.size }} 已关闭) </span>
      <span v-if="!isFullMode">(+{{ advanced.length }} 个完整模式可用功能)</span>
    </SectionHeader>
    <div :class="$style.groups">
      <button
        v-for="tab in groupTabs"
        :key="tab.id"
        type="button"
        :class="[$style.groupTab, group === tab.id && $style.groupTabActive]"
        :title="tab.hint"
        @click="selectGroup(tab.id)">
        {{ tab.name }}
        <span :class="$style.groupCount">{{ tab.count }}</span>
      </button>
    </div>
    <div :class="$style.grid">
      <div
        v-for="feature in filtered"
        :key="feature.id"
        :class="$style.cell"
        @click="toggleFeature(feature.id)">
        <div :class="[C.RadioItem.indicator, $style.indicator, toggleClass(feature.id)]" />
        <div :class="$style.cellBody">
          <div :class="$style.id">{{ feature.id }}</div>
          <div :class="$style.description">{{ feature.description }}</div>
        </div>
      </div>
    </div>
    <template v-if="!isFullMode">
      <SectionHeader>完整模式功能</SectionHeader>
      <table>
        <tbody>
          <tr v-for="feature in advanced" :key="feature.id">
            <td :class="[$style.row, $style.rowFull]">
              <div :class="[C.RadioItem.indicator, C.RadioItem.disabled, $style.indicator]" />
              <div>
                <div :class="$style.id">{{ feature.id }}</div>
                <div :class="$style.description">{{ feature.description }}</div>
              </div>
            </td>
          </tr>
        </tbody>
      </table>
    </template>
  </div>
</template>

<style module>
.form {
  position: sticky;
  top: 0;
  background-color: #222222;
  z-index: 1;
  /* 原来是 18px，加上 SectionHeader 自带的 6+6 margin / 4px padding，
     从设置区到功能列表空了 73px，浪费一整行。这里压到 6px。 */
  margin-bottom: 6px;
}

/* 「功能: N」这行紧贴搜索框、紧贴分组标签：
   SectionHeader 原生 margin 6/6 + padding-top 4 全部收掉。 */
/* 搜索框只有 179px 宽，原来的中文提示（285px）必然被截断。这里把输入框字号
   调小一档，提示文字缩到「搜索 id 或中文说明」，例子放进 title 悬浮提示。
   字号跟随主题字号设置（--rp-font-enlargement）一起放大。 */
.searchInput input {
  font-size: calc(9px + 1px * var(--rp-font-enlargement));
  width: 100%;
  box-sizing: border-box;
}

.compactHeader {
  margin: 0 0 4px !important;
  padding-top: 0 !important;
  padding-bottom: 0 !important;
}

.warningRoot {
  position: relative;
}

.groups {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  margin-bottom: 6px;
}

.groupTab {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 2px 8px;
  background: transparent;
  border: 1px solid #3a4a55;
  border-radius: 10px;
  color: #a8b6c0;
  font-size: calc(10px + 1px * var(--rp-font-enlargement));
  cursor: pointer;
}

.groupTab:hover {
  border-color: #5f7382;
  color: #d7e1e8;
}

/* 选中态沿用游戏 RadioItem 的橙色系，不引入新的强调色 */
.groupTabActive {
  border-color: #f7a600;
  color: #f7a600;
}

.groupCount {
  opacity: 0.65;
}

/* 磁贴宽度由玩家拖动，媒体查询看的是视口而不是磁贴，所以用容器查询：
   默认两栏，容器窄于 620px 时回退单栏。不用 auto-fit —— 宽窗口会排成三栏，
   每栏只剩 270px，中文说明被挤到三四行反而更难读。 */
.root {
  container-type: inline-size;
}

.grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  column-gap: 18px;
}

@container (max-width: 620px) {
  .grid {
    grid-template-columns: minmax(0, 1fr);
  }
}

.cell {
  display: flex;
  flex-direction: row;
  align-items: stretch;
  align-self: start;
  cursor: pointer;
  padding: 4px 0;
  border-bottom: 1px solid rgba(128, 128, 128, 0.16);
  min-width: 0;
}

.cellBody {
  min-width: 0;
  flex: 1 1 auto;
}

.row {
  display: flex;
  flex-direction: row;
  cursor: pointer;
}

.rowFull {
  cursor: not-allowed;
}

.indicator {
  height: 12px;
}

.id {
  font-weight: bold;
  margin-bottom: 4px;
}

.description {
  font-size: calc(10px + 1px * var(--rp-font-enlargement));
  color: #888;
}

.warning {
  width: 100%;
  position: absolute;
  bottom: -100%;
}
</style>
