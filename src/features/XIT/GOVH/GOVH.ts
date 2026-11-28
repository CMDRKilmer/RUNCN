import GOVH from '@src/features/XIT/GOVH/GOVH.vue';

xit.add({
  command: 'GOVH',
  name: '政府基建助手',
  description:
    '两个页签：「基建补给助手」按六类需求 × 五类人口反算达到 100% 满足度所需的基建补给物料（本地实时价格下的贪心近似，非严格全局最优），扣除政府基建「下一次消耗 + 储备」内部存量后给出待补量；「基建建造计算」按 oog 口径从 0 级起算行星项目、基础设施建筑与仓库升级所需的全部物料。两者都可联动 XIT CBUY 比价采购。数据全部来自游戏本地 POPR / POPI / POPID 窗口与实时订单簿，零外部请求。',
  optionalParameters: '星球编码，例如 XIT GOVH VH-192b；留空则自动列出我作为管理者的政府供选择',
  component: () => GOVH,
  bufferSize: [900, 620],
});
