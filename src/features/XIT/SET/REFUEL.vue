<script setup lang="ts">
import { computed } from 'vue';
import SectionHeader from '@src/components/SectionHeader.vue';
import Active from '@src/components/forms/Active.vue';
import { userData } from '@src/store/user-data';

const settings = computed(() => userData.settings.refuel);
</script>

<template>
  <SectionHeader>加油</SectionHeader>
  <form>
    <Active
      label="自动加油"
      tooltip="飞船停靠且燃料低于 95% 时自动触发加油；每次打开游戏都会先检测一轮。满油不重复，冷却 30 秒防抖。默认关闭。">
      <input v-model="settings.enabled" type="checkbox" />
    </Active>
  </form>
</template>
