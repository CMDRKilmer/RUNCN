// BURN 星球行右侧的「命令」列：BS / INV / ACT 三个按钮。
// 默认显示；在 XIT SET → 功能 里取消勾选后，下次加载不再给 <html> 加
// data-rp-burn-commands，全局样式随之隐藏该列（表头与星球行的单元格都带
// data-rp-burn-commands-col）。
function init() {
  document.documentElement.setAttribute('data-rp-burn-commands', '');
}

features.add(
  import.meta.url,
  init,
  'BURN：在星球行右侧显示「命令」列（BS / INV / ACT 三个按钮）。',
);
