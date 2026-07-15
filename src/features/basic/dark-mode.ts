import { userData } from '@src/store/user-data';

function init() {
  const style = document.createElement('style');
  style.id = 'rprun-dark-mode';
  document.head.appendChild(style);

  watchEffect(() => {
    const dm = userData.settings.darkMode;
    if (!dm.enabled) {
      style.textContent = '';
      return;
    }
    const filter = [
      `brightness(${dm.brightness / 100})`,
      `contrast(${dm.contrast / 100})`,
      `sepia(${dm.sepia / 100})`,
      `grayscale(${dm.grayscale / 100})`,
    ].join(' ');
    style.textContent = `
html {
  filter: ${filter};
  background-color: ${dm.background} !important;
}
body {
  background-color: ${dm.background} !important;
  color: ${dm.text};
}
::selection {
  background-color: ${dm.selectionBackground};
  color: ${dm.selectionText};
}`;
  });
}

features.add(import.meta.url, init, '内置暗黑模式：可调整亮度、对比度、棕褐色、灰度及配色。');
