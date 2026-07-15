import { userData } from '@src/store/user-data';

// 媒体元素二次反转，使图片/视频等恢复正常显示（抵消 html 上的 invert）。
const mediaSelector = 'img, picture, video, iframe, canvas, svg';

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
    // invert + hue-rotate(180deg) 是反色模式的核心：
    // invert 反转明暗，hue-rotate 保持色相关系自然。
    const filter = [
      'invert(1)',
      'hue-rotate(180deg)',
      `brightness(${dm.brightness / 100})`,
      `contrast(${dm.contrast / 100})`,
      `sepia(${dm.sepia / 100})`,
      `grayscale(${dm.grayscale / 100})`,
    ].join(' ');
    style.textContent = `
html {
  filter: ${filter};
}
${mediaSelector} {
  filter: invert(1) hue-rotate(180deg);
}`;
  });
}

features.add(
  import.meta.url,
  init,
  '内置反色模式：反色显示整个界面，可调整亮度、对比度、棕褐色、灰度。',
);
