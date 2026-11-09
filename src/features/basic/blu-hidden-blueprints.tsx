import { computed } from 'vue';
import { userData } from '@src/store/user-data';
import { hasMountedUi } from '@src/utils/mount-ui-once';
import { watchEffectWhileNodeAlive } from '@src/utils/watch';
import $style from './blu-hidden-blueprints.module.css';

// BLU 的显隐是「固定的」：写入 userData.settings 后由 user-data-serializer 自动
// 落盘到 chrome.storage.local，刷新页面 loadUserData 原样恢复。只有手动点击
// 「隐藏」按钮 / 右上角状态按钮才会改变，服务器数据更新、窗口重开、排序变化都不会重置。
const hidden = computed(() => userData.settings.hiddenBlueprints ?? []);
const hiddenSet = computed(() => new Set(hidden.value));
const showHidden = computed({
  get: () => userData.settings.showHiddenBlueprints ?? false,
  set: (value: boolean) => (userData.settings.showHiddenBlueprints = value),
});
// 用户视角的「隐藏功能是否生效」。数据层字段叫 showHiddenBlueprints（是否把
// 被隐藏的蓝图显示出来），语义正好相反：字段为 false 时隐藏才真正生效。
// 右上角按钮文字固定为「隐藏」，靠 hiddenActive 决定选中态：
//   选中 = 隐藏生效，被标记的蓝图不出现在列表里（showHidden=false）
//   未选中 = 隐藏停用，被标记的蓝图淡显出来，方便一键恢复（showHidden=true）
const hiddenActive = computed(() => !showHidden.value);

function toggleHidden(id: string) {
  const list = hidden.value;
  const index = list.indexOf(id);
  if (index >= 0) {
    list.splice(index, 1);
  } else {
    list.push(id);
  }
}

// 游戏是 React 渲染：BLU 表格行既没有 data-prun-id，行文本里也没有蓝图编码，
// 而且名称允许重复（实测有 6 行都叫「作废」），不能拿名称当键。
// 每行 tr 的 React fiber.key 就是蓝图 id（32 位 hex，实测 22 行全唯一）；
// 名称列 Link 的 fiber 祖先链上还带该行专属的 naturalId（BP-XXXX-NNNN），
// 正是 XIT BPC 蓝图下拉框用的 value。优先存 naturalId，取不到退回 id；
// BPC 侧同时按 naturalId / id 匹配，两种结果都能同步。
const NATURAL_ID_RE = /^BP-[A-Z0-9]+-[A-Z0-9]+$/;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function fiberOf(element: Element | null): any {
  if (!element) {
    return null;
  }
  const key = Object.keys(element).find(x => x.startsWith('__reactFiber$'));
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return key ? (element as any)[key] : null;
}

function blueprintIdOf(row: HTMLTableRowElement): string | null {
  let fiber = fiberOf(row.querySelector('[class*="Link__link"]'));
  for (let i = 0; i < 10 && fiber; i++, fiber = fiber.return) {
    const naturalId = fiber.memoizedProps?.naturalId;
    if (typeof naturalId === 'string' && NATURAL_ID_RE.test(naturalId)) {
      return naturalId;
    }
  }
  const key = fiberOf(row)?.key;
  return typeof key === 'string' && key.length > 8 ? key : null;
}

function onTileReady(tile: PrunTile) {
  // 两个按钮都是纯文字，且刻意不写 title / data-tooltip / data-tooltip-position：
  // 浏览器原生 title 与游戏 [data-tooltip] 伪元素都会弹浮窗，两者还会同时出现、
  // 文案不一致。按用户要求完全移除鼠标浮窗，无障碍名称改用 aria-label（不弹窗）。
  // 「新建」按钮左边：直接把状态按钮塞进按钮所在的 ActionBar__element，
  // 无论外层 flex 怎么对齐，两个按钮都紧邻、状态按钮恒在左侧。
  // 右上角与表体一样：文字固定「隐藏」二字 + CSS 定宽，靠选中态表达开关，
  // 不写「开 / 关」字样。data-rp-blu-show 保留数据层原语义（on=显示隐藏项），
  // 另给 data-rp-blu-hidden-active 表示按钮选中态（on=隐藏生效），全局 CSS
  // 按该属性画反色实底。表体行按钮同样固定「隐藏」，用 aria-pressed 表达选中。
  // 游戏是 React 异步渲染，onTileReady 触发时 ActionBar 可能还没出现，
  // 所以订阅新出现的 button 而不是当场查询一次，刷新后首次加载也不会漏。
  subscribe($$(tile.frame, 'button'), button => {
    if (button.textContent?.trim() !== '新建') {
      return;
    }
    const host = button.parentElement;
    if (!host || hasMountedUi(host, 'blu-show-hidden-toggle')) {
      return;
    }
    createFragmentApp(() => (
      <button
        type="button"
        data-rp-ui="blu-show-hidden-toggle"
        data-rp-blu-show={showHidden.value ? 'on' : 'off'}
        data-rp-blu-hidden-active={hiddenActive.value ? 'on' : 'off'}
        class={[
          C.Button.btn,
          $style.textButton,
          $style.toggle,
          hiddenActive.value ? $style.isOn : '',
        ]}
        aria-label="隐藏蓝图开关"
        aria-pressed={hiddenActive.value}
        onClick={() => (showHidden.value = !showHidden.value)}>
        隐藏
      </button>
    )).prependTo(host);
  });

  // 表体「指令」列：每个蓝图行最前面加一个固定文字「隐藏」的切换按钮。
  // 按用户要求做成「选中模式」：文字永远是「隐藏」两字，已隐藏的行按钮呈
  // 选中态（填充底 + 强调色 + 加粗 + 下划线）并用 aria-pressed=true 表达，
  // 再点一下取消隐藏。表头行（只有 th）跳过。
  subscribe($$(tile.anchor, 'tr'), row => {
    if (!row.querySelector('td') || hasMountedUi(row, 'blu-hide-button')) {
      return;
    }
    const cell = row.children[row.children.length - 1] as HTMLElement | undefined;
    if (!cell) {
      return;
    }
    const id = blueprintIdOf(row as HTMLTableRowElement);
    if (!id) {
      return;
    }

    createFragmentApp(() => {
      const isHidden = hiddenSet.value.has(id);
      return (
        <button
          type="button"
          data-rp-ui="blu-hide-button"
          data-rp-blu-hidden={isHidden ? 'on' : 'off'}
          class={[$style.textButton, $style.rowBtn, isHidden ? $style.selected : '']}
          aria-label="隐藏此蓝图"
          aria-pressed={isHidden}
          onClick={() => toggleHidden(id)}>
          隐藏
        </button>
      );
    }).prependTo(cell);

    // 显隐完全由持久化状态驱动：开关关闭时隐藏行不渲染，打开时淡显并保留
    // 文字按钮，方便一键恢复。React 不给 tr 写 inline display，这里直接改
    // style 不会被重渲染覆盖；节点被移除时 watch 自动停止。
    watchEffectWhileNodeAlive(row, () => {
      const isHidden = hiddenSet.value.has(id);
      const visible = showHidden.value || !isHidden;
      const style = (row as HTMLElement).style;
      style.display = visible ? '' : 'none';
      style.opacity = isHidden && visible ? '0.55' : '';
    });
  });
}

function init() {
  tiles.observe('BLU', onTileReady);
}

features.add(
  import.meta.url,
  init,
  'BLU：「指令」列每行一个固定文字「隐藏」的选中态按钮（选中=该行已隐藏），「新建」左侧一个同款定宽「隐藏」总开关（选中=隐藏生效、隐藏行不显示；未选中=隐藏行淡显可恢复）；两者文字都不写「开 / 关」，无鼠标浮窗，显隐持久化，XIT BPC 蓝图下拉同步过滤。',
);
