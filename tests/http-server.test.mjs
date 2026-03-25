import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from '../src/http/server.mjs';
import { createWorkerAuthToken } from '../src/http/worker-dispatch.mjs';

function createContext(overrides = {}) {
  const calls = [];
  const env = {
    appTimezone: 'Europe/Moscow',
    botDisabled: false,
    port: 3000,
    webhookBaseUrl: 'https://bot.example.com',
    tgBotToken: 'test-token',
    ...overrides.env,
  };
  const service = {
    async handleTelegramUpdate(update) {
      calls.push(update);
      return { ok: true };
    },
    async runCollectionFinalizer() {},
    async runCleanup() {},
    ...overrides.service,
  };
  const bot = {
    api: {
      async setWebhook() {},
    },
  };

  return { env, service, bot, calls };
}

test('webhook route executes service handler directly and returns 200', async () => {
  const context = createContext();
  const server = createServer(context);

  try {
    const response = await server.app.inject({
      method: 'POST',
      url: '/telegram/webhook',
      payload: { update_id: 1 },
      headers: { host: 'bot.example.com' },
    });

    assert.equal(response.statusCode, 200);
    assert.deepEqual(context.calls, [{ update_id: 1 }]);
  } finally {
    await server.stop();
  }
});

test('worker route requires auth token and executes service handler', async () => {
  const context = createContext();
  const server = createServer(context);

  try {
    const unauthorized = await server.app.inject({
      method: 'POST',
      url: '/worker/telegram-update',
      payload: { update_id: 2 },
    });
    assert.equal(unauthorized.statusCode, 401);

    const authorized = await server.app.inject({
      method: 'POST',
      url: '/worker/telegram-update',
      payload: { update_id: 3 },
      headers: {
        'x-anita-worker-token': createWorkerAuthToken(context.env),
      },
    });
    assert.equal(authorized.statusCode, 200);
    assert.deepEqual(context.calls, [{ update_id: 3 }]);
  } finally {
    await server.stop();
  }
});
