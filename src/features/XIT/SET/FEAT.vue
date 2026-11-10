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

const filtered = computed(() => {
  const keywords = searchQuery.value
    .toLowerCase()
    .replaceAll(/\W/g, ' ')
    .split(/\s+/)
    .filter(Boolean); // Ignore empty strings
  if (keywords.length === 0) {
    return sorted;
  }
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
  <div>
    <form :class="$style.form">
      <Commands label="切换功能集">
        <PrunButton primary @click="onChangeModeClick">
          切换到 {{ isFullMode ? '基础模式' : '完整模式' }}
        </PrunButton>
      </Commands>
      <Active :class="$style.warningRoot" label="搜索">
        <TextInput v-model="searchQuery" />
        <PrunButton
          v-if="!isEmpty(Object.keys(changed))"
          primary
          :class="$style.warning"
          @click="onReloadClick">
          重启游戏以应用更改
        </PrunButton>
      </Active>
    </form>
    <SectionHeader>
      功能: {{ sorted.length }}
      <span v-if="disabledFeatures.size > 0">({{ disabledFeatures.size }} 已关闭) </span>
      <span v-if="!isFullMode">(+{{ advanced.length }} 个完整模式可用功能)</span>
    </SectionHeader>
    <table>
      <tbody>
        <tr v-for="feature in filtered" :key="feature.id">
          <td :class="$style.row" @click="toggleFeature(feature.id)">
            <div :class="[C.RadioItem.indicator, $style.indicator, toggleClass(feature.id)]" />
            <div>
              <div :class="$style.id">{{ feature.id }}</div>
              <div :class="$style.description">{{ feature.description }}</div>
            </div>
          </td>
        </tr>
      </tbody>
    </table>
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
  margin-bottom: 18px;
}

.warningRoot {
  position: relative;
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
  font-size: 11px;
  color: #888;
}

.warning {
  width: 100%;
  position: absolute;
  bottom: -100%;
}
</style>
