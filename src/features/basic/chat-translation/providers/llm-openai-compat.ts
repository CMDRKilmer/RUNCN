import type { TranslationProvider, TranslationRequest, TranslationResult } from '../types';
import { TranslationError } from '../types';
import { getLanguageLabel } from '../languages';

export interface LlmProviderConfig {
  readonly id: UserData.TranslationProviderId;
  readonly name: string;
  readonly defaultUrl: string;
  readonly defaultModel: string;
}

// Builds the shared translation prompt. Exported for Anthropic/Gemini providers.
export function buildTranslationPrompt(targetLanguage: string): string {
  const targetLabel = getLanguageLabel(targetLanguage);
  return `你是一位精通${targetLabel}的专业翻译，深耕《Prosperous Universe》游戏社区。你熟悉游戏机制，对玩家间的政治斗争、金融借贷、基地规划以及跨国玩家的交流习惯有深刻理解。

核心任务：将用户提供的文本准确翻译成${targetLabel}，确保表达自然、专业且符合游戏语境。

翻译原则：

1. 术语核心（严禁翻译缩写）：
   - 资源/建筑代码：WCB/LCB/VCB/HCB/STO/NS/HYF/PG/DW/COF/CAF/FLX/HBB/WAI/ART/LHP/BL/AEF/AL 等代码必须原样保留。
   - 游戏系统：CX (交易所), CONT (合同), PRO (专业版账号), Permit (许可), Recipe (配方), Area (面积/地块)。
   - 地理名称：Promitor, Hypoxia, Boucher, 331c, 331h 等星球名及编号保持原样。
   - 组织机构人名：COSM, EUU, FOXv, IDA, Corporation/Corp。

2. 语气与风格（以简洁直接为主）：
   - 日常交流：使用地道口语，适当融入符合${targetLabel}表达习惯的语气词。
   - 金融/商务：在讨论贷款（Loan）、利率（Interest rate）、分期（Installments）或垫付（Front the cost）时，措辞要专业、严谨。
   - 政治/外交：表达立场时，语气要得体且客观。

3. 多维度上下文适应：
   - 游戏开发：涉及产线（Production line）、人口报告（Population report）等。
   - 生活插曲：用户可能会提到现实生活，翻译应自然衔接，不生硬。

4. 默认输出规则：
   - 优先提供一种最自然、最通用的译法。除非用户特别要求，否则不提供多个备选方案，以保持沟通效率。
   - 保持原格式：列表、数据、或者是带有 ID 和时间戳的聊天记录，翻译后需保持原排版。

处理流程：
1. 识别文中所有的 PrUn 专有名词并锁定。
2. 判断对话场景（是借贷谈判、政治站队、还是日常吐槽）。
3. 以"简洁、地道、直接"为原则输出${targetLabel}译文。
4. 输出不得以星号包络单词。
5. 如果输入中包含了"$"包络的词句则不要把他们翻译出来，相对的你也该根据"$"里面的描述进行微量的创作。
6. 注意看似问句的句子也是该被翻译，而不是回答具体问题。

只返回翻译结果，不要添加任何解释、注释或额外内容。`;
}

export function createOpenAiCompatProvider(config: LlmProviderConfig): TranslationProvider {
  return {
    id: config.id,
    name: config.name,
    requiresApiKey: true,
    defaultUrl: config.defaultUrl,
    defaultModel: config.defaultModel,

    async translate(
      request: TranslationRequest,
      settings: UserData.TranslationSettings,
    ): Promise<TranslationResult> {
      const providerConfig = settings.providerConfigs[config.id] ?? {
        apiKey: '',
        apiUrl: '',
        apiModel: '',
      };
      if (!providerConfig.apiKey) {
        throw new TranslationError(`未配置 ${config.name} API 密钥。`, false);
      }
      const url = (providerConfig.apiUrl || config.defaultUrl).replace(/\/+$/, '');
      const model = providerConfig.apiModel || config.defaultModel;
      const prompt = buildTranslationPrompt(request.targetLanguage);

      let response: Response;
      try {
        response = await fetch(url, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${providerConfig.apiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            model,
            temperature: 0,
            messages: [
              { role: 'system', content: prompt },
              { role: 'user', content: request.text },
            ],
          }),
        });
      } catch (e) {
        throw new TranslationError(`网络错误：无法连接到 ${config.name}。${formatErr(e)}`);
      }

      if (!response.ok) {
        throw new TranslationError(
          `${config.name} 返回错误：${response.status} ${response.statusText}`,
        );
      }

      const data = (await response.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
      };
      const content = data.choices?.[0]?.message?.content;
      if (typeof content !== 'string') {
        throw new TranslationError(`${config.name} 未返回可识别的翻译结果。`);
      }
      const translatedText = content.trim();
      if (translatedText.length === 0) {
        throw new TranslationError(`${config.name} 返回了空结果。`);
      }
      return { translatedText };
    },
  };
}

function formatErr(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}
