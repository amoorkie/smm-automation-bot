import {
  buildOpenRouterImagePayload,
  buildOpenRouterTextPayload,
  parseOpenRouterImageResponse,
  parseOpenRouterTextResponse,
} from '../domain/index.mjs';
import { isRetryableHttpError, withRetry, withTimeout } from './resilience.mjs';

export class OpenRouterService {
  constructor({ apiKey, textModelId, imageModelId }) {
    this.apiKey = apiKey;
    this.textModelId = textModelId;
    this.imageModelId = imageModelId;
  }

  async request(body) {
    return withRetry(async () => {
      const response = await withTimeout(
        (signal) => fetch('https://openrouter.ai/api/v1/chat/completions', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${this.apiKey}`,
          },
          body: JSON.stringify(body),
          signal,
        }),
        45_000,
        'OpenRouter request timed out',
      );

      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(`OpenRouter error ${response.status}: ${JSON.stringify(data)}`);
      }
      return data;
    }, {
      retries: 2,
      delayMs: 500,
      shouldRetry: isRetryableHttpError,
    });
  }

  async generateText({
    systemPrompt = '',
    userPrompt,
    imageUrls = [],
    temperature = 0.7,
    model = this.textModelId,
    metadata = {},
  }) {
    const payload = buildOpenRouterTextPayload({
      model,
      systemPrompt,
      userPrompt,
      imageUrls,
      temperature,
      metadata,
    });
    const data = await this.request(payload);
    return parseOpenRouterTextResponse(data);
  }

  async generateImages({
    prompt,
    imageUrls = [],
    imageConfig = {},
    model = this.imageModelId,
    metadata = {},
  }) {
    const payload = buildOpenRouterImagePayload({
      model,
      prompt,
      imageUrls,
      imageConfig,
      metadata,
    });
    const data = await this.request(payload);
    return parseOpenRouterImageResponse(data);
  }
}

export default OpenRouterService;
