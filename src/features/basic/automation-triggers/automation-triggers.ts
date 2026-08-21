import { triggerEngine } from './trigger-engine';

function init() {
  triggerEngine.start();
}

features.add(
  import.meta.url,
  init,
  'TRIGGER：监控游戏事件（到港/物资告急/生产完成/建筑状况/定时）触发执行操作包。',
);
