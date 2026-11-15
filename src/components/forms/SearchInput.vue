<script setup lang="ts">
// 带放大镜图标的搜索输入框：外观仍由调用方传入的 class 决定（各面板原有边框 / 底色 /
// 宽度全部沿用），本组件只负责「图标 + 左侧留白」这一层，避免 11 处各写一遍。
defineOptions({ inheritAttrs: false });

const model = defineModel<string>();

const { placeholder = '', containerClass } = defineProps<{
  placeholder?: string;
  /** 包裹层附加类：需要在父级 flex 里撑满时由调用方传入。 */
  containerClass?: string | string[];
}>();
</script>

<template>
  <span :class="[$style.wrapper, containerClass]">
    <svg :class="$style.icon" aria-hidden="true" viewBox="0 0 24 24" fill="currentColor">
      <path
        d="M15.5 14h-.79l-.28-.27A6.47 6.47 0 0 0 16 9.5 6.5 6.5 0 1 0 9.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19zM9.5 14C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14z" />
    </svg>
    <input
      v-bind="$attrs"
      v-model="model"
      type="text"
      :placeholder="placeholder"
      autocomplete="off"
      data-1p-ignore="true"
      data-lpignore="true" />
  </span>
</template>

<style module>
/* 图标绝对定位在包裹层左侧，不占输入框宽度，也不会挡住点击（pointer-events: none，
   点图标等同点输入框，能直接聚焦）。 */
.wrapper {
  position: relative;
  /* block-level flex：在 flex 工具栏里宽度按内容收缩（等于输入框原宽），
     在普通块容器里撑满，配合各面板原本的 width:100% 输入框不变形。 */
  display: flex;
  align-items: center;
  min-width: 0;
}

.icon {
  position: absolute;
  left: 4px;
  top: 50%;
  width: 10px;
  height: 10px;
  transform: translateY(-50%);
  /* --rp-skin-* 不会被主题引擎二次重映射（见 refined-prun.css 说明），
     原样主题没有该变量时回退到继承色。R01：不写裸色值。 */
  color: var(--rp-skin-ink, currentColor);
  pointer-events: none;
}

/* 给图标让出位置。用 .wrapper.wrapper 把特异性抬到 (0,2,1)，
   稳定压过各面板 .input / .searchInput（0,1,0）以及
   「容器 :global(input)」（0,1,1）里的 padding 简写，不依赖样式表顺序。 */
.wrapper.wrapper > input {
  padding-left: 18px;
}
</style>
