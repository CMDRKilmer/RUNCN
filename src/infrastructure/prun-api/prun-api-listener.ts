import socketIOMiddleware, { Middleware } from './socket-io-middleware';
import { dispatch, dispatchForce } from '@src/infrastructure/prun-api/data/api-messages';
import { companyContextId } from '@src/infrastructure/prun-api/data/user-data';
import { startMeasure, stopMeasure } from '@src/utils/performance-measure';
import { context } from '@src/infrastructure/prun-api/data/screens';
import { watchUntil } from '@src/utils/watch';

interface Message {
  messageType?: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  payload?: { message: Message } | any;
}

export const initialApiLoadingComplete = ref(false);

const middleware: Middleware<Message> = {
  onOpen: function () {
    const storeAction = {
      type: 'CLIENT_CONNECTION_OPENED',
      data: undefined,
    };
    dispatch(storeAction);
  },
  onMessage: async message => {
    // 强制通道：无条件分发解包后的响应（绕过下方上下文检查），
    // 确保插件主动请求（STL 采集等）在任意上下文都能收到服务器响应。
    dispatchAlways(message);
    if (context.value === companyContextId.value || !companyContextId.value || !context.value) {
      return (await processEvent(message)) ?? false;
    }
    return false;
  },
  dispatchClientMessage: ref(undefined),
};

// 把消息（ACTION_COMPLETED 解包后）分发给强制通道。
function dispatchAlways(message: Message | undefined) {
  if (!message || !message.messageType) {
    return;
  }
  if (message.messageType === 'ACTION_COMPLETED') {
    const inner = message.payload?.message as Message | undefined;
    if (inner?.messageType) {
      dispatchForce({ type: inner.messageType, data: inner.payload });
    }
    return;
  }
  dispatchForce({ type: message.messageType, data: message.payload });
}

export function listenPrunApi() {
  socketIOMiddleware<Message>(middleware);
}

export const isRecordingPrunLog = ref(false);
export const prunLog = ref([] as Message[]);

async function processEvent(message: Message | undefined) {
  if (!message || !message.messageType || !message.payload) {
    return;
  }

  startMeasure(message.messageType);

  try {
    if (message.messageType === 'ACTION_COMPLETED') {
      return processEvent(message.payload.message);
    } else {
      if (isRecordingPrunLog.value) {
        prunLog.value.push(message);
      }
      const storeAction = {
        type: message.messageType,
        data: message.payload,
      };
      const result = dispatch(storeAction);
      // 阻止 COMPANY_DATA 消息直到初始加载完成，
      // 这样 refined prun 可以在基础游戏之前加载。
      if (message.messageType === 'COMPANY_DATA' && !initialApiLoadingComplete.value) {
        await watchUntil(() => initialApiLoadingComplete.value);
      }
      return result;
    }
  } finally {
    stopMeasure();
  }
}

export const canDispatchClientPrunMessage = computed(
  () => !!middleware.dispatchClientMessage.value,
);

export function dispatchClientPrunMessage(message: Message) {
  if (!middleware.dispatchClientMessage.value) {
    return false;
  }
  middleware.dispatchClientMessage.value(message);
  return true;
}
