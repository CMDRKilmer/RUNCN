// transit-f-scan.ts 的浏览器侧依赖替身（Node 回归用）。
// 只提供该模块顶层会引用到的名字；快照提取本身是纯函数，不碰这些。
export const calculateTestFlight = () => Promise.resolve(undefined);
export const blueprintsStore = {
  request() {},
  fetched: { value: false },
  all: { value: [] },
  getByNaturalId: () => undefined,
};
export const shipsStore = { all: { value: [] } };
export const sendServerMessage = () => false;
export const companyContextId = { value: '' };
export const sleep = () => Promise.resolve();
export const watchUntil = () => Promise.resolve();
