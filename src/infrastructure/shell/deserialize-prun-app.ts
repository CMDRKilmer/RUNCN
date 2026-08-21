import { isSafeUrl } from '@src/utils/is-valid-url';

const scripts = document.head.getElementsByTagName('script');
for (let i = 0; i < scripts.length; i++) {
  const script = scripts[i];
  const text = script.textContent;
  if (!text || !isSafeUrl(text, 'apex.prosperousuniverse.com')) {
    continue;
  }
  const safeUrl = new URL(text).href;
  const clone = document.createElement('script');
  clone.src = safeUrl;
  clone.defer = script.defer;
  clone.async = script.async;
  // prepare 阶段把脚本标成了 application/json 以防执行，原始 type 存在 dataset 里。
  clone.type = script.dataset.rpType ?? script.type;
  document.head.appendChild(clone);
  script.remove();
}
