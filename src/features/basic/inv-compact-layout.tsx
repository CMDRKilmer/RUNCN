import { computed } from 'vue';
import { userData } from '@src/store/user-data';
import { hasMountedUi } from '@src/utils/mount-ui-once';
import $style from './inv-compact-layout.module.css';

// 排列模式按「基地 / 船只」各自记忆（R51）：key 取 `命令:参数` —— INV 的 parameter
// 是基地 naturalId、SHPI 是船注册码。所以同一个基地在独立窗口与 XIT FB 面板里的磁贴
// 共享同一状态，不同基地 / 船只互不影响（此前是一个全局开关，点一处全部一起变）。
// 状态写进 userData.settings.invCompactScopes 后由 user-data-serializer 自动保存，
// 刷新页面即恢复；未记录过的 key 回落到 settings.invCompact —— 它曾是全局开关，
// 现在只是「默认值」，于是存量用户升级后看到的排列不变。
// 与 BLU「隐藏」/ FLT「产出装船」统一：按钮文字恒为「紧凑排列」，
// 状态靠 aria-pressed + data-rp-selected 表达，选中时只加一条下划线
// （不加底色、不改文字颜色、不改字重），切换时文字与宽度都不变。
function compactScopeKey(tile: PrunTile) {
  return `${tile.command}:${tile.parameter ?? ''}`;
}

function compactOf(tile: PrunTile) {
  const key = compactScopeKey(tile);
  return computed({
    get: () => userData.settings.invCompactScopes[key] ?? userData.settings.invCompact,
    set: (value: boolean) => {
      userData.settings.invCompactScopes[key] = value;
    },
  });
}

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
  // 对所有 INV / SHPI 都注入，且不按 [data-rp-fb-panel] 过滤显隐：
  // 独立打开的 INV / SHPI 窗口也能用。FB 是异步把磁贴 appendChild 搬进面板的，
  // 挂在磁贴内部结构里可保证两种场景都在。
  const body = tile.anchor.parentElement;
  const host = body ?? tile.frame;
  const compact = compactOf(tile);
  createFragmentApp(() => {
    // 排列状态标记挂在 frame 上（frame 本身带 .rp-command-INV / .rp-command-SHPI 类）：
    // refined-prun.css 的紧凑规则据此逐磁贴匹配，不再读 <html> 上的全局属性。
    // 写在渲染函数里是为了随状态变化同步刷新——点击后同一帧内就生效。
    tile.frame.dataset.rpInvCompact = compact.value ? 'on' : 'off';
    return (
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
    );
  }).appendTo(host);
}

function init() {
  // refined-prun.css 里的紧凑规则统一带 [data-rp-inv-compact='on'] 前缀，属性由上面的
  // 渲染函数逐个磁贴写在 frame 上：紧凑只在该基地 / 船只自己的磁贴内生效，未开启的
  // 磁贴没有任何覆盖，保持游戏原生排列与 48px 图标。
  // 属性已不再挂在 <html> 上；跨磁贴的全局规则（如 FB 主 INV 槽的高度分配）改为
  // :has([data-rp-inv-compact='on']) 逐磁贴判断。
  tiles.observe(['INV', 'SHPI'], onTileReady);
}

features.add(
  import.meta.url,
  init,
  '所有 INV/SHPI 窗口（含 XIT ABCC 面板内磁贴与独立打开的命令窗口）：窗体内部站点名行（如「Animus a (VH-874a)（制造）」）右端一个文字恒为「紧凑排列」的选中态按钮（选中=紧凑排列生效，靠 aria-pressed 与下划线表达，不切换文案、不改变宽度、不加底色），切换紧凑竖排分组与 BRN 分行原版排列；状态按基地 / 船只各自记忆（INV 按基地、SHPI 按船注册码），同一基地的独立窗口与 FB 面板内磁贴共享，不同基地互不影响；设置持久化，刷新后保持。',
);
