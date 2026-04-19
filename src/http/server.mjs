import Fastify from 'fastify';
import { isRetryableHttpError, withRetry } from '../services/resilience.mjs';
import VkOAuthService from '../services/vk-oauth.mjs';
import { isWorkerRequestAuthorized } from './worker-dispatch.mjs';
import { renderVkOAuthErrorPage, renderVkOAuthSuccessPage } from './vk-oauth-page.mjs';

export function createServer({ env, service, bot }) {
  const app = Fastify({ logger: true });
  const vkOAuth = new VkOAuthService({
    clientId: env.vkClientId,
    clientSecret: env.vkClientSecret,
    redirectUri: env.vkOAuthRedirectUri,
    scope: env.vkOAuthScope,
  });

  function registerWorkerRoute(path, handler) {
    app.post(path, handler);
    app.post(`/api${path}`, handler);
  }

  function registerPublicGetRoute(path, handler) {
    app.get(path, handler);
    app.get(`/api${path}`, handler);
  }

  function resolveBaseUrl(request) {
    if (env.webhookBaseUrl) {
      return env.webhookBaseUrl.replace(/\/+$/u, '');
    }
    const protocol = request.headers['x-forwarded-proto'] ?? request.protocol ?? 'http';
    const host = request.headers['x-forwarded-host'] ?? request.headers.host;
    return host ? `${protocol}://${host}` : '';
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

  registerPublicGetRoute('/vk/oauth/start', async (request, reply) => {
    try {
      return reply.redirect(vkOAuth.buildAuthorizeUrl({ baseUrl: resolveBaseUrl(request) }));
    } catch (error) {
      return reply
        .status(error.statusCode ?? 500)
        .type('text/html; charset=utf-8')
        .send(renderVkOAuthErrorPage(error));
    }
  });

  registerPublicGetRoute('/vk/oauth/callback', async (request, reply) => {
    reply.header('cache-control', 'no-store');
    try {
      if (request.query?.error) {
        const error = new Error(String(request.query.error_description || request.query.error));
        error.code = String(request.query.error);
        error.statusCode = 400;
        throw error;
      }

      const token = await vkOAuth.exchangeCode({
        code: request.query?.code,
        state: request.query?.state,
        baseUrl: resolveBaseUrl(request),
      });
      return reply
        .type('text/html; charset=utf-8')
        .send(renderVkOAuthSuccessPage(token));
    } catch (error) {
      return reply
        .status(error.statusCode ?? 500)
        .type('text/html; charset=utf-8')
        .send(renderVkOAuthErrorPage(error));
    }
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
