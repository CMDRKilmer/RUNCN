<script setup lang="ts">
import SectionHeader from '@src/components/SectionHeader.vue';
import Active from '@src/components/forms/Active.vue';
import PrunButton from '@src/components/PrunButton.vue';
import Commands from '@src/components/forms/Commands.vue';
import { initialUserData, userData } from '@src/store/user-data';

const settings = computed(() => userData.settings.darkMode);

const sliders = [
  {
    key: 'brightness',
    label: '亮度',
    min: 0,
    max: 150,
    tooltip: '整体亮度，100 为原始值。',
  },
  {
    key: 'contrast',
    label: '对比度',
    min: 0,
    max: 150,
    tooltip: '整体对比度，100 为原始值。',
  },
  {
    key: 'sepia',
    label: '棕褐色',
    min: 0,
    max: 100,
    tooltip: '棕褐色滤镜强度，0 为关闭。',
  },
  {
    key: 'grayscale',
    label: '灰度',
    min: 0,
    max: 100,
    tooltip: '灰度滤镜强度，0 为关闭。',
  },
] as const;

function reset() {
  userData.settings.darkMode = structuredClone(initialUserData.settings.darkMode);
}
</script>

<template>
  <SectionHeader>反色模式</SectionHeader>
  <form>
    <Active
      label="启用反色模式"
      tooltip="开启后反色显示整个界面（图片/视频等媒体会自动恢复正常）。默认关闭。">
      <input v-model="settings.enabled" type="checkbox" />
    </Active>
  </form>
  <SectionHeader>滤镜</SectionHeader>
  <form>
    <Active v-for="s in sliders" :key="s.key" :label="s.label" :tooltip="s.tooltip">
      <div :class="$style.sliderRow">
        <input
          v-model.number="settings[s.key]"
          type="range"
          :min="s.min"
          :max="s.max"
          :class="$style.slider" />
        <span :class="$style.value">{{ settings[s.key] }}</span>
      </div>
    </Active>
  </form>
  <form>
    <Commands>
      <PrunButton primary @click="reset">恢复默认</PrunButton>
    </Commands>
  </form>
</template>

<style module>
.sliderRow {
  display: flex;
  align-items: center;
  column-gap: 10px;
  width: 100%;
}

.slider {
  flex: 1;
}

.value {
  min-width: 36px;
  text-align: right;
  color: #999;
  font-size: 12px;
}
</style>
