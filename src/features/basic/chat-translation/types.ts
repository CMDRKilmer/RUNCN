export interface TranslationRequest {
  text: string;
  targetLanguage: string;
}

export interface TranslationResult {
  translatedText: string;
  detectedSourceLanguage?: string;
}

export interface TranslationProvider {
  readonly id: UserData.TranslationProviderId;
  readonly name: string;
  readonly requiresApiKey: boolean;
  translate(
    request: TranslationRequest,
    settings: UserData.TranslationSettings,
  ): Promise<TranslationResult>;
}

export class TranslationError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean = true,
  ) {
    super(message);
    this.name = 'TranslationError';
  }
}
