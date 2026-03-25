import getVercelContext from '../../src/vercel-context.mjs';
import { isWorkerRequestAuthorized } from '../../src/http/worker-dispatch.mjs';
import loadEnv from '../../src/config/env.mjs';

export default async function handler(request, response) {
  if (String(process.env.BOT_DISABLED ?? '').trim().toLowerCase() === 'true') {
    response.status(503).json({ ok: false, error: 'bot_disabled' });
    return;
  }

  const env = loadEnv(process.env);
  if (!isWorkerRequestAuthorized(request.headers, env)) {
    response.status(401).json({ ok: false, error: 'unauthorized_worker_request' });
    return;
  }

  try {
    const { service } = await getVercelContext();
    const result = await service.handleTelegramUpdate(request.body ?? {});
    response.status(200).json({ ok: true, result });
  } catch (error) {
    response.status(500).json({ ok: false, error: error.message });
  }
}
