// agent-query stub — 当前无 nativeWebSocket 实现，连接功能禁用。
// 真实实现需独立 PR 适配 RUNCN WebSocket API（@src/infrastructure/prun-api/native-websocket）。
import { ref, type Ref } from 'vue';

export type AgentConnectionStatus =
  'disconnected' | 'connecting' | 'authenticating' | 'connected' | 'error';

interface AgentQueryConnectionStub {
  readonly status: Ref<AgentConnectionStatus>;
  readonly lastError: Ref<string | undefined>;
  connect(_endpoint: string, _token: string): void;
  disconnect(): void;
}

export const agentQueryConnection: AgentQueryConnectionStub = {
  status: ref<AgentConnectionStatus>('disconnected'),
  lastError: ref<string | undefined>(undefined),
  connect() {
    /* no-op: WebSocket support pending */
  },
  disconnect() {
    /* no-op */
  },
};
