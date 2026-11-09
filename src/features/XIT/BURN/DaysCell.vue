<script setup lang="ts">
import { userData } from '@src/store/user-data';
import { fixed0, fixed01, fixed02 } from '@src/utils/format';

const { days } = defineProps<{ days: number }>();

const formattedDays = computed(() => {
  if (days > 999) {
    return '∞';
  }
  if (days >= 10) {
    return fixed0(Math.floor(days));
  }
  if (days >= 1) {
    return fixed01(days);
  }
  return fixed02(days);
});

const burnClass = computed(() => {
  const flooredDays = Math.floor(days);
  return {
    [C.Workforces.daysMissing]: flooredDays <= userData.settings.burn.red,
    [C.Workforces.daysWarning]: flooredDays <= userData.settings.burn.yellow,
    [C.Workforces.daysSupplied]: flooredDays > userData.settings.burn.yellow,
  };
});
</script>

<template>
  <td :style="{ position: 'relative' }">
    <div
      :style="{ position: 'absolute', left: 0, top: 0, width: '100%', height: '100%' }"
      :class="burnClass" />
    <span :class="$style.value">{{ formattedDays }}</span>
  </td>
</template>

<style module>
/* 预警底色是一个绝对定位、铺满单元格的独立覆盖层。游戏原版用半透明色，
   数字能透出来；浅色 / 暖米纸主题把它换成不透明实色后，绝对定位层会盖在
   同级的行内文字之上（CSS 绘制顺序），数字就整块消失。这里让数字浮到覆盖层
   之上，并在两套新主题里显式用皮肤墨色，避免继承到与黄/红底相近的颜色。
   原样主题没有 --rp-skin-ink，回退 currentColor，保持游戏原版观感。 */
.value {
  position: relative;
  z-index: 1;
  color: var(--rp-skin-ink, currentColor) !important;
}
</style>
