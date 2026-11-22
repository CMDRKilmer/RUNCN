<script setup lang="ts">
import SectionHeader from '@src/components/SectionHeader.vue';
import PrunButton from '@src/components/PrunButton.vue';
import Commands from '@src/components/forms/Commands.vue';
import Active from '@src/components/forms/Active.vue';
import SelectInput from '@src/components/forms/SelectInput.vue';
import { initialUserData, userData } from '@src/store/user-data';
import { DEFAULT_THEME_ID, THEMES, type ThemeId } from '@src/features/basic/theme-registry';
import { themePreviewVars } from '@src/features/basic/theme-palette';

// 主题列表来自注册表（唯一事实源）：新增主题只需改注册表，设置页自动出现卡片。
// 主题在点击时立即生效（theme.ts 监听 userData），无需刷新页面。
const current = computed(() => userData.settings.theme ?? DEFAULT_THEME_ID);

const fontSizes = [
  { value: 'standard', label: '标准' },
  { value: 'large', label: '放大' },
];
const borderModes = [
  { value: 'theme', label: '跟随主题' },
  { value: 'on', label: '显示' },
  { value: 'off', label: '关闭' },
];

function pick(id: ThemeId) {
  userData.settings.theme = id;
}

function reset() {
  userData.settings.theme = DEFAULT_THEME_ID;
  userData.settings.themeFontSize = initialUserData.settings.themeFontSize;
  userData.settings.themeBorders = initialUserData.settings.themeBorders;
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
        :style="themePreviewVars(t.id)"
        @click="pick(t.id)">
        <!-- 卡片即模拟窗口：标题栏写主题名，正文写说明，下面用该主题自己的色摆一份
             表格 / 柱图 / 输入框 / 按钮。颜色全部来自内联的 --rp-cc-*（见
             theme-palette.ts），本文件不写颜色字面量。 -->
        <span :class="$style.winBar">
          <strong :class="$style.winName">{{ t.label }}</strong>
          <span :class="$style.winTools">
            <span v-if="current === t.id" :class="$style.activeTag">当前</span>
            <span :class="[$style.dot, $style.dotAccent]" />
            <span :class="[$style.dot, $style.dotOk]" />
          </span>
        </span>
        <span :class="$style.winDesc">{{ t.desc }}</span>
        <span :class="$style.winBody">
          <span :class="$style.rows">
            <span :class="$style.row">
              <span :class="$style.rowLabel" />
              <span :class="$style.rowValue" />
            </span>
            <span :class="[$style.row, $style.rowAlt]">
              <span :class="$style.rowLabel" />
              <span :class="$style.rowValue" />
            </span>
            <span :class="$style.row">
              <span :class="$style.rowLabel" />
              <span :class="$style.rowValue" />
            </span>
          </span>
          <span :class="$style.chart">
            <span :class="[$style.bar, $style.bar1]" />
            <span :class="[$style.bar, $style.bar2]" />
            <span :class="[$style.bar, $style.bar3]" />
          </span>
        </span>
        <span :class="$style.winFoot">
          <span :class="$style.field" />
          <span :class="$style.btnPrimary" />
          <span :class="$style.btnDanger" />
        </span>
      </button>
    </div>
  </form>
  <form>
    <Active label="字体大小" tooltip="调整选项标签和部分面板的小字。">
      <SelectInput v-model="userData.settings.themeFontSize" :options="fontSizes" />
    </Active>
    <Active label="增强边框" tooltip="控制额外添加的表格分隔线和浮窗描边。">
      <SelectInput v-model="userData.settings.themeBorders" :options="borderModes" />
    </Active>
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
     从两列塌成单列。200px 保证主题卡片始终两列排布。 */
  grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
  gap: 8px;
}

/* 卡片外壳就是窗口的窗体：底色 / 描边 / 正文色一律取内联 token。
   选中与悬停只改描边（用当前界面强调色），不动窗口内部颜色，
   否则预览会被「当前主题」染脏。 */
.card {
  display: flex;
  flex-direction: column;
  padding: 0;
  overflow: hidden;
  border: 1px solid var(--rp-cc-table-border);
  border-radius: 4px;
  background: var(--rp-cc-canvas);
  color: var(--rp-cc-table-text);
  font: inherit;
  text-align: left;
  cursor: pointer;
}

.card:hover,
.cardActive {
  border-color: rgb(var(--rp-accent-rgb));
}

.winBar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 10px;
  border-bottom: 1px solid var(--rp-cc-table-border);
  background: var(--rp-cc-table-head-bg);
  color: var(--rp-cc-table-head-text);
}

.winName {
  font-size: 13px;
  font-weight: 700;
}

.winTools {
  display: flex;
  align-items: center;
  gap: 5px;
  margin-left: auto;
}

.activeTag {
  color: var(--rp-cc-accent-line);
  font-size: 11px;
}

.dot {
  width: 5px;
  height: 5px;
  border-radius: 50%;
}

.dotAccent {
  background: var(--rp-cc-accent-line);
}

.dotOk {
  background: var(--rp-cc-status-success-text);
}

/* 说明文字用主题的次级正文色压在窗底上，顺带就是正文对比度的实测位。 */
.winDesc {
  padding: 8px 10px 0;
  color: var(--rp-cc-text-secondary);
  font-size: 11px;
  line-height: 1.5;
}

.winBody {
  display: flex;
  align-items: stretch;
  gap: 8px;
  padding: 8px 10px 0;
}

.rows {
  display: flex;
  flex: 1 1 60%;
  flex-direction: column;
  gap: 3px;
  min-width: 0;
}

.row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  height: 9px;
  padding: 0 4px;
  border-radius: 2px;
}

.rowAlt {
  background: var(--rp-cc-table-row-alt);
}

.rowLabel {
  width: 55%;
  height: 3px;
  border-radius: 2px;
  background: var(--rp-cc-table-text);
}

.rowValue {
  width: 22%;
  height: 3px;
  border-radius: 2px;
  background: var(--rp-cc-table-text);
}

.chart {
  display: flex;
  flex: 0 0 32%;
  align-items: flex-end;
  gap: 4px;
  min-width: 0;
  padding-bottom: 1px;
  border-bottom: 1px solid var(--rp-cc-table-border);
}

.bar {
  flex: 1 1 0;
  min-width: 0;
  border-radius: 1px 1px 0 0;
}

.bar1 {
  height: 45%;
  background: var(--rp-cc-cat-1-chart);
}

.bar2 {
  height: 78%;
  background: var(--rp-cc-cat-4-chart);
}

.bar3 {
  height: 62%;
  background: var(--rp-cc-cat-6-chart);
}

.winFoot {
  display: flex;
  align-items: center;
  gap: 4px;
  margin-top: auto;
  padding: 8px 10px;
  border-top: 1px solid var(--rp-cc-table-border);
  background: var(--rp-cc-surface-alt);
}

.field {
  flex: 1 1 auto;
  min-width: 0;
  height: 12px;
  border: 1px solid var(--rp-cc-control-border);
  border-radius: 2px;
  background: var(--rp-cc-control-bg);
}

.btnPrimary {
  flex: 0 0 auto;
  width: 44px;
  height: 14px;
  border-radius: 2px;
  background: var(--rp-cc-btn-primary-bg);
}

.btnDanger {
  flex: 0 0 auto;
  width: 26px;
  height: 14px;
  border-radius: 2px;
  background: var(--rp-cc-btn-danger-bg);
}
</style>
