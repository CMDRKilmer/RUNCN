import { selectAddress } from '@src/infrastructure/prun-ui/utils/select-address';
import { setScreenVariable } from '@src/core/screen-variables';
import { showBuffer } from '@src/infrastructure/prun-ui/buffers';

// 把 nativeId 写入插件自研变量 BS。
// 优先级:
//   1. 当前有打开的原生 AddressSelector -> 写入该选择框(沿用 PlanetRow 已有路径)。
//   2. 否则写入原生 ScreenVariableControls__bar 的 BS 输入框。提交后:
//      - 服务器推送 UI_SCREENS_VARIABLES,所有引用 $BS 的 tile 同步(parameter 重渲染);
//      - 同时 BS tile 自身会打开对应地址的新 tile (INV/PLI 等) —— 这是游戏内置逻辑。
//   3. 兜底:showBuffer('BS <id>')。
// 插件自维护 store 同步更新,作为补充/查询入口。
export async function writeScreenVariable(name: string, naturalId: string): Promise<boolean> {
  setScreenVariable(name, naturalId);

  // 阶段 4 探查结论: 客户端消息工厂无 UI_SCREENS_* 类,直接发服务器会被丢弃/报错,
  // 因此走"操作原生 BS input"路径 —— 该路径已被实证可触发服务器 UI_SCREENS_VARIABLES 同步。
  // 离屏状态(见 init())下 listbox portal 测不到几何位置,selectAddress 期间
  // 必须临时把 bar 移回屏幕 (withBarVisible),写完再恢复离屏。
  return withBarVisible(async () => {
    const bar = document.querySelector(
      '[class*="ScreenVariableControls__bar"]',
    ) as HTMLElement | null;
    const input = bar?.querySelector('input') as HTMLInputElement | null;
    if (input !== null) {
      const container = input.closest(`.${C.AddressSelector.container}`) as HTMLElement | null;
      if (container !== null && (await selectAddress(container, naturalId))) {
        return true;
      }
    }
    showBuffer(`BS ${naturalId}`);
    return true;
  });
}

function init() {
  // 阶段 1: 隐藏原生 ScreenVariableControls__bar。
  // 不用 display:none —— react-autosuggest 的 listbox portal 在 display:none 祖先下
  // 测不到几何位置,server query 响应丢失,selectAddress 失败。
  // 改用 transform 移出屏幕:容器仍参与渲染、可接收 focus、可发起/接收 listbox portal,
  // 视觉上完全不可见 (translate(-200vw, -200vh) 是 docs/feature-patterns.md 推荐的
  // "离屏窗口"做法,FTC 自动设置 SFC 滑块时也用同样手法)。
  const style = document.createElement('style');
  style.id = 'rp-screen-variables-hide';
  // position:absolute 让 bar 脱离父 flex 布局(原本占的 24px 行高不会留空白),
  // top/left:0 + transform 离屏保证可被 focus / listbox portal 正常测量,react-autosuggest 可拉 server query。
  style.textContent = `[class*="ScreenVariableControls__bar"] { position: absolute !important; top: 0 !important; left: 0 !important; transform: translate(-200vw, -200vh) !important; }`;
  document.head.appendChild(style);
}

// 临时把 bar 移回屏幕内 —— writeScreenVariable 写入期间调用,完成/失败后必须恢复离屏。
// 用 refcount 避免并发调用互相覆盖内联 style。
let refCount = 0;
const originalStyles = new WeakMap<HTMLElement, { position: string; transform: string }>();

async function withBarVisible<T>(fn: () => Promise<T>): Promise<T> {
  const bar = document.querySelector(
    '[class*="ScreenVariableControls__bar"]',
  ) as HTMLElement | null;
  if (bar === null) {
    return fn();
  }
  refCount++;
  if (refCount === 1) {
    originalStyles.set(bar, {
      position: bar.style.position,
      transform: bar.style.transform,
    });
    // 撤掉离屏样式 —— bar 回到游戏原始 flex 子项位置,selectAddress 可正常工作。
    // 用户视觉上仍看不到 (200ms 内的瞬时闪回) —— 取决于游戏原生 bar 背景色与 z-index。
    bar.style.position = '';
    bar.style.transform = '';
  }
  try {
    return await fn();
  } finally {
    refCount--;
    if (refCount === 0) {
      const orig = originalStyles.get(bar);
      if (orig !== undefined) {
        bar.style.position = orig.position;
        bar.style.transform = orig.transform;
        originalStyles.delete(bar);
      }
    }
  }
}

features.add(import.meta.url, init, '用插件自研变量栏替换原生界面变量栏。');
