<script setup lang="ts">
import DaysCell from '@src/features/XIT/BURN/DaysCell.vue';
import { PlanetBurn } from '@src/core/burn';
import { getBaseAlias } from '@src/core/base-aliases';
import { useTileState } from '@src/features/XIT/BURN/tile-state';
import { countDays } from '@src/features/XIT/BURN/utils';

const { burn } = defineProps<{
  burn: PlanetBurn;
  hasMinimize?: boolean;
  minimized?: boolean;
  onClick: () => void;
}>();

const days = computed(() => countDays(burn.burn));

// 基地别名（总览行没有 siteId，不显示别名）。
const alias = computed(() => (burn.siteId ? getBaseAlias(burn.siteId) : undefined));

// 「命令」列已整列删除（表体与星球行都不再有 BS / INV / ACT 按钮），
// 星球行只剩名称 + 天数两格。名称要跨到天数列之前，跨列数随 I/O 模式变化：
//   I/O 关闭：图标 / 库存 / 消耗 / 需要 / 天数      → colspan=4
//   I/O 开启：图标 / 库存 / 输入 / 输出 / 净变化 / 需要 / 天数 → colspan=6
const io = useTileState('io');
const nameColSpan = computed(() => (io.value ? 6 : 4));
</script>

<template>
  <tr :class="$style.row">
    <td :colspan="nameColSpan" :class="$style.cell" @click="onClick">
      <span v-if="hasMinimize" :class="$style.minimize">
        {{ minimized ? '+' : '-' }}
      </span>
      <span>{{ burn.planetName }}</span>
      <span v-if="alias" :class="$style.alias">（{{ alias }}）</span>
    </td>
    <DaysCell :days="days" />
  </tr>
</template>

<style module>
.row {
  border-bottom: 1px solid #2b485a;
}

.cell {
  font-weight: bold;
  font-size: 12px;
  cursor: pointer;
}

.alias {
  color: #888;
  margin-left: 4px;
}

.minimize {
  display: inline-block;
  width: 26px;
  text-align: center;
}
</style>
