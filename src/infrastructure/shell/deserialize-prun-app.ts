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
  clone.type = script.type;
  document.head.appendChild(clone);
  script.remove();
}
