import Fastify from 'fastify';
import { isRetryableHttpError, withRetry } from '../services/resilience.mjs';
import { isWorkerRequestAuthorized } from './worker-dispatch.mjs';

export function createServer({ env, service, bot }) {
  const app = Fastify({ logger: true });

  function registerWorkerRoute(path, handler) {
    app.post(path, handler);
    app.post(`/api${path}`, handler);
  }

  app.get('/healthz', async () => ({ ok: true }));
  app.get('/readyz', async () => ({ ok: true, timezone: env.appTimezone, disabled: env.botDisabled }));
  app.get('/cron/finalize', async (_request, reply) => {
    if (env.botDisabled) {
      return reply.status(503).send({ ok: false, error: 'bot_disabled' });
    }
    await service.runCollectionFinalizer();
    return { ok: true };
  });
  app.get('/cron/cleanup', async (_request, reply) => {
    if (env.botDisabled) {
      return reply.status(503).send({ ok: false, error: 'bot_disabled' });
    }
    await service.runCleanup();
    return { ok: true };
  });

  registerWorkerRoute('/worker/telegram-update', async (request, reply) => {
    if (env.botDisabled) {
      return reply.status(503).send({ ok: false, error: 'bot_disabled' });
    }
    if (!isWorkerRequestAuthorized(request.headers, env)) {
      return reply.status(401).send({ ok: false, error: 'unauthorized_worker_request' });
    }
    const result = await service.handleTelegramUpdate(request.body ?? {});
    return reply.send({ ok: true, result });
  });

  registerWorkerRoute('/worker/runtime-action', async (request, reply) => {
    if (env.botDisabled) {
      return reply.status(503).send({ ok: false, error: 'bot_disabled' });
    }
    if (!isWorkerRequestAuthorized(request.headers, env)) {
      return reply.status(401).send({ ok: false, error: 'unauthorized_worker_request' });
    }
    const result = await service.handleQueuedRuntimeAction(request.body ?? {});
    return reply.send({ ok: true, result });
  });

  registerWorkerRoute('/worker/collection-finalize', async (request, reply) => {
    if (env.botDisabled) {
      return reply.status(503).send({ ok: false, error: 'bot_disabled' });
    }
    if (!isWorkerRequestAuthorized(request.headers, env)) {
      return reply.status(401).send({ ok: false, error: 'unauthorized_worker_request' });
    }
    const result = await service.handleCollectionFinalizeAction(request.body ?? {});
    return reply.send({ ok: true, result });
  });

  app.post('/telegram/webhook', async (request, reply) => {
    if (env.botDisabled) {
      return reply.status(503).send({ ok: false, error: 'bot_disabled' });
    }
    const result = await service.handleTelegramUpdate(request.body ?? {});
    return reply.send({ ok: true, result });
  });

  app.setErrorHandler((error, _request, reply) => {
    app.log.error(error);
    reply.status(500).send({ ok: false, error: error.message });
  });

  return {
    app,
    async start() {
      await app.listen({ host: '0.0.0.0', port: env.port });
      if (!env.webhookBaseUrl) {
        app.log.warn('WEBHOOK_BASE_URL is not configured; skipping Telegram webhook registration');
        return;
      }
      const webhookUrl = `${env.webhookBaseUrl.replace(/\/$/u, '')}/telegram/webhook`;
      try {
        await withRetry(
          () => bot.api.setWebhook(webhookUrl, { drop_pending_updates: false }),
          { retries: 3, delayMs: 500, shouldRetry: isRetryableHttpError },
        );
        app.log.info({ webhookUrl }, 'Telegram webhook registered');
      } catch (error) {
        app.log.error({ webhookUrl, error: error.message }, 'Telegram webhook registration failed');
      }
    },
    async stop() {
      await app.close();
    },
  };
}

export default createServer;
