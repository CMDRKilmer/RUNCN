import { act } from '@src/features/XIT/ACT/act-registry';
import { clickElement } from '@src/util';
import { sleep } from '@src/utils/sleep';

interface Data {
  base: string;
  threshold: number;
}

// 维护按钮等待材料到位的超时时间。
const REPAIR_BUTTON_TIMEOUT = 15000;

// 建筑条目文本形如「INC100%」，提取状况百分比数值。
function parseCondition(building: Element) {
  const match = building.textContent?.match(/(\d+(?:\.\d+)?)\s*%/);
  return match ? Number(match[1]) : undefined;
}

export const BRA_REPAIR = act.addActionStep<Data>({
  type: 'BRA_REPAIR',
  description: data => `提交 ${data.base} 的建筑维修（状况低于 ${data.threshold}%）`,
  execute: async ctx => {
    const {
      data,
      log,
      setStatus,
      requestTile,
      waitActionFeedback,
      complete,
      skip,
      fail,
      isCancelled,
    } = ctx;

    const tile = await requestTile(`BRA ${data.base}`, true);
    if (!tile) {
      return;
    }

    setStatus('正在加载建筑列表...');
    const buildingList = await $(tile.anchor, C.BuildingRepairAssistantPanel.buildingList);

    // 勾选所有状况低于阈值的建筑（点击建筑图标即选中）。
    const buildings = _$$(buildingList, C.BuildingRepairAssistantPanel.building);
    let selected = 0;
    for (const building of buildings) {
      if (isCancelled()) {
        return;
      }
      const condition = parseCondition(building);
      if (condition === undefined || condition >= data.threshold) {
        continue;
      }
      const icon = _$(building, C.BuildingIcon.container);
      if (!icon) {
        continue;
      }
      await clickElement(icon as HTMLElement);
      selected++;
    }

    if (selected === 0) {
      log.skip(`${data.base} 没有状况低于 ${data.threshold}% 的建筑`);
      skip();
      return;
    }

    // 「维护」按钮是面板中的第一个按钮；材料不足时禁用。
    // 材料通常由同包前置的 MTRA 转移提供，轮询等待按钮变为可用。
    const repairBtn = (await $(tile.anchor, C.Button.btn)) as HTMLElement;
    setStatus(`已选中 ${selected} 栋建筑，等待材料到位...`);
    const deadline = Date.now() + REPAIR_BUTTON_TIMEOUT;
    while (repairBtn.classList.contains(C.Button.disabled)) {
      if (isCancelled()) {
        return;
      }
      if (Date.now() > deadline) {
        fail(`维护按钮不可用：材料不足或无可修建筑（${data.base}）`);
        return;
      }
      await sleep(200);
    }

    await clickElement(repairBtn);
    await waitActionFeedback(tile);
    complete();
  },
});
