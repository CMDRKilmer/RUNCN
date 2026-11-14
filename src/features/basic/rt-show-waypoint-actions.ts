import $style from './rt-show-waypoint-actions.module.css';

function init() {
  if (C.Waypoint?.commandsSteps === undefined) {
    return;
  }
  applyCssRule('RT', `.${C.Waypoint.waypoint} .${C.Waypoint.commandsSteps}`, $style.commands);
}

features.add(import.meta.url, init, 'RT：始终显示航点步骤按钮。');
