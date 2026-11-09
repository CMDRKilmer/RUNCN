<script setup lang="ts">
import { Pie } from 'vue-chartjs';
import {
  ArcElement,
  CategoryScale,
  Chart,
  ChartData,
  ChartOptions,
  Legend,
  PieController,
  Tooltip,
} from 'chart.js';
import ChartDataLabels from 'chartjs-plugin-datalabels';
import { chartColors } from '@src/utils/chart-theme';
import { sumBy } from '@src/utils/sum-by';
import { percent2 } from '@src/utils/format';

Chart.register(PieController, ArcElement, Tooltip, Legend, CategoryScale);

const { labelData, numericalData } = defineProps<{
  labelData: string[];
  numericalData: number[];
}>();

// 颜色来源统一交给主题 token 层：其它主题仍用原 8 色，陶瓷白主题按
// --rp-cc-cat-1..8-chart 取色。同一序号的扇区颜色全站一致，并由
// datalabels 显示分类名、tooltip 显示占比，不单靠颜色区分。
const colorScheme = computed(() => {
  const base = chartColors().series;
  let colorScheme = [...base];

  for (let i = 0; i < labelData.length / 8; i++) {
    colorScheme = colorScheme.concat(base);
  }

  return colorScheme;
});

const truncatedLabelData = computed(() => {
  let truncatedLabelData = [...labelData];

  for (let i = 20; i < truncatedLabelData.length; i++) {
    truncatedLabelData[i] = '其他';
  }

  return truncatedLabelData;
});

const chartData = computed<ChartData<'pie', number[], string>>(() => ({
  labels: truncatedLabelData.value,
  datasets: [
    {
      data: numericalData,
      backgroundColor: colorScheme.value,
      hoverOffset: 4,
      borderWidth: 0,
    },
  ],
}));

const chartOptions = computed<ChartOptions<'pie'>>(() => ({
  responsive: false,
  maintainAspectRatio: false,
  plugins: {
    legend: {
      display: false,
    },
    tooltip: {
      callbacks: {
        label(context) {
          const label = context.label || '';
          const value = context.raw as number;
          const total = sumBy(numericalData, x => x);
          const percentage = percent2(value / total);
          return `${label}: ${percentage}`;
        },
      },
    },
    datalabels: {
      color: chartColors().datalabel,
      display: 'auto',
      formatter(value, context) {
        return context.chart.data.labels![context.dataIndex];
      },
      anchor: 'end',
      align: 'end',
      textAlign: 'center',
      font: {
        weight: 'normal',
        size: 11,
      },
    },
  },
  layout: {
    padding: {
      left: 60,
      top: 0,
      right: 60,
      bottom: 0,
    },
  },
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const chartPlugins = [ChartDataLabels as any];
</script>

<template>
  <Pie :options="chartOptions" :data="chartData" :plugins="chartPlugins" />
</template>
