const script = document.getElementById('refined-prun-config');
const json = script?.textContent ?? '';
if (json.length === 0) {
  // 正常流程 startup 会注入完整 JSON；为空说明页面级脚本执行了第二次
  // （例如本站同时启用了另一份本扩展副本，配置元素已被前一次消费置空）。
  throw new Error(
    'refined-prun: #refined-prun-config is empty — the page-level script likely ' +
      'ran twice (another copy of this extension may be enabled on this site).',
  );
}
const config = JSON.parse(json) as RefinedPrunConfig;
script!.textContent = null;
export default config;
