// RTE 航线执行面板顶部「航线 / 船只 / 状态 / 行程」四字段压缩成一行、平均分布。
// 默认开启；在 XIT SET → 功能 里取消勾选后，下次加载不再给 <html> 加
// data-rp-rte-compact，refined-prun.css 里的压缩样式随之失效（恢复原生四行）。
function init() {
  document.documentElement.setAttribute('data-rp-rte-compact', '');
}

features.add(import.meta.url, init, 'RTE：顶部「航线 / 船只 / 状态 / 行程」压缩成一行、平均分布。');
