// CONTD 合同草案详情视图：把 XIT CONTGEN 合同生成器直接嵌入到「条件」区下方，
// 让用户无需在独立的 XIT CONTGEN 面板与 CONTD 之间来回切换即可就地生成并填充条件。
//
// 设计要点：
// 1) 只作用于详情视图（tile.parameter 存在，形如 CD-XXX-XXXX）；列表面板没有条件表单，
//    也不应出现生成器。
// 2) 生成器以 Vue 组件形式挂到 CONTD 详情所有原生内容之后（ScrollView 末尾，
//    即「指令/保存」form 下方），不嵌在条件区中间。C.Draft.conditions 仅用于定位。
// 3) 状态独立：tileStatePlugin 用当前 CONTD tile（数字 id）作为 state key，与独立
//    XIT CONTGEN 页面（XIT tile 的 id）天然隔离，两边表单设置互不干扰。
// 4) 主按钮走 fillDraft(tile, json) 就地填充当前草案，不走「新建合同并填充」流程。
// 5) React 会随服务端推送重绘条件区并可能销毁注入 DOM：用 subscribe 在每个新出现的
//    条件容器上重建；用 marker 检测已挂载且仍连接的容器，避免重复注入。容器断开时
//    createFragmentApp.appendTo 内置的 onNodeDisconnected 会自动卸载 Vue app。
import CONTGEN from '@src/features/XIT/CONTGEN/CONTGEN.vue';
import { fillDraft, hideLegacyPanel } from '@src/features/basic/contd-auto-fill';
import { tileStatePlugin } from '@src/store/user-data-tiles';
import { tileKey } from '@src/hooks/use-tile';
import { createFragmentApp } from '@src/utils/vue-fragment-app';
import $style from './contd-embed-contgen.module.css';

const MARKER = 'data-rp-contd-embed-contgen';

// 把生成器放到 CONTD 详情所有原生内容的最后（ScrollView 的最后一个子元素之后），
// 而不是嵌在条件区中间。conditions 用来定位所属 ScrollView；其 lastElementChild
// 就是「指令/保存」form，是原生内容的末尾。
function findInsertionAnchor(conditions: HTMLElement): HTMLElement {
  const scrollView = conditions.closest('[class*="ScrollView__view"]');
  const last = scrollView?.lastElementChild;
  return ((last as HTMLElement | null) ?? conditions) as HTMLElement;
}

function mountGenerator(tile: PrunTile, conditions: HTMLElement) {
  // 已有容器且仍在文档中（React 未销毁它）——不重复注入，但必须重新定位。
  // 关键点：点击「选择模板」进入编辑态时，React 会重绘 ScrollView 并移除原生
  // 详情内容；点「取消」返回时再把详情内容重新 append 到末尾。我们的容器是
  // 手动注入、React 不认识的节点，重绘后会滞留在 ScrollView 首位（错位到最上方）。
  // 因此每次 subscribe 触发都要把它移回末尾。移动的是本 feature 自建容器，
  // onNodeDisconnected 监听的是容器本身且始终 connected，不会误卸载 Vue app。
  const existing = tile.anchor.querySelector<HTMLElement>(`[${MARKER}]`);
  if (existing !== null && existing.isConnected) {
    const anchor = findInsertionAnchor(conditions);
    // anchor 可能就是容器自身（它已是最后一个子元素），此时无需移动。
    if (anchor !== existing && existing.nextElementSibling !== null) {
      anchor.after(existing);
    }
    return;
  }
  // 已脱离文档的旧容器由 appendTo 的 onNodeDisconnected 负责卸载，这里仅清节点。
  existing?.remove();

  const container = document.createElement('div');
  container.className = $style.container;
  container.setAttribute(MARKER, 'true');
  // 同时打上框架的 data-rp-ui 标记：切标签页 / 移动 FB 时 frame 会断开再挂回，
  // appendTo 的 onNodeDisconnected 会卸载 Vue app，但容器节点本身留在 frame 上；
  // prun-ui/tiles.ts 的重新激活清理只移除 [data-rp-ui] 节点。不打标记的话容器会被
  // 保留，而下面的 existing 判断看到它仍 connected 就不再挂载，结果是一个没有内嵌
  // app 的空壳（旧 JSON 面板又已被隐藏，用户没有任何入口）。
  container.setAttribute('data-rp-ui', 'contd-embed-contgen');

  // 标题行：复用游戏原生 SectionHeader 类，格式与「发送合同草案」完全一致。
  const title = document.createElement('div');
  title.className = C.SectionHeader.container;
  title.textContent = '合同生成器';
  title.setAttribute('data-rp-embed-title', 'true');
  container.append(title);

  // 生成器主体放在标题下方的 flex 子项，占据剩余高度。
  const body = document.createElement('div');
  body.className = $style.body;
  container.append(body);

  // 先放入 DOM 锚点，再挂载，appendTo 才能绑定 onNodeDisconnected 监听。
  findInsertionAnchor(conditions).after(container);

  // 生成器已如实挂载，这时才隐藏 contd-auto-fill 的旧「JSON 配置」手动面板——
  // 隐藏动作归本 feature 负责，而不是让 auto-fill 无条件隐藏：本功能属 advanced，
  // BASIC 模式或被用户关掉时不会加载，旧面板必须保持可用，否则用户既没有生成器、
  // 也没有 JSON 手动入口。反方向（旧面板晚于生成器创建）由 buildPanel 里的
  // EMBED_MARKER 检查补齐。
  hideLegacyPanel(tile.anchor);

  createFragmentApp(CONTGEN, {
    fillCurrent: (json: string) => fillDraft(tile, json),
  })
    .use(tileStatePlugin, { tile })
    .provide(tileKey, tile)
    .appendTo(body);
}

function onTileReady(tile: PrunTile) {
  // 仅详情视图（CONTD <naturalId>）才嵌入；列表面板无参数，跳过。
  if (!tile.parameter) {
    return;
  }
  subscribe($$(tile.anchor, C.Draft.conditions), conditions => {
    mountGenerator(tile, conditions as HTMLElement);
  });
}

function init() {
  tiles.observe('CONTD', onTileReady);
}

features.add(
  import.meta.url,
  init,
  'CONTD：在详情底部嵌入合同生成器，可直接生成并填充当前草案（表单设置与独立 CONTGEN 互不干扰）。',
);
