import { prunCssStylesheets } from '@src/infrastructure/prun-ui/prun-css';
import $style from './prun-bugs.module.css';
import { clickElement } from '@src/util';

function removeMobileCssRules() {
  for (const style of prunCssStylesheets) {
    const styleSheet = style.sheet!;
    const rules = styleSheet.cssRules;
    try {
      for (let j = rules.length - 1; j >= 0; j--) {
        const rule = rules[j];
        if (rule instanceof CSSMediaRule && rule.media.mediaText.includes('screen')) {
          styleSheet.deleteRule(j);
        }
      }
    } catch (e) {
      console.log(`Could not modify stylesheet: ${styleSheet.href}, Error: ${e}`);
    }
  }
}

function disableInvalidPopidSliders(tile: PrunTile) {
  subscribe($$(tile.anchor, 'tr'), row => {
    subscribe($$(row, 'rc-slider'), async slider => {
      const sliderMarks = Array.from((await $(slider, 'rc-slider-mark')).children);
      const sliderMaxMark = sliderMarks[sliderMarks.length - 1];
      const sliderMax = parseFloat(sliderMaxMark.textContent);
      const sliderValueMark = sliderMarks.findLast(x =>
        x.classList.contains('rc-slider-mark-text-active'),
      );
      if (!sliderValueMark) {
        return;
      }
      const sliderValue = parseFloat(sliderValueMark.textContent);
      const reserveCell = row.children[3];
      if (reserveCell === undefined) {
        return;
      }
      const reserveBar = await $(reserveCell, 'progress');
      if (reserveBar.value - sliderValue + sliderMax > reserveBar.max) {
        // If the slider is filled, disabling it could lock it in an invalid position.
        // So, we first minimize the slider value by clicking the min mark.
        await clickElement(sliderMarks[0] as HTMLElement);
        slider.classList.add('rc-slider-disabled');
        slider.style.pointerEvents = 'none';
      }
    });
  });
}

function fixZOrder() {
  applyCssRule(
    [
      `.${C.ComExOrdersPanel.filter}`,
      `.${C.LocalMarket.filter}`,
      `.${C.ContractsListTable.filter}`,
    ],
    $style.filter,
  );
  applyCssRule(`.${C.ScrollView.track}`, $style.scrollTrack);
}

function fixSliders() {
  applyCssRule('.rc-slider-dot', $style.rcSliderDotFixes);
  applyCssRule('.rc-slider-handle', $style.rcSliderHandleFixes);
  applyCssRule('.rc-slider-step', $style.rcSliderStepFixes);
}

function preventDragSelection() {
  const noSelectClass = 'rp-no-select-drag';
  applyCssRule(`.${noSelectClass} *`, $style.noSelect);

  const queueReset = () => {
    if (!document.body.classList.contains(noSelectClass)) {
      return;
    }
    requestAnimationFrame(() => {
      document.getSelection()?.removeAllRanges();
      document.body.classList.remove(noSelectClass);
    });
  };

  document.addEventListener('dragstart', e => {
    const target = e.target as Element;
    if (target.closest('[draggable="true"]') === null) {
      return;
    }
    document.body.classList.add(noSelectClass);
  });

  document.addEventListener('dragend', queueReset);
  window.addEventListener('blur', queueReset);
}

function init() {
  removeMobileCssRules();
  fixZOrder();
  fixSliders();
  preventDragSelection();

  // 防止右上角用户信息缩小。
  applyCssRule(`.${C.Head.container}`, $style.head);

  // 项目子标签缺少 word-break。
  applyCssRule(`.${C.ColoredIcon.subLabel}`, $style.subLabel);

  // 移除 GridItemView 背景色。
  applyCssRule(`.${C.GridItemView.container}`, $style.gridItem);
  // Prevent layout shifts when items become selected by making the border consistent width.
  applyCssRule(`.${C.GridItemView.selected}`, $style.gridItemSelected);

  // 为 GridItemView 名称添加文本居中。
  applyCssRule(`.${C.GridItemView.name}`, $style.gridItemName);

  // 覆盖层会阻止材料被点击。
  applyCssRule(['PROD', 'PRODQ'], `.${C.OrderTile.overlay}`, $style.disablePointerEvents);

  // 防止 PROD 缓冲区垂直滚动条槽始终可见。
  applyCssRule('PROD', `.${C.SiteProductionLines.container}`, $style.containerScrollbarGutter);

  // GIFT 中的用户搜索结果框太大，无法适应磁贴。
  applyCssRule('GIFT', `.${C.UserSelector.suggestionsContainer}`, $style.giftSearchResults);

  // 修复系统信息中的点/箭头左偏问题
  applyCssRule(
    'SYSI',
    `.${C.EnvironmentTable.gridContainer} .${C.ColoredValue.positive}`,
    $style.centerText,
  );
  applyCssRule(
    'SYSI',
    `.${C.EnvironmentTable.gridContainer} .${C.ColoredValue.negative}`,
    $style.centerText,
  );

  // 修复工具提示箭头位置。
  applyCssRule('[data-tooltip-position="bottom"]', $style.tooltipBottom);
  applyCssRule('[data-tooltip-position="right"]', $style.tooltipRight);

  tiles.observe('POPID', disableInvalidPopidSliders);
}

features.add(import.meta.url, init, '修复 PrUn 的 bug。');
