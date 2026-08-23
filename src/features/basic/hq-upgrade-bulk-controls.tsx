import { clickElement } from '@src/utils/dom';
import { refAnimationFrame } from '@src/utils/reactive-dom';
import PrunButton from '@src/components/PrunButton.vue';

function onTileReady(tile: PrunTile) {
  // Wait for sliders to appear, then find the nearby button to anchor to
  subscribe($$(tile.anchor, 'rc-slider'), async () => {
    // Only set up once per tile
    if (_$(tile.anchor, C.Button.primary)) {
      return;
    }

    const btn = _$(tile.anchor, C.Button.btn);
    if (!btn) {
      return;
    }

    const maxSliders = async () => {
      const sliders = Array.from(tile.anchor.getElementsByClassName('rc-slider')) as HTMLElement[];
      for (const slider of sliders) {
        if (slider.classList.contains('rc-slider-disabled')) {
          continue;
        }
        const mark = slider.getElementsByClassName('rc-slider-mark')[0] as HTMLElement | undefined;
        if (!mark?.lastElementChild) {
          continue;
        }
        await clickElement(mark.lastElementChild as HTMLElement);
      }
    };

    const minSliders = async () => {
      const sliders = Array.from(tile.anchor.getElementsByClassName('rc-slider')) as HTMLElement[];
      for (const slider of sliders) {
        if (slider.classList.contains('rc-slider-disabled')) {
          continue;
        }
        const mark = slider.getElementsByClassName('rc-slider-mark')[0] as HTMLElement | undefined;
        if (!mark?.firstElementChild) {
          continue;
        }
        await clickElement(mark.firstElementChild as HTMLElement);
      }
    };

    const allSliders = tile.anchor.getElementsByClassName('rc-slider');
    const disabledSliders = tile.anchor.getElementsByClassName('rc-slider-disabled');
    const disabled = refAnimationFrame(
      tile.anchor,
      () => allSliders.length > 0 && allSliders.length === disabledSliders.length,
    );

    createFragmentApp(() => (
      <PrunButton primary disabled={disabled.value} onClick={maxSliders}>
        ALL
      </PrunButton>
    )).before(btn);
    createFragmentApp(() => (
      <PrunButton primary disabled={disabled.value} onClick={minSliders}>
        NONE
      </PrunButton>
    )).before(btn);
  });
}

function init() {
  tiles.observe('HQ', onTileReady);
}

features.add(import.meta.url, init, 'HQ：在总部升级分配面板中添加 NONE/ALL 批量控制按钮。');
