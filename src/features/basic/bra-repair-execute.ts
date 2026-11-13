// 按建筑类型批量维修的执行函数：开一个隐藏的 BBL 缓冲窗，逐栋点游戏原生的「维修」按钮。
// 可修 / 缺料的判定完全交给游戏，插件不复制维修公式。
//
// 与 bra-repair-by-type.vue 的 repairType 不同：这里不读 BRA 面板的「状况阈值」滑块，
// 也不做二次确认（调用方应已通过自己的 UI 表达明确意图，例如 REPD 明细里勾选的类型）。
// 只吃 siteId + tickers，便于在非 BRA 命令窗口（如 XIT REPD）里复用同一套逐栋维修能力。

import { ref } from 'vue';
import { isRepairableBuilding } from '@src/core/buildings';
import { sitesStore } from '@src/infrastructure/prun-api/data/sites';
import { showBuffer } from '@src/infrastructure/prun-ui/buffers';
import { clickElement } from '@src/utils/dom';
import { sleep } from '@src/utils/sleep';

export interface RepairByTypeResult {
  clicked: number;
  message: string;
}

function isRepairDisabled(button: Element): boolean {
  return button.classList.contains(C.Button.disabled) || /__disabled/i.test(button.className);
}

/** 等隐藏的 BBL 把建筑列表渲染出来。 */
async function waitForRows(win: Element): Promise<void> {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (win.querySelector(`.${C.SectionList.section}`)) {
      return;
    }
    await sleep(200);
  }
}

/**
 * 对指定基地按建筑类型批量维修。
 * @param siteId 基地 siteId
 * @param tickers 要维修的建筑类型集合（reactorTicker）；空集合直接返回
 */
export async function repairBuildingsByType(
  siteId: string,
  tickers: ReadonlySet<string>,
): Promise<RepairByTypeResult> {
  const site = sitesStore.getById(siteId);
  if (!site) {
    return { clicked: 0, message: '未识别到基地，无法维修' };
  }
  if (tickers.size === 0) {
    return { clicked: 0, message: '没有勾选要维修的建筑类型' };
  }
  const targets = site.platforms
    .filter(p => isRepairableBuilding(p) && tickers.has(p.module.reactorTicker))
    .map(p => p.id);
  if (targets.length === 0) {
    return { clicked: 0, message: '所选类型下没有可维修的建筑' };
  }
  const closed = ref(false);
  let clicked = 0;
  try {
    const win = await showBuffer(`BBL ${siteId}`, {
      force: true,
      autoClose: true,
      closeWhen: closed,
    });
    await waitForRows(win);
    for (const id of targets) {
      const row = win.querySelector(`.${C.SectionList.section}[data-prun-id="${id}"]`);
      const button = row?.querySelector(`.${C.SectionList.button} > button`);
      if (!button || isRepairDisabled(button)) {
        continue;
      }
      await clickElement(button as HTMLElement);
      clicked++;
      // 逐栋下发，避免同一帧连发 SITE_SECTION_REPAIR。
      await sleep(220);
    }
  } finally {
    // 关掉隐藏的 BBL。
    closed.value = true;
  }
  return {
    clicked,
    message: clicked > 0 ? `已提交 ${clicked} 栋维修` : '游戏维修按钮不可用：基地仓库缺维修材料',
  };
}
