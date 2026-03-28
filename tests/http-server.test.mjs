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
    async handleQueuedRuntimeAction(payload) {
      calls.push({ worker: payload });
      return { ok: true };
    },
    async handleCollectionFinalizeAction(payload) {
      calls.push({ finalize: payload });
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

test('runtime worker route requires auth token and executes queued runtime action', async () => {
  const context = createContext();
  const server = createServer(context);

  try {
    const unauthorized = await server.app.inject({
      method: 'POST',
      url: '/worker/runtime-action',
      payload: { jobId: 'JOB-1', action: 'generate_initial' },
    });
    assert.equal(unauthorized.statusCode, 401);

    const authorized = await server.app.inject({
      method: 'POST',
      url: '/worker/runtime-action',
      payload: { jobId: 'JOB-2', action: 'regenerate_text' },
      headers: {
        'x-anita-worker-token': createWorkerAuthToken(context.env),
      },
    });
    assert.equal(authorized.statusCode, 200);
    assert.deepEqual(context.calls, [{ worker: { jobId: 'JOB-2', action: 'regenerate_text' } }]);
  } finally {
    await server.stop();
  }
});

test('collection finalize worker route requires auth token and executes finalize action', async () => {
  const context = createContext();
  const server = createServer(context);

  try {
    const unauthorized = await server.app.inject({
      method: 'POST',
      url: '/worker/collection-finalize',
      payload: { collectionId: 'COL-1' },
    });
    assert.equal(unauthorized.statusCode, 401);

    const authorized = await server.app.inject({
      method: 'POST',
      url: '/worker/collection-finalize',
      payload: { collectionId: 'COL-2' },
      headers: {
        'x-anita-worker-token': createWorkerAuthToken(context.env),
      },
    });
    assert.equal(authorized.statusCode, 200);
    assert.deepEqual(context.calls, [{ finalize: { collectionId: 'COL-2' } }]);
  } finally {
    await server.stop();
  }
});
