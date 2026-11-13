<script setup lang="ts">
import { computed, ref } from 'vue';
import SectionHeader from '@src/components/SectionHeader.vue';
import Active from '@src/components/forms/Active.vue';
import TextInput from '@src/components/forms/TextInput.vue';
import Commands from '@src/components/forms/Commands.vue';
import PrunButton from '@src/components/PrunButton.vue';
import { userData } from '@src/store/user-data';
import {
  ALL_NOTIFICATION_TYPES,
  DEFAULT_DESKTOP_NOTIFICATION_TYPES,
  NOTIFICATION_GROUPS,
} from '@src/infrastructure/prun-api/data/notification-catalog';

const enabled = computed(() => userData.settings.desktopNotificationTypes);
const permission = ref(Notification.permission);
const searchQuery = ref('');

const permissionText = computed(() => {
  switch (permission.value) {
    case 'granted':
      return '已授权';
    case 'denied':
      return '已被浏览器拒绝';
    default:
      return '未授权';
  }
});

function isEnabled(type: string) {
  return enabled.value.includes(type);
}

function toggle(type: string) {
  const list = userData.settings.desktopNotificationTypes;
  const index = list.indexOf(type);
  if (index >= 0) {
    list.splice(index, 1);
  } else {
    list.push(type);
  }
}

function setAll(on: boolean) {
  const list = userData.settings.desktopNotificationTypes;
  list.splice(0, list.length, ...(on ? ALL_NOTIFICATION_TYPES : []));
}

function setDefaults() {
  const list = userData.settings.desktopNotificationTypes;
  list.splice(0, list.length, ...DEFAULT_DESKTOP_NOTIFICATION_TYPES);
}

function toggleGroup(types: string[], on: boolean) {
  const list = userData.settings.desktopNotificationTypes;
  for (const type of types) {
    const index = list.indexOf(type);
    if (on && index < 0) {
      list.push(type);
    }
    if (!on && index >= 0) {
      list.splice(index, 1);
    }
  }
}

async function requestPermission() {
  if (Notification.permission === 'default') {
    await Notification.requestPermission();
  }
  permission.value = Notification.permission;
}

function sendTestNotification() {
  permission.value = Notification.permission;
  if (Notification.permission !== 'granted') {
    return;
  }
  new Notification('APEX — 测试', {
    body: '桌面通知测试：看到这条消息说明浏览器通知权限正常。',
    tag: 'apex-dnot-test',
    icon: '/favicon.ico',
  });
}

const groups = computed(() => {
  const query = searchQuery.value.trim().toLowerCase();
  return NOTIFICATION_GROUPS.map(group => ({
    label: group.label,
    types: query
      ? group.types.filter(
          entry =>
            entry.name.toLowerCase().includes(query) || entry.type.toLowerCase().includes(query),
        )
      : group.types,
  })).filter(group => group.types.length > 0);
});

function groupEnabledCount(types: { type: string }[]) {
  return types.filter(entry => isEnabled(entry.type)).length;
}
</script>

<template>
  <div :class="$style.root">
    <form>
      <Active label="浏览器通知权限">
        <span :class="$style.statusText">{{ permissionText }}</span>
        <PrunButton v-if="permission === 'default'" primary @click="requestPermission">
          请求授权
        </PrunButton>
      </Active>
      <Commands label="批量设置">
        <PrunButton primary @click="setAll(true)">全部开启</PrunButton>
        <PrunButton @click="setAll(false)">全部关闭</PrunButton>
        <PrunButton @click="setDefaults">仅常用</PrunButton>
        <PrunButton @click="sendTestNotification">发送测试通知</PrunButton>
      </Commands>
      <Active label="搜索">
        <TextInput v-model="searchQuery" />
      </Active>
    </form>
    <div :class="$style.summary">
      已开启 {{ enabled.length }} / {{ ALL_NOTIFICATION_TYPES.length }} 种通知类型
    </div>
    <p :class="$style.hint">
      只有勾选的类型会推送到浏览器桌面通知，改动即时生效、无需刷新。XIT SET → 功能 里的
      nots-desktop-notifications 是总开关，关闭后本页设置不再生效。
    </p>
    <p v-if="permission === 'denied'" :class="$style.hint">
      浏览器已拒绝该站点的通知权限，插件无法自行恢复：请到浏览器「网站设置 → 通知」把
      apex.prosperousuniverse.com 改回允许。
    </p>
    <template v-for="group in groups" :key="group.label">
      <SectionHeader :class="$style.groupHeader">
        {{ group.label }}（{{ groupEnabledCount(group.types) }}/{{ group.types.length }}）
        <span :class="$style.headerActions">
          <PrunButton
            :class="$style.groupBtn"
            @click="
              toggleGroup(
                group.types.map(x => x.type),
                true,
              )
            "
            >本组全开</PrunButton
          >
          <PrunButton
            :class="$style.groupBtn"
            @click="
              toggleGroup(
                group.types.map(x => x.type),
                false,
              )
            "
            >本组全关</PrunButton
          >
        </span>
      </SectionHeader>
      <div :class="$style.rows">
        <label
          v-for="entry in group.types"
          :key="entry.type"
          :class="$style.row"
          :data-dnot-type="entry.type">
          <input type="checkbox" :checked="isEnabled(entry.type)" @change="toggle(entry.type)" />
          <span :class="$style.name">{{ entry.name }}</span>
        </label>
      </div>
    </template>
  </div>
</template>

<style module>
.root {
  padding: 2px 6px 8px;
}

.statusText {
  margin-right: 8px;
  font-size: 12px;
}

.summary {
  font-size: 12px;
  margin: 4px 0 2px;
}

.hint {
  font-size: 12px;
  line-height: 1.4;
  margin: 2px 0 6px;
}

.groupHeader {
  margin: 2px 0 !important;
}

.headerActions {
  display: inline-flex;
  gap: 4px;
  /* 紧挨组名与计数，不再推到标题行最右端。 */
  margin-left: 6px;
}

.groupBtn {
  height: 16px;
  line-height: 14px;
  padding: 0 6px;
  font-size: 11px;
}

.rows {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(150px, 1fr));
  gap: 1px 8px;
  margin-bottom: 3px;
}

.row {
  display: flex;
  align-items: center;
  gap: 6px;
  cursor: pointer;
  font-size: 12px;
  min-width: 0;
}

.name {
  flex: 0 0 auto;
  white-space: nowrap;
}
</style>
