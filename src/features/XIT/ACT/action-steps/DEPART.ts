import { act } from '@src/features/XIT/ACT/act-registry';
import { AssertFn } from '@src/features/XIT/ACT/shared-types';
import { clickElement } from '@src/utils/dom';
import { sleep } from '@src/utils/sleep';
import { getEntityNaturalIdFromAddress } from '@src/infrastructure/prun-api/data/addresses';
import { getSliderValue } from '@src/infrastructure/prun-ui/utils/set-slider-value';
import { shipsStore } from '@src/infrastructure/prun-api/data/ships';
import { getFtcFuelSlider } from '@src/features/XIT/FTC/ftc-fuel-settings';
import { waitForFtcCompute } from '@src/features/XIT/FTC/ftc-compute';

interface Data {
  registration: string;
}

// 「开始」按钮就绪的超时（毫秒）。
const BUTTON_TIMEOUT = 15_000;
// FTC 最优燃料滑块应用等待的超时（毫秒）。
const FTC_SLIDER_TIMEOUT = 10_000;

function poll<T>(get: () => T | undefined, ms: number): Promise<T | undefined> {
  return new Promise(resolve => {
    const deadline = Date.now() + ms;
    const tick = async () => {
      const value = get();
      if (value !== undefined && value !== null) {
        resolve(value);
        return;
      }
      if (Date.now() > deadline) {
        resolve(undefined);
        return;
      }
      await sleep(200);
      void tick();
    };
    void tick();
  });
}

// 等 SFC 指令表单的「开始」按钮渲染并启用（目的地+燃料计算就绪后才会启用）。
function waitForStartButton(tile: PrunTile) {
  return poll(() => {
    const command = _$(tile.anchor, C.FormComponent.containerCommand);
    const button = command ? _$(command, C.Button.success) : undefined;
    if (!button || button.classList.contains(C.Button.disabled)) {
      return undefined;
    }
    return button as HTMLElement;
  }, BUTTON_TIMEOUT);
}

// 找 SFC 面板指定标签的滑块（与 sfc-auto-fuel-settings 的 getSliderLabel 一致）。
function findSliderByLabel(tile: PrunTile, label: string): Element | undefined {
  for (const slider of _$$(tile.anchor, 'rc-slider')) {
    const row = slider.closest(
      `.${C.FormComponent.containerActive}, .${C.FormComponent.containerPassive}`,
    );
    const text = row ? _$(row, 'label')?.textContent?.trim() : undefined;
    if (text === label) {
      return slider;
    }
  }
  return undefined;
}

// 读 SFC 表单「使用跃迁点」单选当前状态（与 sfc-auto-fuel-settings 的 readGatewayState
// 同一口径）。为什么需要：FTC 参数按**航线**键控（船 + 起终点 + 网关标志），同一对起终点
// 的直飞与网关是两条航线 —— 读错标志就会查不到值、误报「未在限定时间内应用」。
// 该 DOM 读取只有 5 行，重复一份比把 basic 特性（含 features.add 副作用）引进 ACT 步骤更划算。
function readGatewayState(tile: PrunTile): boolean {
  for (const radio of _$$(tile.anchor, C.RadioItem.container)) {
    const value = _$(radio, C.RadioItem.value);
    if (value?.textContent?.trim() !== '使用跃迁点') {
      continue;
    }
    const indicator = _$(radio, C.RadioItem.indicator);
    return indicator?.classList.contains(C.RadioItem.active) ?? false;
  }
  return false;
}

// 等 FTC 最优燃料滑块应用到 SFC 面板（SFC 自动联动计算后写入滑块值）。
// 按**航线**读各自的最优参数：多船环线同时出发时各自面板等自己航线的值；同一艘船换了
// 目的地时也不会被上一条航线的值误导而带错燃料起飞。
function waitForFtcFuelSlider(
  tile: PrunTile,
  registration: string,
  from: string,
  to: string,
  useGateway: boolean,
): Promise<boolean> {
  const target = getFtcFuelSlider(registration, from, to, useGateway);
  if (target === undefined) {
    return Promise.resolve(false);
  }
  return poll(() => {
    const slider = findSliderByLabel(tile, '燃料消耗');
    const value = slider ? getSliderValue(slider) : undefined;
    if (value !== undefined && Math.abs(value - target) < 0.01) {
      return true;
    }
    return undefined;
  }, FTC_SLIDER_TIMEOUT).then(x => x === true);
}

export const DEPART = act.addActionStep<Data>({
  type: 'DEPART',
  description: data => `自动出发 ${data.registration}`,
  execute: async ctx => {
    const { data, log, setStatus, complete, fail, waitActionFeedback } = ctx;
    const assert: AssertFn = ctx.assert;
    const { registration } = data;

    setStatus(`正在为 ${registration} 自动出发...`);
    // 前一步 OPEN SFC 已打开该飞船的航行控制面板。
    const tile = tiles.find(`SFC ${registration}`, true).at(0);
    assert(tile, `未找到 ${registration} 的航行控制面板`);

    // 每段飞行前先等 FTC 最优方案计算完成并应用到 SFC（SFC 自动联动后台触发
    // computeFtcPlan，browse=false 不开窗）。确保用最优燃料出发；未计算/超时则沿用当前设置。
    const ship = shipsStore.getByRegistration(registration);
    const from = ship?.address ? getEntityNaturalIdFromAddress(ship.address) : undefined;
    const to = (
      _$(tile.anchor, C.AddressSelector.input) as HTMLInputElement | undefined
    )?.value?.trim();
    if (from !== undefined && to) {
      // 「使用跃迁点」单选状态：FTC 参数按航线键控（键里带网关标志），等待计算完成与
      // 之后读滑块值必须用同一个标志，否则会把另一次计算（另一条航线）当成本次结果。
      const useGateway = readGatewayState(tile);
      const computed = await waitForFtcCompute(registration, from, to, useGateway, 8000);
      if (computed === 'ok') {
        const applied = await waitForFtcFuelSlider(tile, registration, from, to, useGateway);
        if (applied) {
          log.info('已应用 FTC 最优燃料方案');
        } else {
          log.warning('FTC 最优燃料滑块未在限定时间内应用，沿用当前设置');
        }
      } else if (computed === 'incomplete') {
        // 输入残缺（缺起终点轨道数据/罐容量）：FTC 未写参数，立即沿用当前设置。
        // 取舍：这里不再等满 8s 超时（属改进，减少无谓等待）；代价是与 SFC 自动联动
        // 并行时可能读到更旧的滑块值 —— 但残缺输入下联动本就不写滑块，等待也没有
        // 任何可能变好的结果。
        log.warning('FTC 输入不完整（缺轨道/罐容量数据），沿用当前燃料设置');
      } else {
        log.warning('FTC 最优燃油计算超时，沿用当前燃料设置');
      }
    }

    const button = await waitForStartButton(tile);
    if (!button) {
      fail(`「开始」按钮未在限定时间内就绪`);
      return;
    }
    log.info(`点击「开始」...`);
    await clickElement(button);
    // 点击后游戏弹出「需要确认」覆盖层，需再点一次「开始」才能实际出发。
    await waitActionFeedback(tile);
    complete();
  },
});
