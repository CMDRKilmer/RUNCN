<script setup lang="ts">
import PrunLink from '@src/components/PrunLink.vue';
import { castArray } from '@src/utils/cast-array';

const categoryMap: Record<string, string> = {
  FIN: '经济与财务',
  FINPR: '经济与财务',
  FINBS: '经济与财务',
  FINCH: '经济与财务',
  ARB: '经济与财务',
  CXOS: '经济与财务',
  CXTS: '经济与财务',
  FXTS: '经济与财务',
  FX: '经济与财务',
  FOREX: '经济与财务',
  CONTS: '合同',
  CONTSS: '合同',
  CONTC: '合同',
  CONTFF: '合同',
  CONTGEN: '合同',
  LOAN: '合同',
  HAUL: '合同',
  PROD: '生产与基地',
  BURN: '生产与基地',
  BURNGEN: '生产与基地',
  EXP: '生产与基地',
  PWARN: '生产与基地',
  WFOR: '生产与基地',
  REP: '生产与基地',
  BPLAN: '规划与计算',
  JH: '规划与计算',
  HQUC: '规划与计算',
  BPC: '规划与计算',
  CALC: '规划与计算',
  ACT: '自动化',
  CART: '自动化',
  ORG: '组织协作',
  CHAT: '信息与工具',
  ELEC: '信息与工具',
  MATS: '信息与工具',
  NOTE: '信息与工具',
  TODO: '信息与工具',
  CMDL: '信息与工具',
  CMDS: '信息与工具',
  HEALTH: '信息与工具',
  GIF: '信息与工具',
  DEV: '信息与工具',
  SET: '系统与设置',
  START: '系统与设置',
  HELP: '系统与设置',
  PRUN: 'WEB 快捷方式',
  PROSPERITY: 'WEB 快捷方式',
  SHEET: 'WEB 快捷方式',
  PLANNER: 'WEB 快捷方式',
  MAP: 'WEB 快捷方式',
  YAPT: 'WEB 快捷方式',
  PRUNSTATS: 'WEB 快捷方式',
};

const categoryOrder = [
  '经济与财务',
  '合同',
  '生产与基地',
  '规划与计算',
  '自动化',
  '组织协作',
  '信息与工具',
  '系统与设置',
  'WEB 快捷方式',
];

interface CommandEntry {
  cmd: string;
  aliases: string[];
  name: string;
  description: string;
  category: string;
}

const grouped = computed(() => {
  const map = new Map<string, CommandEntry[]>();
  for (const cat of categoryOrder) {
    map.set(cat, []);
  }

  for (const entry of xit.registry) {
    const commands = castArray<string>(entry.command);
    const cmd: string = commands[0];
    const aliases: string[] = commands.slice(1);
    const cat = categoryMap[cmd] ?? '其他';
    if (!map.has(cat)) {
      map.set(cat, []);
    }

    let name: string;
    if (typeof entry.name === 'string') {
      name = entry.name;
    } else {
      // 动态名称 → 用命令标识
      name = entry.description.split('\n')[0] || cmd;
    }

    map.get(cat)!.push({ cmd, aliases, name, description: entry.description, category: cat });
  }
  return [...map.entries()].filter(([, list]) => list.length > 0);
});
</script>

<template>
  <h3 style="margin-bottom: 8px">入门指南</h3>
  <table>
    <thead>
      <tr>
        <th>我想要...</th>
        <th>命令</th>
      </tr>
    </thead>
    <tbody>
      <tr>
        <td>更改 Refined PrUn 设置。</td>
        <td><PrunLink command="XIT SET" /></td>
      </tr>
      <tr>
        <td>将功能集切换为基础/完整模式。</td>
        <td><PrunLink command="XIT SET FEAT" /></td>
      </tr>
      <tr>
        <td>禁用某个 Refined PrUn 功能。</td>
        <td><PrunLink command="XIT SET FEAT" /></td>
      </tr>
      <tr>
        <td>查看可用的 XIT 命令。</td>
        <td><PrunLink command="XIT CMDS" /></td>
      </tr>
      <tr>
        <td>导入 PMMG 设置。</td>
        <td><PrunLink command="XIT SET PMMG" /></td>
      </tr>
      <tr>
        <td>获取随机柯基犬 GIF。</td>
        <td><PrunLink command="XIT GIF CORGI" /></td>
      </tr>
    </tbody>
  </table>

  <h3 style="margin-top: 24px; margin-bottom: 8px">XIT 命令分类参考</h3>
  <template v-for="[category, commands] in grouped" :key="category">
    <h4 style="margin: 12px 0 4px">{{ category }}</h4>
    <table>
      <thead>
        <tr>
          <th>命令</th>
          <th>面板名称</th>
          <th>描述</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="c in commands" :key="c.cmd">
          <td>
            <PrunLink :command="'XIT ' + c.cmd">{{ c.cmd }}</PrunLink>
            <span v-if="c.aliases.length" style="color: #888; font-size: 0.9em">
              ({{ c.aliases.join(', ') }})
            </span>
          </td>
          <td>{{ c.name }}</td>
          <td style="font-size: 0.9em; color: #aaa">{{ c.description }}</td>
        </tr>
      </tbody>
    </table>
  </template>
</template>
