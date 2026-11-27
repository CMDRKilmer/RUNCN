<script setup lang="ts">
import { accountingPeriods } from '@src/infrastructure/prun-api/data/accounting-periods';
import {
  EXPENSE_GROUPS,
  expenseGroupOf,
  labelOf,
  type ExpenseGroup,
} from '@src/core/accounting/account-labels';
import { formatCurrency } from '@src/utils/format';

// 利润表：收入/支出类科目的当期余额就是当期发生额（每期结转到利润），
// 所以直接读会计期间余额即可，无需对流水做差。
const COLUMNS = 3;

// recent 返回升序，反转后按「本期 → 上期 → 上上期」排列。
const ordered = computed(() => [...accountingPeriods.recent(COLUMNS)].reverse());

interface Row {
  type: number;
  name: string;
  hint?: string;
  values: (number | undefined)[];
  total: number;
}

function buildRows(section: 'revenue' | 'expense'): Row[] {
  const list = ordered.value;
  const map = new Map<number, (number | undefined)[]>();
  for (let i = 0; i < list.length; i++) {
    for (const account of list[i].accounts) {
      if (account.category !== (section === 'revenue' ? 'REVENUE' : 'EXPENSES')) {
        continue;
      }
      const amount = account.bookBalance.amount;
      const values = map.get(account.type) ?? Array.from({ length: COLUMNS }, () => undefined);
      values[i] = (values[i] ?? 0) + amount;
      map.set(account.type, values);
    }
  }
  const rows: Row[] = [];
  for (const [type, values] of map) {
    const label = labelOf(type);
    const total = values.reduce<number>((sum, v) => sum + (v ?? 0), 0);
    // 全零科目（例如当期未发生的收入类型）不占行，避免一屏都是 0
    if (values.every(v => (v ?? 0) === 0)) {
      continue;
    }
    rows.push({ type, name: label.name, hint: label.hint, values, total });
  }
  rows.sort((a, b) => Math.abs(b.total) - Math.abs(a.total));
  return rows;
}

const revenueRows = computed(() => buildRows('revenue'));
const expenseRows = computed(() => buildRows('expense'));

// 支出按性质分组：组内按金额降序，组间按「材料→人工→设施→出资→其他」。
// 直接按金额排会把资本性出资（总部出资）和一次性冲账顶到最前面，和日常费用混在一起。
interface GroupedRows {
  id: ExpenseGroup;
  name: string;
  hint?: string;
  rows: Row[];
  totals: (number | undefined)[];
  total: number;
}

const expenseGroups = computed<GroupedRows[]>(() => {
  const buckets = new Map<ExpenseGroup, Row[]>();
  for (const row of expenseRows.value) {
    const group = expenseGroupOf(row.type);
    const list = buckets.get(group) ?? [];
    list.push(row);
    buckets.set(group, list);
  }
  return EXPENSE_GROUPS.filter(g => buckets.has(g.id)).map(group => {
    const rows = buckets.get(group.id) ?? [];
    const totals = Array.from({ length: COLUMNS }, (_, i) => {
      const present = rows.filter(r => r.values[i] !== undefined);
      if (present.length === 0) {
        return undefined;
      }
      return present.reduce((sum, r) => sum + (r.values[i] ?? 0), 0);
    });
    const total = rows.reduce((sum, r) => sum + r.total, 0);
    return { id: group.id, name: group.name, hint: group.hint, rows, totals, total };
  });
});

const revenueTotals = computed(() =>
  Array.from({ length: COLUMNS }, (_, i) =>
    revenueRows.value.reduce((s, r) => s + (r.values[i] ?? 0), 0),
  ),
);
const expenseTotals = computed(() =>
  Array.from({ length: COLUMNS }, (_, i) =>
    expenseRows.value.reduce((s, r) => s + (r.values[i] ?? 0), 0),
  ),
);
const netTotals = computed(() =>
  Array.from(
    { length: COLUMNS },
    (_, i) => (revenueTotals.value[i] ?? 0) - (expenseTotals.value[i] ?? 0),
  ),
);

const hasData = computed(() => ordered.value.length > 0);
const headers = computed(() => {
  const labels = ['本期', '上期', '上上期'];
  const list = ordered.value;
  return labels.map((label, i) => {
    const period = list[i];
    return period === undefined ? label : `${label}（P${period.period}）`;
  });
});

// 与原生 FINIS 对齐：游戏对科目值和合计都是**向下取整**（负数也往下，例如
// -232,539.4 显示 -232,540），而插件原来用四舍五入，导致每个非整数科目都比
// 原生大 1。这里统一改成 floor，两个页面的数字就完全一致。
// 注意：原生合计不是「逐项取整后相加」，而是各自对原值求和再取整，所以这里
// 只改显示，values / totals 内部仍保留原始小数。
function cell(value: number | undefined) {
  return value === undefined ? '—' : formatCurrency(Math.floor(value));
}
</script>

<template>
  <div :class="$style.root">
    <div :class="$style.title">利润表（插件口径）</div>
    <div v-if="!hasData" :class="$style.empty">
      还没有收到会计期间数据。打开一次 <b>FIN</b> 或 <b>FINIS</b> 后回来即可看到。
    </div>
    <table v-else :class="$style.table">
      <thead>
        <tr>
          <th>科目</th>
          <th v-for="h in headers" :key="h" :class="$style.num">{{ h }}</th>
          <th :class="$style.num">合计</th>
        </tr>
      </thead>
      <tbody>
        <tr :class="$style.section">
          <td colspan="5">收入</td>
        </tr>
        <tr v-for="row in revenueRows" :key="row.type">
          <td :title="row.hint" :class="$style.groupRow">{{ row.name }}</td>
          <td v-for="(v, i) in row.values" :key="i" :class="$style.num">{{ cell(v) }}</td>
          <td :class="$style.num">{{ cell(row.total) }}</td>
        </tr>
        <tr :class="$style.subtotal">
          <td>收入合计</td>
          <td v-for="(v, i) in revenueTotals" :key="i" :class="$style.num">{{ cell(v) }}</td>
          <td :class="$style.num">{{ cell(revenueTotals.reduce((a, b) => a + b, 0)) }}</td>
        </tr>

        <tr :class="$style.gap"><td colspan="5"></td></tr>
        <tr :class="[$style.section, $style.sectionMajor]">
          <td colspan="5">支出</td>
        </tr>
        <template v-for="group in expenseGroups" :key="group.id">
          <tr :class="$style.group">
            <td colspan="5" :title="group.hint">{{ group.name }}</td>
          </tr>
          <tr v-for="row in group.rows" :key="row.type">
            <td :title="row.hint" :class="$style.groupRow">{{ row.name }}</td>
            <td v-for="(v, i) in row.values" :key="i" :class="$style.num">{{ cell(v) }}</td>
            <td :class="$style.num">{{ cell(row.total) }}</td>
          </tr>
          <tr :class="$style.groupSubtotal">
            <td>{{ group.name }}小计</td>
            <td v-for="(v, i) in group.totals" :key="i" :class="$style.num">{{ cell(v) }}</td>
            <td :class="$style.num">{{ cell(group.total) }}</td>
          </tr>
        </template>
        <tr :class="$style.subtotal">
          <td>支出合计</td>
          <td v-for="(v, i) in expenseTotals" :key="i" :class="$style.num">{{ cell(v) }}</td>
          <td :class="$style.num">{{ cell(expenseTotals.reduce((a, b) => a + b, 0)) }}</td>
        </tr>

        <tr :class="$style.gap"><td colspan="5"></td></tr>
        <tr :class="$style.net">
          <td>净利润</td>
          <td v-for="(v, i) in netTotals" :key="i" :class="$style.num">{{ cell(v) }}</td>
          <td :class="$style.num">{{ cell(netTotals.reduce((a, b) => a + b, 0)) }}</td>
        </tr>
      </tbody>
    </table>
    <div :class="$style.note">
      数据来自游戏下发的会计期间余额（最近
      {{ accountingPeriods.recent(COLUMNS).length }} 期）。收入/支出类科目的
      期末余额即当期发生额；未列出的科目显示为「科目 #编号」。
    </div>
  </div>
</template>

<style module>
.root {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
  padding: 0.25rem 0.5rem;
  font-size: calc(1em + 1px);
}

.title {
  font-weight: 600;
}

.empty {
  opacity: 0.75;
}

.table {
  width: 100%;
  border-collapse: collapse;
}

.table th,
.table td {
  padding: 1px 6px;
  white-space: nowrap;
  text-align: left;
}

/* 金额列右对齐。必须带 .table 前缀：上面的 `.table td { text-align: left }`
   特异性更高，光写 .num 会被压掉（表体和表头都左对齐）。 */
.table .num {
  text-align: right;
  font-variant-numeric: tabular-nums;
}

/* 大组之间的半行留白：用空行而不是 margin（表格行不吃 margin）。
   line-height / font-size 归零，否则行高会被内容撑起来。 */
.gap td {
  height: 6px;
  padding: 0;
  border: none;
  font-size: 0;
  line-height: 0;
}

/* 一级科目（收入 / 支出）：整行加底色、字号放大、上下都有边框，和明细明显分开。
   底色用中性灰、不依赖主题色，深浅两套主题下都不会被主题引擎改花。 */
.section td {
  padding-top: 6px;
  padding-bottom: 2px;
  font-size: 1.12em;
  font-weight: 700;
  letter-spacing: 0.02em;
  /* 用背景图而不是 background-color：主题引擎会把带色背景改写成面板色，
     底色会整块消失；背景图不在它的重写范围内。 */
  background-image: linear-gradient(rgba(128, 128, 128, 0.25), rgba(128, 128, 128, 0.25));
  border-top: 1px solid rgba(128, 128, 128, 0.45);
  border-bottom: 1px solid rgba(128, 128, 128, 0.45);
}

/* 支出分组的层级：标题不缩进（与「支出」同级、靠字重和淡色弱化），
   明细缩进 16px，小计缩进 8px —— 之前标题缩进 10px、明细 18px，
   两者只差 8px 又都是左对齐，实际看不出谁是谁的子项。 */
.group td {
  padding-top: 6px;
  /* 与「支出」标题同一缩进（表格 td 的基准 padding 是 6px），不额外缩进。
     字号不缩：全表只有一档字号，层级靠缩进 + 字重 + 淡色区分。 */
  padding-left: 6px;
  font-weight: 600;
  font-size: 1em;
  opacity: 0.75;
}

.table .groupRow {
  padding-left: 22px;
}

/* 小计是金额行，字号必须与明细一致——之前整行压到 0.95em，金额反而比明细小，
   层级上像"降级"。区分靠字重和虚线上边框，不靠字号。 */
.groupSubtotal td {
  padding-left: 14px;
  font-weight: 600;
  font-size: 1em;
  border-top: 1px dotted rgba(128, 128, 128, 0.45);
}

.subtotal td {
  font-weight: 600;
  border-top: 1px solid rgba(128, 128, 128, 0.35);
}

/* 与上文关系更远的整段（支出、净利润）再压一条粗线：上面留白 + 这条线，
   比单靠留白更容易看出"新的一段开始了"。「收入」是表头下第一段，不需要。 */
.sectionMajor td {
  border-top-width: 2px;
  border-top-color: rgba(128, 128, 128, 0.6);
}

/* 净利润是这张表的结论，比一级科目再重一档：更深的底色 + 双线。 */
.net td {
  font-size: 1.12em;
  font-weight: 700;
  letter-spacing: 0.02em;
  background-image: linear-gradient(rgba(128, 128, 128, 0.38), rgba(128, 128, 128, 0.38));
  border-top: 2px solid rgba(128, 128, 128, 0.6);
  border-bottom: 2px solid rgba(128, 128, 128, 0.6);
}

.note {
  opacity: 0.65;
  font-size: 0.9em;
}
</style>
