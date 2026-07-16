const script = document.getElementById('refined-prun-config')!;
const config = JSON.parse(script.textContent!) as RefinedPrunConfig;
script.textContent = null;
export default config;
