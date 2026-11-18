// 网关运行时加载（src/features/XIT/FTC/gateway-loader.ts）在 Node 下的测试替身。
//
// 替换：routesStore（网关连接数可控）、sendServerMessage（记录发出的请求；可模拟 socket
// 未就绪）、companyContextId、sleep（立即返回）、vue（computed）。
//
// showBuffer 也保留映射：模块目前**不**开窗口（ToS 要求玩家点击才可通信，隐藏 buffer 例外
// 不得扩展），这里记录窗口命令是为了让 verify-gateway-loader.mjs 能断言「一个窗口都没开」；
// 若将来有人把 showBuffer 重新引入该模块，对应断言会立刻失败。

export const state = {
  connectionCount: 0,
  // 模拟「请求发出后服务器回包」：每次成功发请求就把 connectionCount 加到 1。
  deliverOnRequest: false,
  // socket 是否就绪（false → requestGatewayData 返回 false）。
  socketReady: true,
};

export const buffers = [];
export const requests = [];

export function stubReset() {
  state.connectionCount = 0;
  state.deliverOnRequest = false;
  state.socketReady = true;
  buffers.length = 0;
  requests.length = 0;
}

export const routesStore = {
  get gatewayConnectionCount() {
    return state.connectionCount;
  },
};

export const sendServerMessage = message => {
  if (!state.socketReady) {
    return false;
  }
  requests.push(message);
  if (state.deliverOnRequest) {
    state.connectionCount = 1;
  }
  return true;
};

export const companyContextId = { value: 'ctx-test' };

export const showBuffer = (command, options) => {
  buffers.push({ command, options });
  return Promise.resolve();
};

export const sleep = () => Promise.resolve();

export const computed = fn => ({
  get value() {
    return fn();
  },
});
