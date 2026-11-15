import GOVH from '@src/features/XIT/GOVH/GOVH.vue';

xit.add({
  command: 'GOVH',
  name: '政府基建补给助手',
  description:
    '按六类需求 × 五类人口反算达到 100% 满足度所需的基建补给物料（本地实时价格下的贪心近似，非严格全局最优），扣除政府基建「下一次消耗 + 储备」内部存量后给出待补量，列出全部物料自选并联动 XIT CBUY 比价采购。数据全部来自游戏本地 POPR / POPI / POPID 窗口与实时订单簿，零外部请求。',
  optionalParameters: '星球编码，例如 XIT GOVH VH-192b；留空则自动列出我作为管理者的政府供选择',
  component: () => GOVH,
  bufferSize: [900, 620],
});
