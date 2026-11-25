import { computed } from 'vue';
import { userData } from '@src/store/user-data';
import onNodeDisconnected from '@src/utils/on-node-disconnected';
import { hasMountedUi } from '@src/utils/mount-ui-once';
import $style from './flt-autoload-toggle.module.css';

// BSN 产物自动装船是「会静默搬走真实库存」的自动化，默认关闭。
// 开关原本在 XIT SET → 功能，现放到所有 XIT FLT 的标题栏右侧：
// 独立窗口与 XIT FB / ABCC 面板内的 XIT FLT 都显示，共用同一个开关。
// 仍写回同一个 userData.settings.autoLoadProducts.enabled，
// auto-load-products.ts 的数据链路与持久化完全不用改。
// 按钮文字固定为「产出装船」，不再写「开 / 关」：状态由 aria-pressed 与
// 选中态反色实底表达（CSS 在 refined-prun.css 按 data-rp-autoload 驱动）。
// 注意：把 enabled 置 true 会触发 MTRA 搬真实库存，真机验收不要真开。
const enabled = computed({
  get: () => userData.settings.autoLoadProducts?.enabled === true,
  set: (value: boolean) => {
    userData.settings.autoLoadProducts ??= { enabled: false };
    userData.settings.autoLoadProducts.enabled = value;
  },
});

function onTileReady(tile: PrunTile) {
  // XIT 系列磁贴的 tile.command 统一是 'XIT'，子命令只在 fullCommand 里，
  // 所以必须按完整命令过滤，避免给 XIT FB / XIT BURN 也注入一个隐藏按钮。
  if ((tile.fullCommand ?? '').trim().toUpperCase() !== 'XIT FLT') {
    return;
  }
  // 同一 frame 上只允许一个按钮：切换标签 / FB 搬移 DOM 会让 observer 重复触发。
  if (hasMountedUi(tile.frame, 'flt-autoload-toggle')) {
    return;
  }
  // 按钮挂在 frame 内部：FB 面板会把内嵌磁贴的 TileFrame.controls 整个
  // display:none，挂那里在 FB 里看不见；frame 自身是 position:relative，
  // 绝对定位到标题栏右侧最稳妥。FB 是异步把磁贴 appendChild 搬进面板的，
  // 注入这一刻可能还没搬进去，所以显隐完全交给 refined-prun.css 的全局规则。
  // 独立窗口还有游戏原生控件（设置 / 最大化 / 关闭），量出它的实际宽度写到
  // frame 上给 CSS 推开按钮；FB 内嵌磁贴的控件被隐藏，量到 0，按钮贴最右。
  // 控件显隐 / 宽度变化（FB 搬移、窗口缩放）由 ResizeObserver 跟进。
  createFragmentApp(() => (
    <button
      type="button"
      data-rp-ui="flt-autoload-toggle"
      data-rp-autoload={enabled.value ? 'on' : 'off'}
      aria-label="BSN 产物自动装船开关"
      aria-pressed={enabled.value}
      class={[C.Button.btn, C.Button.dark, $style.toggle]}
      onClick={() => (enabled.value = !enabled.value)}>
      产出装船
    </button>
  )).appendTo(tile.frame);

  const controlsOf = () => _$(tile.frame, C.TileFrame.controls) as HTMLElement | undefined;
  const measure = (controls: HTMLElement | undefined) => {
    const width = controls === undefined ? 0 : Math.round(controls.getBoundingClientRect().width);
    tile.frame.style.setProperty('--rp-flt-controls-width', `${width}px`);
  };

  // 注入这一刻原生控件可能还没渲染（窗口首帧、FB 异步搬移）：此时 width 记 0
  // 会把按钮压到设置/最大化/关闭图标下面，而控件出现后没有任何回调来纠正。
  // 因此找不到控件就按帧重试（最多约 2 秒），找到后再挂 ResizeObserver 跟进
  // 控件显隐与窗口缩放；磁贴销毁时同时停掉重试与观察器。
  let retry: number | undefined;
  let observer: ResizeObserver | undefined;
  let attempts = 120;
  const attach = () => {
    retry = undefined;
    const controls = controlsOf();
    measure(controls);
    if (controls === undefined) {
      if (attempts > 0 && tile.anchor.isConnected) {
        attempts -= 1;
        retry = requestAnimationFrame(attach);
      }
      return;
    }
    observer = new ResizeObserver(() => measure(controls));
    observer.observe(controls);
  };
  attach();
  onNodeDisconnected(tile.anchor, () => {
    if (retry !== undefined) {
      cancelAnimationFrame(retry);
    }
    observer?.disconnect();
  });
}

function init() {
  // 默认值与存量回填在 user-data.ts / user-data-migrations.ts 已做，
  // 这里再兜一次底，避免旧配置缺字段时 computed 的 setter 拿到 undefined。
  userData.settings.autoLoadProducts ??= { enabled: false };
  tiles.observe('XIT', onTileReady);
}

features.add(
  import.meta.url,
  init,
  'XIT FLT 标题栏右侧「产出装船」开关，控制 BSN 产物自动装船（默认关）。',
  // 与 auto-load-products 一样标 hidden：这个 feature 本身就是开关的载体，
  // 不能让用户在 XIT SET → 功能 里把它关掉（否则按钮消失、开关也没了），
  // 也不该在设置页里再留一条与自动装船相关的条目。
  true,
);
