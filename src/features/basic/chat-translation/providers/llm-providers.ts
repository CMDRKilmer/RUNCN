import { createOpenAiCompatProvider } from './llm-openai-compat';

// All providers below speak the OpenAI-compatible chat completions protocol.
// Defaults (URL + model) can be overridden per-user via providerConfigs[id].apiUrl / .apiModel.

export const deepseekProvider = createOpenAiCompatProvider({
  id: 'DEEPSEEK',
  name: 'DeepSeek',
  defaultUrl: 'https://api.deepseek.com/v1/chat/completions',
  defaultModel: 'deepseek-chat',
});

export const minimaxProvider = createOpenAiCompatProvider({
  id: 'MINIMAX',
  name: 'MiniMax',
  defaultUrl: 'https://api.minimaxi.com/v1/text/chatcompletion_v2',
  defaultModel: 'abab6.5s-chat',
});

export const zhipuProvider = createOpenAiCompatProvider({
  id: 'ZHIPU',
  name: '智谱 GLM',
  defaultUrl: 'https://open.bigmodel.cn/api/paas/v4/chat/completions',
  defaultModel: 'glm-4-flash',
});

export const qwenProvider = createOpenAiCompatProvider({
  id: 'QWEN',
  name: '通义千问',
  defaultUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions',
  defaultModel: 'qwen-turbo',
});

export const moonshotProvider = createOpenAiCompatProvider({
  id: 'MOONSHOT',
  name: 'Moonshot Kimi',
  defaultUrl: 'https://api.moonshot.cn/v1/chat/completions',
  defaultModel: 'moonshot-v1-8k',
});

export const ernieProvider = createOpenAiCompatProvider({
  id: 'ERNIE',
  name: '百度千帆',
  defaultUrl: 'https://qianfan.baidubce.com/v2/chat/completions',
  defaultModel: 'ernie-speed-8k',
});

export const hunyuanProvider = createOpenAiCompatProvider({
  id: 'HUNYUAN',
  name: '腾讯混元',
  defaultUrl: 'https://api.hunyuan.cloud.tencent.com/v1/chat/completions',
  defaultModel: 'hunyuan-turbos-latest',
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
  defaultModel: 'step-1-flash',
});

export const openaiLlmProvider = createOpenAiCompatProvider({
  id: 'OPENAI_LLM',
  name: 'OpenAI (GPT)',
  defaultUrl: 'https://api.openai.com/v1/chat/completions',
  defaultModel: 'gpt-4o-mini',
});
