export interface TranslationRequest {
  text: string;
  targetLanguage: string;
}

export interface TranslationResult {
  translatedText: string;
  detectedSourceLanguage?: string;
  // Set when the input was longer than the safety cap and silently
  // truncated before being sent to the provider. The UI should
  // surface this so the user knows only a prefix was translated.
  truncated?: boolean;
}

export interface TranslationProvider {
  readonly id: UserData.TranslationProviderId;
  readonly name: string;
  readonly requiresApiKey: boolean;
  readonly defaultUrl?: string;
  readonly defaultModel?: string;
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
