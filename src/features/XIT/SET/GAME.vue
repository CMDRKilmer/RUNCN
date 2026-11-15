<script setup lang="ts">
import PrunButton from '@src/components/PrunButton.vue';
import SectionHeader from '@src/components/SectionHeader.vue';
import Tooltip from '@src/components/Tooltip.vue';
import TextInput from '@src/components/forms/TextInput.vue';
import Active from '@src/components/forms/Active.vue';
import NumberInput from '@src/components/forms/NumberInput.vue';
import Commands from '@src/components/forms/Commands.vue';
import { showConfirmationOverlay } from '@src/infrastructure/prun-ui/tile-overlay';
import { showBuffer } from '@src/infrastructure/prun-ui/buffers';
import { initialUserData, userData } from '@src/store/user-data';
import {
  downloadBackup,
  exportUserData,
  importUserData,
  resetUserData,
  restoreBackup,
  saveUserData,
} from '@src/infrastructure/storage/user-data-serializer';
import SelectInput from '@src/components/forms/SelectInput.vue';
import { objectId } from '@src/utils/object-id';
import {
  deleteUserDataBackup,
  getUserDataBackups,
  UserDataBackup,
} from '@src/infrastructure/storage/user-data-backup';
import { ddmmyyyy, hhForXitSet, hhmm } from '@src/utils/format';
import dayjs from 'dayjs';
import { vDraggable } from 'vue-draggable-plus';
import { grip } from '@src/components/grip';
import GripChar from '@src/components/grip/GripChar.vue';

const isDefault24 = computed(() => {
  return hhForXitSet.value(dayjs.duration(12, 'hours').asMilliseconds()) === '13';
});

const timeFormats = computed(() => {
  return [
    {
      label: '24h',
      value: '24H',
    },
    {
      label: '12h',
      value: '12H',
    },
  ] as { label: string; value: UserData.TimeFormat }[];
});

const timeFormat = computed({
  get: () => {
    const format = userData.settings.time;
    if (format === 'DEFAULT') {
      return isDefault24.value ? '24H' : '12H';
    }
    return format;
  },
  set: value => (userData.settings.time = value),
});

const exchangeChartTypes: { label: string; value: UserData.ExchangeChartType }[] = [
  {
    label: '平滑',
    value: 'SMOOTH',
  },
  {
    label: '对齐',
    value: 'ALIGNED',
  },
  {
    label: '原始',
    value: 'RAW',
  },
];

const currencySettings = computed(() => userData.settings.currency);

const currencyPresets: { label: string; value: UserData.CurrencyPreset }[] = [
  {
    label: '默认',
    value: 'DEFAULT',
  },
  {
    label: '₳',
    value: 'AIC',
  },
  {
    label: '₡',
    value: 'CIS',
  },
  {
    label: 'ǂ',
    value: 'ICA',
  },
  {
    label: '₦',
    value: 'NCC',
  },
  {
    label: '自定义',
    value: 'CUSTOM',
  },
];

const currencyPosition: { label: string; value: UserData.CurrencyPosition }[] = [
  {
    label: '后置',
    value: 'AFTER',
  },
  {
    label: '前置',
    value: 'BEFORE',
  },
];

const currencySpacing: { label: string; value: UserData.CurrencySpacing }[] = [
  {
    label: '有空格',
    value: 'HAS_SPACE',
  },
  {
    label: '无空格',
    value: 'NO_SPACE',
  },
];

const backups = computed(() => getUserDataBackups());

function addSidebarButton() {
  userData.settings.sidebar.push(['SET', 'XIT SET']);
}

function deleteSidebarButton(index: number) {
  userData.settings.sidebar.splice(index, 1);
}

function confirmResetSidebar(ev: Event) {
  showConfirmationOverlay(ev, () => {
    userData.settings.sidebar = structuredClone(initialUserData.settings.sidebar);
  });
}

function importUserDataAndReload() {
  importUserData(async () => {
    await saveUserData();
    window.location.reload();
  });
}

async function restoreBackupAndReload(ev: Event, backup: UserDataBackup) {
  showConfirmationOverlay(
    ev,
    async () => {
      restoreBackup(backup);
      await saveUserData();
      window.location.reload();
    },
    {
      message: '确定要恢复此备份吗？这将覆盖你当前的数据。',
    },
  );
}

function confirmDeleteBackup(ev: Event, backup: UserDataBackup) {
  showConfirmationOverlay(ev, () => deleteUserDataBackup(backup));
}

function confirmResetAllData(ev: Event) {
  showConfirmationOverlay(ev, async () => {
    resetUserData();
    await saveUserData();
    window.location.reload();
  });
}

function openDesktopNotifications() {
  showBuffer('XIT DNOT');
}
</script>

<template>
  <SectionHeader>外观</SectionHeader>
  <form>
    <Active label="时间格式">
      <SelectInput v-model="timeFormat" :options="timeFormats" />
    </Active>
    <Active label="默认 CX 图表类型">
      <SelectInput v-model="userData.settings.defaultChartType" :options="exchangeChartTypes" />
    </Active>
  </form>
  <SectionHeader>
    货币符号
    <Tooltip
      :class="$style.tooltip"
      tooltip="显示货币值时使用的货币符号。仅在 Refined PrUn 添加的 UI 中显示。" />
  </SectionHeader>
  <form>
    <Active label="符号">
      <SelectInput v-model="currencySettings.preset" :options="currencyPresets" />
    </Active>
    <Active v-if="currencySettings.preset === 'CUSTOM'" label="自定义符号">
      <TextInput v-model="currencySettings.custom" />
    </Active>
    <Active v-if="currencySettings.preset !== 'DEFAULT'" label="位置">
      <SelectInput v-model="currencySettings.position" :options="currencyPosition" />
    </Active>
    <Active
      v-if="currencySettings.preset !== 'DEFAULT'"
      label="间距"
      tooltip="符号和数值之间的空格。">
      <SelectInput v-model="currencySettings.spacing" :options="currencySpacing" />
    </Active>
  </form>
  <SectionHeader>燃烧设置</SectionHeader>
  <form>
    <Active label="红色" tooltip="燃烧计算中红色消耗品等级的阈值（天数）。">
      <NumberInput v-model="userData.settings.burn.red" />
    </Active>
    <Active label="黄色" tooltip="燃烧计算中黄色消耗品等级的阈值（天数）。">
      <NumberInput v-model="userData.settings.burn.yellow" />
    </Active>
    <Active label="补给" tooltip="XIT BURN 中'需要'列的目标补给天数。">
      <NumberInput v-model="userData.settings.burn.resupply" />
    </Active>
  </form>
  <SectionHeader>桌面通知</SectionHeader>
  <form>
    <Commands>
      <PrunButton primary @click="openDesktopNotifications">打开 XIT DNOT 设置</PrunButton>
    </Commands>
  </form>
  <p :class="$style.notificationHint">
    在 XIT DNOT 中勾选要推送到桌面的通知类型，只有勾选的类型才会推送。
  </p>
  <SectionHeader>
    左侧边栏按钮
    <Tooltip
      :class="$style.tooltip"
      tooltip="在左侧边栏创建快捷键。第一个值是显示内容，第二个是命令。" />
  </SectionHeader>
  <form v-draggable="[userData.settings.sidebar, grip.draggable]">
    <Active
      v-for="(button, i) in userData.settings.sidebar"
      :key="objectId(button)"
      :label="`Button ${i + 1}`"
      :class="$style.sidebarRow">
      <div :class="$style.sidebarInputPair">
        <GripChar :class="[$style.grip, grip.class]" />
        <TextInput v-model="button[0]" :class="$style.sidebarInput" />
        <TextInput v-model="button[1]" :class="$style.sidebarInput" />
        <PrunButton danger @click="deleteSidebarButton(i)">x</PrunButton>
      </div>
    </Active>
  </form>
  <form>
    <Commands>
      <PrunButton primary @click="confirmResetSidebar">重置</PrunButton>
      <PrunButton primary @click="addSidebarButton">添加</PrunButton>
    </Commands>
  </form>
  <SectionHeader>导入/导出</SectionHeader>
  <form>
    <Commands>
      <PrunButton primary @click="importUserDataAndReload">导入用户数据</PrunButton>
      <PrunButton primary @click="exportUserData">导出用户数据</PrunButton>
    </Commands>
  </form>
  <template v-if="backups.length > 0">
    <SectionHeader>备份</SectionHeader>
    <form>
      <Commands
        v-for="backup in backups"
        :key="backup.timestamp"
        :label="ddmmyyyy(backup.timestamp) + ' ' + hhmm(backup.timestamp)">
        <PrunButton primary @click="downloadBackup(backup.data, backup.timestamp)">
          导出
        </PrunButton>
        <PrunButton primary @click="restoreBackupAndReload($event, backup.data)"> 恢复 </PrunButton>
        <PrunButton danger @click="confirmDeleteBackup($event, backup)">删除</PrunButton>
      </Commands>
    </form>
  </template>
  <SectionHeader>危险区域</SectionHeader>
  <form>
    <Commands>
      <PrunButton danger @click="confirmResetAllData">重置所有数据</PrunButton>
    </Commands>
  </form>
</template>

<style module>
.notificationHint {
  font-size: 12px;
  line-height: 1.6;
  margin: 4px 0 12px;
}

.tooltip {
  float: revert;
  font-size: 12px;
  margin-top: -4px;
}

.sidebarInputPair {
  display: flex;
  justify-content: flex-end;
  column-gap: 10px;
}

.sidebarInput {
  width: 40%;
}

.sidebarInput input {
  width: 100%;
}

.grip {
  cursor: move;
  transition: opacity 0.2s ease-in-out;
  opacity: 0;
}

.sidebarRow:hover .grip {
  opacity: 1;
}
</style>
