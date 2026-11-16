import $style from './rte-columns-layout.module.css';

function init() {
  // RTE 是游戏原生命令；只在该命令窗口内把路径点列表从纵向改为横向多栏。
  // 原生类名的哈希后缀会随版本变化，用前缀属性选择器保持稳定。
  applyCssRule('RTE', '[class*="Waypoints__container"]', $style.container);
  applyCssRule(
    'RTE',
    '[class*="Waypoints__container"] > [class*="Waypoint__container"]',
    $style.column,
  );
}

features.add(import.meta.url, init, 'RTE 路径点多栏布局：每个路径点独立成栏');
