import { createOpenAiCompatProvider } from './llm-openai-compat';

// All providers below speak the OpenAI-compatible chat completions protocol.
// Defaults (URL + model) can be overridden per-user via providerConfigs[id].apiUrl / .apiModel.

export const deepseekProvider = createOpenAiCompatProvider({
  id: 'DEEPSEEK',
  name: 'DeepSeek',
  defaultUrl: 'https://api.deepseek.com/v1/chat/completions',
  defaultModel: 'deepseek-v4-flash',
});

export const minimaxProvider = createOpenAiCompatProvider({
  id: 'MINIMAX',
  name: 'MiniMax',
  defaultUrl: 'https://api.minimaxi.com/v1/text/chatcompletion_v2',
  defaultModel: 'abab6.5-chat',
});

export const zhipuProvider = createOpenAiCompatProvider({
  id: 'ZHIPU',
  name: '智谱 GLM',
  defaultUrl: 'https://open.bigmodel.cn/api/paas/v4/chat/completions',
  defaultModel: 'glm-4.7-flash',
});

export const qwenProvider = createOpenAiCompatProvider({
  id: 'QWEN',
  name: '通义千问',
  defaultUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions',
  defaultModel: 'qwen-flash-2025-07-28',
});

export const moonshotProvider = createOpenAiCompatProvider({
  id: 'MOONSHOT',
  name: 'Moonshot Kimi',
  defaultUrl: 'https://api.moonshot.cn/v1/chat/completions',
  defaultModel: 'kimi-latest',
});

export const ernieProvider = createOpenAiCompatProvider({
  id: 'ERNIE',
  name: '百度千帆',
  defaultUrl: 'https://qianfan.baidubce.com/v2/chat/completions',
  defaultModel: 'ernie-5.0',
});

export const hunyuanProvider = createOpenAiCompatProvider({
  id: 'HUNYUAN',
  name: '腾讯混元',
  defaultUrl: 'https://api.hunyuan.cloud.tencent.com/v1/chat/completions',
  defaultModel: 'hunyuan-2.0-instruct',
});

export const lingyiProvider = createOpenAiCompatProvider({
  id: 'LINGYI',
  name: '零一万物',
  defaultUrl: 'https://api.lingyiwanwu.com/v1/chat/completions',
  defaultModel: 'yi-lightning',
});

export const stepfunProvider = createOpenAiCompatProvider({
  id: 'STEPFUN',
  name: '阶跃星辰',
  defaultUrl: 'https://api.stepfun.com/v1/chat/completions',
  defaultModel: 'step-3.5-flash',
});

export const openaiLlmProvider = createOpenAiCompatProvider({
  id: 'OPENAI_LLM',
  name: 'OpenAI (GPT)',
  defaultUrl: 'https://api.openai.com/v1/chat/completions',
  defaultModel: 'gpt-4.1-mini',
});
