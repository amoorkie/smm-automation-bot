import test from 'node:test';
import assert from 'node:assert/strict';

import OpenRouterService from '../src/services/openrouter.mjs';

test('generateText uses openrouter and preserves max_tokens', async () => {
  const originalFetch = global.fetch;
  const calls = [];
  global.fetch = async (url, options = {}) => {
    calls.push({ url, body: JSON.parse(options.body) });
    return {
      ok: true,
      json: async () => ({
        choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
      }),
    };
  };

  try {
    const service = new OpenRouterService({
      apiKey: 'sk-or-v1-primary',
      textModelId: 'openai/gpt-5.4',
      imageModelId: 'google/gemini-3.1-flash-image-preview',
    });
    const result = await service.generateText({
      systemPrompt: 'system',
      userPrompt: 'user',
      maxTokens: 123,
    });
    assert.equal(result.text, 'ok');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'https://openrouter.ai/api/v1/chat/completions');
    assert.equal(calls[0].body.max_tokens, 123);
  } finally {
    global.fetch = originalFetch;
  }
});

test('generateImages uses openrouter image path with provider policy', async () => {
  const originalFetch = global.fetch;
  const calls = [];
  global.fetch = async (url, options = {}) => {
    calls.push({ url, method: options.method, body: options.body ? JSON.parse(options.body) : null });
    return {
      ok: true,
      json: async () => ({
        choices: [{
          message: {
            content: 'ok',
            images: [{ image_url: { url: 'https://cdn.openrouter.ai/out.png' } }],
          },
        }],
        usage: { cost: 1 },
      }),
    };
  };

  try {
    const service = new OpenRouterService({
      apiKey: 'sk-or-v1-primary',
      textModelId: 'openai/gpt-5.4',
      imageModelId: 'google/gemini-3.1-flash-image-preview',
    });
    const result = await service.generateImages({
      prompt: 'edit image',
      imageUrls: ['data:image/jpeg;base64,abc'],
      imageConfig: { aspect_ratio: '3:4' },
    });
    assert.deepEqual(result.images, ['https://cdn.openrouter.ai/out.png']);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'https://openrouter.ai/api/v1/chat/completions');
    assert.equal(calls[0].body.image_config.aspect_ratio, '3:4');
    assert.equal(calls[0].body.messages[0].content[1].type, 'image_url');
    assert.deepEqual(calls[0].body.provider, { ignore: ['google-ai-studio'], require_parameters: true });
  } finally {
    global.fetch = originalFetch;
  }
});

test('generateImages retries upstream rate limit on openrouter without fallback provider', async () => {
  const originalFetch = global.fetch;
  const calls = [];
  global.fetch = async (url, options = {}) => {
    const body = options.body ? JSON.parse(options.body) : null;
    calls.push({ url, method: options.method, body });
    if (Array.isArray(body?.provider?.ignore) && body.provider.ignore.includes('google-ai-studio')) {
      return {
        ok: false,
        status: 429,
        json: async () => ({
          error: {
            message: 'Provider returned error',
            code: 429,
            metadata: {
              raw: 'google/gemini-3.1-flash-image-preview is temporarily rate-limited upstream',
              provider_name: 'Google',
            },
          },
        }),
      };
    }
    return {
      ok: true,
      json: async () => ({
        choices: [{
          message: {
            content: 'ok',
            images: [{ image_url: { url: 'https://cdn.openrouter.ai/out.png' } }],
          },
        }],
      }),
    };
  };

  try {
    const service = new OpenRouterService({
      apiKey: 'sk-or-v1-primary',
      textModelId: 'openai/gpt-5.4',
      imageModelId: 'google/gemini-3.1-flash-image-preview',
    });
    const result = await service.generateImages({
      prompt: 'edit image',
      imageUrls: ['data:image/jpeg;base64,abc'],
    });
    assert.deepEqual(result.images, ['https://cdn.openrouter.ai/out.png']);
    assert.equal(calls.length, 4);
    assert.ok(calls.every((entry) => entry.url === 'https://openrouter.ai/api/v1/chat/completions'));
    assert.deepEqual(calls[0].body.provider, { ignore: ['google-ai-studio'], require_parameters: true });
    assert.deepEqual(calls[1].body.provider, { ignore: ['google-ai-studio'], require_parameters: true });
    assert.deepEqual(calls[2].body.provider, { ignore: ['google-ai-studio'], require_parameters: true });
    assert.deepEqual(calls[3].body.provider, { require_parameters: true });
  } finally {
    global.fetch = originalFetch;
  }
});

test('generateImages throws on credit error without fallback provider', async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => ({
    ok: false,
    status: 402,
    json: async () => ({ error: { message: 'insufficient credits' } }),
  });

  try {
    const service = new OpenRouterService({
      apiKey: 'sk-or-v1-primary',
      textModelId: 'openai/gpt-5.4',
      imageModelId: 'google/gemini-3.1-flash-image-preview',
    });
    await assert.rejects(
      service.generateImages({
        prompt: 'edit image',
        imageUrls: ['data:image/jpeg;base64,abc'],
      }),
      /openrouter error 402/i,
    );
  } finally {
    global.fetch = originalFetch;
  }
});

test('generateImages throws when openrouter returns success without images', async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => ({
    ok: true,
    json: async () => ({
      choices: [{
        message: {
          content: 'ok',
          images: [],
        },
      }],
    }),
  });

  try {
    const service = new OpenRouterService({
      apiKey: 'sk-or-v1-primary',
      textModelId: 'openai/gpt-5.4',
      imageModelId: 'google/gemini-3.1-flash-image-preview',
    });
    await assert.rejects(
      service.generateImages({
        prompt: 'edit image',
        imageUrls: ['data:image/jpeg;base64,abc'],
      }),
      /returned no images/i,
    );
  } finally {
    global.fetch = originalFetch;
  }
});

test('generateImages retries without provider policy when preferred route returns no images', async () => {
  const originalFetch = global.fetch;
  const calls = [];
  global.fetch = async (url, options = {}) => {
    const body = options.body ? JSON.parse(options.body) : null;
    calls.push({ url, body });
    if (Array.isArray(body?.provider?.ignore) && body.provider.ignore.includes('google-ai-studio')) {
      return {
        ok: true,
        json: async () => ({
          choices: [{
            message: {
              content: 'ok',
              images: [],
            },
          }],
        }),
      };
    }
    return {
      ok: true,
      json: async () => ({
        choices: [{
          message: {
            content: 'ok',
            images: [{ image_url: { url: 'https://cdn.openrouter.ai/alt.png' } }],
          },
        }],
      }),
    };
  };

  try {
    const service = new OpenRouterService({
      apiKey: 'sk-or-v1-primary',
      textModelId: 'openai/gpt-5.4',
      imageModelId: 'google/gemini-3.1-flash-image-preview',
    });
    const result = await service.generateImages({
      prompt: 'edit image',
      imageUrls: ['data:image/jpeg;base64,abc'],
    });
    assert.deepEqual(result.images, ['https://cdn.openrouter.ai/alt.png']);
    assert.equal(calls.length, 2);
    assert.deepEqual(calls[0].body.provider, { ignore: ['google-ai-studio'], require_parameters: true });
    assert.deepEqual(calls[1].body.provider, { require_parameters: true });
  } finally {
    global.fetch = originalFetch;
  }
});
