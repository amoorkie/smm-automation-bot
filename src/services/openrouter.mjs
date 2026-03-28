import {
  buildOpenRouterImagePayload,
  buildOpenRouterTextPayload,
  parseOpenRouterImageResponse,
  parseOpenRouterTextResponse,
} from '../domain/index.mjs';
import { isRetryableHttpError, withTimeout } from './resilience.mjs';

const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class ProviderRequestError extends Error {
  constructor(providerName, status, data) {
    super(`${providerName} error ${status}: ${JSON.stringify(data)}`);
    this.name = 'ProviderRequestError';
    this.providerName = providerName;
    this.status = status;
    this.data = data;
  }
}

class ProviderEmptyResultError extends Error {
  constructor(providerName, kind, data) {
    super(`${providerName} returned no ${kind}`);
    this.name = 'ProviderEmptyResultError';
    this.providerName = providerName;
    this.kind = kind;
    this.data = data;
  }
}

function detectProvider(apiKey) {
  if (!apiKey) {
    return null;
  }
  return { name: 'openrouter', baseUrl: OPENROUTER_BASE_URL, apiKey };
}

function isCreditError(error) {
  return Number(error?.status) === 402;
}

function isRateLimitError(error) {
  return Number(error?.status) === 429
    || /temporarily rate-limited upstream|rate-?limit|429/iu.test(String(error?.message ?? ''));
}

function isFallbackEligibleProviderError(error) {
  return isCreditError(error)
    || error instanceof ProviderEmptyResultError;
}

function getOpenRouterImageProviderPolicy(model) {
  if (typeof model !== 'string') {
    return { require_parameters: true };
  }

  if (model.startsWith('google/gemini-3.1-flash-image-preview')) {
    return {
      ignore: ['google-ai-studio'],
      require_parameters: true,
    };
  }

  return { require_parameters: true };
}

function getOpenRouterImagePayloadVariants({ model, prompt, imageUrls, imageConfig, maxTokens, metadata }) {
  const preferredProvider = getOpenRouterImageProviderPolicy(model);
  const variants = [
    buildOpenRouterImagePayload({
      model,
      prompt,
      imageUrls,
      imageConfig,
      maxTokens,
      metadata,
      provider: preferredProvider,
    }),
  ];

  if (preferredProvider) {
    variants.push(
      buildOpenRouterImagePayload({
        model,
        prompt,
        imageUrls,
        imageConfig,
        maxTokens,
        metadata,
        provider: { require_parameters: true },
      }),
    );
  }

  return variants;
}

export class OpenRouterService {
  constructor({ apiKey, textModelId, imageModelId }) {
    this.primaryProvider = detectProvider(apiKey);
    this.textModelId = textModelId;
    this.imageModelId = imageModelId;
  }

  get textModelProviderName() {
    return this.getPreferredProvider()?.name ?? 'openrouter';
  }

  get imageModelProviderName() {
    return this.getPreferredProvider()?.name ?? 'openrouter';
  }

  getPreferredProvider() {
    return this.primaryProvider;
  }

  getProviderOrder() {
    return this.primaryProvider ? [this.primaryProvider] : [];
  }

  async requestJson({ provider, method = 'POST', path, body = null, timeoutMs = 45_000 }) {
    const maxRetries = provider?.name === 'openrouter' ? 2 : 2;
    let attempt = 0;
    let currentDelayMs = 500;
    while (true) {
      try {
        const response = await withTimeout(
          (signal) => fetch(`${provider.baseUrl}${path}`, {
            method,
            headers: {
              Authorization: `Bearer ${provider.apiKey}`,
              ...(body === null ? {} : { 'Content-Type': 'application/json' }),
            },
            body: body === null ? undefined : JSON.stringify(body),
            signal,
          }),
          timeoutMs,
          `${provider.name} request timed out`,
        );

        const data = await response.json().catch(() => ({}));
        if (!response.ok) {
          throw new ProviderRequestError(provider.name, response.status, data);
        }
        return data;
      } catch (error) {
        if (attempt >= maxRetries || !isRetryableHttpError(error)) {
          throw error;
        }
        const nextDelayMs = isRateLimitError(error)
          ? Math.max(currentDelayMs, 1500)
          : currentDelayMs;
        await sleep(nextDelayMs);
        currentDelayMs = nextDelayMs * 2;
        attempt += 1;
      }
    }
  }

  async executeWithFallback(runOperation) {
    const providers = this.getProviderOrder();
    let lastError = null;

    for (let index = 0; index < providers.length; index += 1) {
      const provider = providers[index];
      try {
        const result = await runOperation(provider);
        return { provider, result };
      } catch (error) {
        lastError = error;
        const isLastProvider = index === providers.length - 1;
        if (isLastProvider || !isFallbackEligibleProviderError(error)) {
          throw error;
        }
      }
    }

    throw lastError;
  }

  async requestOpenRouterText(provider, payload) {
    return this.requestJson({
      provider,
      path: '/chat/completions',
      body: payload,
    });
  }

  async requestOpenRouterImages(provider, payload) {
    return this.requestJson({
      provider,
      path: '/chat/completions',
      body: payload,
    });
  }

  async requestOpenRouterImagesWithVariants(provider, payloadVariants) {
    let lastError = null;

    for (let index = 0; index < payloadVariants.length; index += 1) {
      const payload = payloadVariants[index];
      try {
        const data = await this.requestOpenRouterImages(provider, payload);
        const parsed = parseOpenRouterImageResponse(data);
        if (!Array.isArray(parsed.images) || parsed.images.length === 0) {
          throw new ProviderEmptyResultError(provider.name, 'images', data);
        }
        return data;
      } catch (error) {
        lastError = error;
        const isLastVariant = index === payloadVariants.length - 1;
        if (isLastVariant) {
          throw error;
        }
        if (!isRateLimitError(error) && !(error instanceof ProviderEmptyResultError)) {
          throw error;
        }
      }
    }

    throw lastError;
  }

  async generateText({
    systemPrompt = '',
    userPrompt,
    imageUrls = [],
    temperature = 0.7,
    maxTokens = null,
    model = this.textModelId,
    metadata = {},
  }) {
    const payload = buildOpenRouterTextPayload({
      model,
      systemPrompt,
      userPrompt,
      imageUrls,
      temperature,
      maxTokens,
      metadata,
    });
    const startedAt = Date.now();
    const { provider, result: data } = await this.executeWithFallback(
      async (provider) => this.requestOpenRouterText(provider, payload),
    );
    const parsed = parseOpenRouterTextResponse(data);
    if (typeof parsed.text !== 'string' || !parsed.text.trim()) {
      throw new ProviderEmptyResultError(provider.name, 'text', data);
    }
    return {
      ...parsed,
      text: parsed.text.trim(),
      durationMs: Date.now() - startedAt,
    };
  }

  async generateImages({
    prompt,
    imageUrls = [],
    imageConfig = {},
    maxTokens = 128,
    model = this.imageModelId,
    metadata = {},
  }) {
    const payloadVariants = getOpenRouterImagePayloadVariants({
      model,
      prompt,
      imageUrls,
      imageConfig,
      maxTokens,
      metadata,
    });
    const startedAt = Date.now();
    const { result: data } = await this.executeWithFallback(async (provider) => {
      return this.requestOpenRouterImagesWithVariants(provider, payloadVariants);
    });
    const parsed = parseOpenRouterImageResponse(data);
    return {
      ...parsed,
      durationMs: Date.now() - startedAt,
    };
  }
}

export default OpenRouterService;
