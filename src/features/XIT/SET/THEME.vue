<script setup lang="ts">
import SectionHeader from '@src/components/SectionHeader.vue';
import PrunButton from '@src/components/PrunButton.vue';
import Commands from '@src/components/forms/Commands.vue';
import { userData } from '@src/store/user-data';
import { DEFAULT_THEME_ID, THEMES, type ThemeId } from '@src/features/basic/theme-registry';

// 主题列表来自注册表（唯一事实源）：新增主题只需改注册表，设置页自动出现卡片。
// 主题在点击时立即生效（theme.ts 监听 userData），无需刷新页面。
const current = computed(() => userData.settings.theme ?? DEFAULT_THEME_ID);

function pick(id: ThemeId) {
  userData.settings.theme = id;
}

function reset() {
  userData.settings.theme = DEFAULT_THEME_ID;
}
</script>

<template>
  <SectionHeader>界面主题</SectionHeader>
  <form>
    <div :class="$style.grid">
      <button
        v-for="t in THEMES"
        :key="t.id"
        type="button"
        :class="[$style.card, current === t.id ? $style.cardActive : '']"
        @click="pick(t.id)">
        <span :class="$style.cardHead">
          <strong>{{ t.label }}</strong>
          <span v-if="current === t.id" :class="$style.activeTag">当前</span>
        </span>
        <span :class="$style.cardDesc">{{ t.desc }}</span>
      </button>
    </div>
  </form>
  <form>
    <Commands>
      <PrunButton primary @click="reset">恢复默认</PrunButton>
    </Commands>
  </form>
</template>

<style module>
.grid {
  display: grid;
  /* min 留 10px 余量：窗口宽高由游戏 inline style 精确控制，不同主题下
     内容区可能只差 1~2px；用 210px 时陶瓷白主题曾因 426px < 428px
     从「两行两列」塌成「四行单列」。200px 保证四个主题都是 2×2。 */
  grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
  gap: 8px;
}

/* 主题卡片自身也走 token：自定义主题下由 theme.ts 的 --rp-skin-* 提供，
   default 原样主题回退到游戏原色，视觉不变。 */
.card {
  display: flex;
  flex-direction: column;
  row-gap: 6px;
  padding: 10px 12px;
  border: 1px solid var(--rp-skin-border-strong, rgb(61, 74, 84));
  border-radius: 4px;
  background: var(--rp-skin-panel, rgb(26, 33, 38));
  color: var(--rp-skin-ink, inherit);
  font: inherit;
  text-align: left;
  cursor: pointer;
}

.card:hover {
  border-color: rgb(var(--rp-accent-rgb));
}

.cardActive {
  border-color: rgb(var(--rp-accent-rgb));
  background: rgba(var(--rp-accent-rgb), 0.08);
}

.cardHead {
  display: flex;
  align-items: center;
  column-gap: 8px;
}

.activeTag {
  margin-left: auto;
  color: rgb(var(--rp-accent-rgb));
  font-size: 11px;
}

.cardDesc {
  color: var(--rp-skin-muted, #999);
  font-size: 11px;
  line-height: 1.5;
}
</style>
