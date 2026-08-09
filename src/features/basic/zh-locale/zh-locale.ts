/**
 * 中文本地化注册器
 *
 * 在 loadPrunI18N() 执行后应用，将 zh-CN.ts 中的翻译
 * 通过 setI18nValue() 注入到全局 PrunI18N 中。
 *
 * 此模块位于 features/basic/，无论用户选择何种模式（FULL/STANDARD）都会加载，
 * 因为中文本地化是基本功能，不应当受 advanced 模式开关影响。
 */
import { setI18nValue } from '@src/infrastructure/prun-ui/i18n';
import { zhCN } from './zh-CN';

function applyZhLocale() {
  for (const [key, value] of Object.entries(zhCN)) {
    setI18nValue(key, value);
  }
}

function init() {
  // Main.ts 中 await initializeUI() 同步执行了 loadPrunI18N()，
  // 此时 PrunI18N 与 window['PrUn_i18n'] 指向同一对象。
  // features.init() 在 await initializeUI() 之后调用，所以这里直接同步执行即可。
  console.log('[ZH-LOCALE] init() running, applying', Object.keys(zhCN).length, 'translations');
  applyZhLocale();
  console.log(
    '[ZH-LOCALE] init() done; sample key:',
    JSON.stringify(window['PrUn_i18n']?.['RP.XIT.BS.name']),
  );
}

features.add(import.meta.url, init, 'ZH-LOCALE：注册简体中文翻译。');

export { applyZhLocale, zhCN };
