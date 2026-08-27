interface Message {
  type: string;
  data?: unknown;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type MessageHandler = (data: any) => void | boolean;

type MessageHandlers = { [type: string]: MessageHandler };

const any: MessageHandler[] = [];
const registry = new Map<string, MessageHandler[]>();
// 强制通道：与正常通道独立，总是被触发（不经过 prun-api-listener 的上下文
// 检查），供插件主动请求（如 STL 采集的 NOMENCLATURE/SHIP_FLIGHT 响应）在
// 任意游戏上下文都能收到服务器响应。
const forceRegistry = new Map<string, MessageHandler[]>();

export function onAnyApiMessage(handler: MessageHandler) {
  any.push(handler);
}

export function onApiMessage(handlers: MessageHandlers) {
  for (const type in handlers) {
    let list = registry.get(type);
    if (!list) {
      list = [];
      registry.set(type, list);
    }
    list.push(handlers[type]);
  }
}

export function onApiMessageForce(handlers: MessageHandlers) {
  for (const type in handlers) {
    let list = forceRegistry.get(type);
    if (!list) {
      list = [];
      forceRegistry.set(type, list);
    }
    list.push(handlers[type]);
  }
}

export function dispatch(message: Message) {
  let changed = false;
  for (const handler of any) {
    const result = handler(message);
    if (result) {
      changed = true;
    }
  }
  const handlers = registry.get(message.type);
  if (handlers) {
    for (const handler of handlers) {
      const result = handler(message.data);
      if (result) {
        changed = true;
      }
    }
  }
  return changed;
}

export function dispatchForce(message: Message) {
  let changed = false;
  const handlers = forceRegistry.get(message.type);
  if (handlers) {
    for (const handler of handlers) {
      const result = handler(message.data);
      if (result) {
        changed = true;
      }
    }
  }
  return changed;
}
