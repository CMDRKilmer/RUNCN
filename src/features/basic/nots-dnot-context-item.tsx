import ContextControlsItem from '@src/components/ContextControlsItem.vue';
import { mountOnce } from '@src/utils/mount-ui-once';

// NOTS 的上下文菜单栏注入「桌面通知」入口，点击打开 XIT DNOT 设置页。
// 与 inv-nx-buy-fuel-button 同一套做法：用 mountOnce 防止切标签 / 热重载时
// 重复挂载；appendTo 排在原生项之后，不改变 NOTIG / NOTPNS 的顺序。
async function onTileReady(tile: PrunTile) {
  const contextBar = await $(tile.frame, C.ContextControls.container);
  mountOnce(contextBar, 'nots-dnot-context-item', () => {
    createFragmentApp(() => <ContextControlsItem cmd="XIT DNOT" display="桌面通知" />).appendTo(
      contextBar,
    );
  });
}

function init() {
  tiles.observe('NOTS', onTileReady);
}

features.add(
  import.meta.url,
  init,
  'NOTS：上下文菜单栏添加「桌面通知」入口（点击打开 XIT DNOT 设置页），外显纯中文，不显示命令字样。',
);
