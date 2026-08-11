<script setup lang="ts">
import Active from '@src/components/forms/Active.vue';
import Passive from '@src/components/forms/Passive.vue';
import SelectInput from '@src/components/forms/SelectInput.vue';
import { Config } from '@src/features/XIT/ACT/actions/mtra/config';
import { storagesStore } from '@src/infrastructure/prun-api/data/storage';
import {
  atSameLocation,
  deserializeStorage,
  serializeStorage,
  storageDisplayName,
  storageSort,
} from '@src/features/XIT/ACT/actions/utils';
import { configurableValue } from '@src/features/XIT/ACT/shared-types';

const { data, config } = defineProps<{ data: UserData.ActionData; config: Config }>();

const allStorages = computed(() => storagesStore.nonFuelStores.value ?? []);

const originStorages = computed(() => {
  let storages = [...allStorages.value];
  if (data.dest !== configurableValue) {
    const destination = deserializeStorage(data.dest);
    if (destination) {
      storages = storages.filter(x => atSameLocation(x, destination) && x !== destination);
    }
  }
  // 仅飞船模式（如卸货包）：从只列出飞船货舱，不出现基地/仓库。
  if (data.originType === 'SHIP_STORE') {
    storages = storages.filter(x => x.type === 'SHIP_STORE');
  }
  return storages.sort(storageSort);
});

const originOptions = computed(() => {
  return getOptions(originStorages.value);
});

if (data.origin === configurableValue && !config.origin && originStorages.value.length > 0) {
  config.origin = serializeStorage(originStorages.value[0]);
}

const destinationStorages = computed(() => {
  let storages = [...allStorages.value];
  if (data.origin !== configurableValue) {
    const origin = deserializeStorage(data.origin);
    if (origin) {
      storages = storages.filter(x => atSameLocation(x, origin) && x !== origin);
    }
  }

  return storages.sort(storageSort);
});

const destinationOptions = computed(() => {
  return getOptions(destinationStorages.value);
});

if (
  data.dest === configurableValue &&
  !config.destination &&
  destinationStorages.value.length > 0
) {
  config.destination = serializeStorage(destinationStorages.value[0]);
}

// 当存储列表变化时自动填充和修正选择。
watchEffect(() => {
  if (data.origin === configurableValue) {
    if (config.origin) {
      const origin = deserializeStorage(config.origin);
      if (!origin || !originStorages.value.includes(origin)) {
        config.origin = undefined;
      }
    }

    if (!config.origin && originStorages.value.length === 1) {
      config.origin = serializeStorage(originStorages.value[0]);
    }
  }

  if (data.dest === configurableValue) {
    if (config.destination) {
      const destination = deserializeStorage(config.destination);
      if (!destination || !destinationStorages.value.includes(destination)) {
        config.destination = undefined;
      }
    }

    if (!config.destination && destinationStorages.value.length === 1) {
      config.destination = serializeStorage(destinationStorages.value[0]);
    }
  }
});

function getOptions(storages: PrunApi.Store[]) {
  const options = storages.map(serializeStorage).map(x => ({ label: x, value: x }));
  if (options.length === 0) {
    options.push({ label: '没有可用位置', value: undefined! });
  }
  return options;
}
</script>

<template>
  <form>
    <Active v-if="data.origin === configurableValue" label="从">
      <SelectInput v-model="config.origin" :options="originOptions" />
    </Active>
    <Passive v-else label="从">
      <span>{{ storageDisplayName(data.origin) }}</span>
    </Passive>
    <Active v-if="data.dest === configurableValue" label="到">
      <SelectInput v-model="config.destination" :options="destinationOptions" />
    </Active>
    <Passive v-else label="到">
      <span>{{ storageDisplayName(data.dest) }}</span>
    </Passive>
  </form>
</template>
