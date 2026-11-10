/**
 * 插件 UI 注入的幂等保护。
 *
 * 游戏 SPA 在切换标签、或 FB 面板 appendChild 搬移磁贴 DOM 时，可能让
 * tiles.observe 的回调在同一个容器上执行多次；扩展热重载后也可能短暂存在
 * 两个 content script 实例。两处都往同一容器 append，就会出现重复的眼睛图标、
 * 「别名 / WAREHOUSE」按钮等。DOM 是共享的，所以标记必须写在 DOM 上。
 */

/** 检查容器里是否还有本插件注入的、带指定标记的 UI。 */
export function hasMountedUi(container: ParentNode, key: string): boolean {
  return container.querySelector(`[data-rp-ui="${key}"]`) !== null;
}

/**
 * 容器级幂等标记，用于注入节点无法打属性的场合（例如渲染的是组件）。
 * 标记挂在容器上；容器被游戏整体重建时标记随之消失，会正常重新挂载。
 */
export function mountOnce(container: Element, key: string, mount: () => void): void {
  const attr = `data-rp-ui-${key}`;
  if (container.hasAttribute(attr)) {
    return;
  }
  container.setAttribute(attr, '');
  mount();
}
