import { computed, watchEffect } from 'vue';
import { userData } from '@src/store/user-data';
import { hasMountedUi } from '@src/utils/mount-ui-once';
import $style from './inv-compact-layout.module.css';

// 排列模式是全局开关，写进 userData.settings 后由 user-data-serializer 自动保存，
// 刷新页面时 loadUserData 会恢复；只有再次点击按钮才会改变模式。
// 与 BLU「隐藏」/ FLT「产出装船」统一：按钮文字恒为「紧凑排列」，
// 状态靠 aria-pressed + data-rp-selected 表达，选中时只加一条下划线
// （不加底色、不改文字颜色、不改字重），切换时文字与宽度都不变。
const compact = computed({
  get: () => userData.settings.invCompact ?? false,
  set: (value: boolean) => (userData.settings.invCompact = value),
});

function onTileReady(tile: PrunTile) {
  // 同一 frame 上只允许一个按钮：切换标签 / FB 搬移 DOM 会让 observer 重复触发。
  if (hasMountedUi(tile.frame, 'inv-compact-toggle')) {
    return;
  }
  // 按钮挂在 TileFrame__body 内（anchor 的父节点），而不是标题栏控件区或 frame 上：
  // ① FB 面板会把内嵌磁贴的标题栏控件区整个 display:none，挂那里 FB 里看不见；
  // ② body 自身 position:relative，且是正常流元素，站点名行就在 body 顶部 +2px。
  //    挂 body 上用绝对定位即可精确落在「Animus a (VH-874a)（制造）」那一行右端，
  //    而且上下文命令行显隐 / 窗口高度变化时按钮会跟着 body 一起上下移动，不跳位。
  //    重量与体积已被 inv-compress-inventory-info 压到第二行，第一行右侧是空的。
  // 对所有 INV / SHPI 都注入，且不再按 [data-rp-fb-panel] 过滤显隐：
  // 按用户要求，紧凑按钮已同步到全局，独立打开的 INV / SHPI 窗口也能用。
  // FB 是异步把磁贴 appendChild 搬进面板的，挂在磁贴内部结构里可保证两种场景都在。
  const body = tile.anchor.parentElement;
  const host = body ?? tile.frame;
  createFragmentApp(() => (
    <button
      type="button"
      data-rp-ui="inv-compact-toggle"
      data-rp-inv-layout={compact.value ? 'compact' : 'regular'}
      data-rp-selected={compact.value ? 'on' : 'off'}
      // 极少数结构异常下回退挂到 frame，此时用 47px 补偿标题栏 + 上下文栏高度。
      style={{ '--rp-inv-compact-top': body ? '2px' : '47px' }}
      class={[C.Button.btn, C.Button.dark, $style.toggle, compact.value ? $style.active : '']}
      aria-label="紧凑排列"
      aria-pressed={compact.value}
      onClick={() => (compact.value = !compact.value)}>
      紧凑排列
    </button>
  )).appendTo(host);
}

function init() {
  // refined-prun.css 里的紧凑规则统一带 html[data-rp-inv-compact='on'] 前缀，
  // 不再限制 [data-rp-fb-panel]：打开紧凑后全局 INV / SHPI（含独立窗口与
  // XIT FB 面板内的磁贴）一起切换；关闭时全部恢复 BRN 分行与 48px 图标。
  watchEffect(() => {
    document.documentElement.dataset.rpInvCompact = compact.value ? 'on' : 'off';
  });
  tiles.observe(['INV', 'SHPI'], onTileReady);
}

features.add(
  import.meta.url,
  init,
  '所有 INV/SHPI 窗口（含 XIT ABCC 面板内磁贴与独立打开的命令窗口）：窗体内部站点名行（如「Animus a (VH-874a)（制造）」）右端一个文字恒为「紧凑排列」的选中态按钮（选中=紧凑排列生效，靠 aria-pressed 与下划线表达，不切换文案、不改变宽度、不加底色），切换紧凑竖排分组与 BRN 分行原版排列；全局共用一个开关，设置持久化，刷新后保持。',
);
