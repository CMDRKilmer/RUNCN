<script setup lang="ts">
import PrunButton from '@src/components/PrunButton.vue';
import SectionHeader from '@src/components/SectionHeader.vue';
import Active from '@src/components/forms/Active.vue';
import TextInput from '@src/components/forms/TextInput.vue';
import SelectInput from '@src/components/forms/SelectInput.vue';
import NumberInput from '@src/components/forms/NumberInput.vue';
import Commands from '@src/components/forms/Commands.vue';
import { sitesStore } from '@src/infrastructure/prun-api/data/sites';
import { getEntityNaturalIdFromAddress } from '@src/infrastructure/prun-api/data/addresses';
import { shipsStore } from '@src/infrastructure/prun-api/data/ships';
import { userData } from '@src/store/user-data';

const { add, trigger, onSave } = defineProps<{
  add?: boolean;
  trigger: UserData.TriggerData;
  onSave?: () => void;
}>();

const emit = defineEmits<{ (e: 'close'): void }>();

const eventTypes: { label: string; value: UserData.TriggerEventType }[] = [
  { label: '飞船到港', value: 'FLIGHT_ENDED' },
  { label: '物资告急', value: 'SUPPLIES_LOW' },
  { label: '生产完成', value: 'PRODUCTION_FINISHED' },
  { label: '建筑状况', value: 'BUILDING_CONDITION' },
  { label: '定时', value: 'INTERVAL' },
];

const packages = computed(() => userData.actionPackages.map(x => x.global.name));
const bases = computed(() =>
  (sitesStore.all.value ?? []).map(x => getEntityNaturalIdFromAddress(x.address)!),
);
const shipOptions = computed(() => {
  const ships = [...(shipsStore.all.value ?? [])].sort((a, b) =>
    a.registration.localeCompare(b.registration),
  );
  const list: { label: string; value: string }[] = [{ label: '任意飞船', value: '' }];
  for (const ship of ships) {
    list.push({
      label: ship.name ? `${ship.registration}（${ship.name}）` : ship.registration,
      value: ship.registration,
    });
  }
  return list;
});

const name = ref(trigger.name);
const nameError = ref(false);
const eventType = ref<UserData.TriggerEventType>(trigger.event.type);

// 事件过滤字段（按事件类型条件展示）
const ship = ref(trigger.event.type === 'FLIGHT_ENDED' ? (trigger.event.ship ?? '') : '');
const planet = ref(
  trigger.event.type === 'FLIGHT_ENDED' ||
    trigger.event.type === 'BUILDING_CONDITION' ||
    trigger.event.type === 'SUPPLIES_LOW' ||
    trigger.event.type === 'PRODUCTION_FINISHED'
    ? (trigger.event.planet ?? '')
    : '',
);
const belowPct = ref(
  trigger.event.type === 'BUILDING_CONDITION'
    ? trigger.event.belowPct
    : userData.settings.repair.threshold,
);
const packageName = ref(trigger.packageName || packages.value[0] || '');
const mode = ref<UserData.TriggerMode>(trigger.mode);
const cooldownMin = ref(trigger.cooldownMin);

function validate() {
  let valid = true;
  nameError.value = name.value.length === 0;
  valid &&= !nameError.value;
  valid &&= eventType.value !== 'BUILDING_CONDITION' || planet.value.length > 0;
  valid &&= packageName.value.length > 0;
  valid &&= cooldownMin.value >= 15;
  return valid;
}

function save() {
  trigger.name = name.value;
  trigger.packageName = packageName.value;
  trigger.mode = mode.value;
  trigger.cooldownMin = cooldownMin.value;

  switch (eventType.value) {
    case 'FLIGHT_ENDED':
      trigger.event = {
        type: 'FLIGHT_ENDED',
        ...(ship.value ? { ship: ship.value.toUpperCase() } : {}),
        ...(planet.value ? { planet: planet.value } : {}),
      };
      break;
    case 'SUPPLIES_LOW':
      trigger.event = { type: 'SUPPLIES_LOW', ...(planet.value ? { planet: planet.value } : {}) };
      break;
    case 'PRODUCTION_FINISHED':
      trigger.event = {
        type: 'PRODUCTION_FINISHED',
        ...(planet.value ? { planet: planet.value } : {}),
      };
      break;
    case 'BUILDING_CONDITION':
      trigger.event = {
        type: 'BUILDING_CONDITION',
        planet: planet.value,
        belowPct: belowPct.value,
      };
      break;
    case 'INTERVAL':
      trigger.event = { type: 'INTERVAL' };
      break;
  }
}

function onSaveClick() {
  if (!validate()) {
    return;
  }
  save();
  onSave?.();
  emit('close');
}
</script>

<template>
  <div :class="C.DraftConditionEditor.form">
    <SectionHeader>{{ add ? '添加' : '编辑' }}触发器</SectionHeader>
    <form>
      <Active label="名称" :error="nameError">
        <TextInput v-model="name" />
      </Active>
      <Active label="事件类型">
        <SelectInput v-model="eventType" :options="eventTypes" />
      </Active>
      <Active
        v-if="eventType === 'FLIGHT_ENDED'"
        label="飞船"
        tooltip="留空表示任意飞船到港均触发。">
        <SelectInput v-model="ship" :options="shipOptions" />
      </Active>
      <Active
        v-if="
          eventType === 'FLIGHT_ENDED' ||
          eventType === 'SUPPLIES_LOW' ||
          eventType === 'PRODUCTION_FINISHED'
        "
        label="星球"
        tooltip="留空表示任意基地均触发；填写自然 ID（如 KW1）或名称。">
        <TextInput v-model="planet" />
      </Active>
      <template v-if="eventType === 'BUILDING_CONDITION'">
        <Active label="星球" tooltip="监控该基地的建筑状况。">
          <SelectInput v-model="planet" :options="bases" />
        </Active>
        <Active label="状况阈值" tooltip="任意建筑状况低于该百分比时触发。">
          <NumberInput v-model="belowPct" :min="1" :max="100" />
          <span>%</span>
        </Active>
      </template>
      <Active
        v-if="eventType === 'INTERVAL'"
        label="周期说明"
        tooltip="定时触发的周期由下方冷却时间决定。">
        <span>周期 = 冷却时间</span>
      </Active>
      <Active label="操作包" tooltip="触发后执行的操作包。">
        <SelectInput v-model="packageName" :options="packages" />
      </Active>
      <Active
        label="模式"
        tooltip="AUTO：触发后直接执行（需在面板全局切换为自动模式）；手动：不自动触发，仅列表内点执行按钮手动运行。">
        <SelectInput
          v-model="mode"
          :options="[
            { label: 'AUTO（直接执行）', value: 'AUTO' },
            { label: '手动（点按钮执行）', value: 'MANUAL' },
          ]" />
      </Active>
      <Active
        label="冷却（分钟）"
        tooltip="两次触发之间的最小间隔，最小 15 分钟；定时事件同时作为周期。">
        <NumberInput v-model="cooldownMin" :min="15" />
      </Active>
      <Commands>
        <PrunButton primary @click="onSaveClick">{{ add ? '添加' : '保存' }}</PrunButton>
      </Commands>
    </form>
  </div>
</template>
