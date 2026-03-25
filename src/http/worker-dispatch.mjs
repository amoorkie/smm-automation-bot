import { createHash, timingSafeEqual } from 'node:crypto';

function normalizeHeaderBag(headers = {}) {
  const normalized = {};
  for (const [key, value] of Object.entries(headers ?? {})) {
    normalized[String(key).toLowerCase()] = Array.isArray(value) ? value[0] : value;
  }
  return normalized;
}

export function createWorkerAuthToken(env) {
  return createHash('sha256')
    .update(String(env?.tgBotToken ?? ''))
    .digest('hex');
}

export function isWorkerRequestAuthorized(headers, env) {
  const normalized = normalizeHeaderBag(headers);
  const provided = normalized['x-anita-worker-token'];
  const expected = createWorkerAuthToken(env);
  if (!provided || !expected) {
    return false;
  }
  const left = Buffer.from(String(provided));
  const right = Buffer.from(String(expected));
  if (left.length !== right.length) {
    return false;
  }
  return timingSafeEqual(left, right);
}

export function resolveWorkerBaseUrl({ env, headers = {}, protocol } = {}) {
  if (env?.webhookBaseUrl) {
    return String(env.webhookBaseUrl).replace(/\/$/u, '');
  }
  const normalized = normalizeHeaderBag(headers);
  const host = normalized['x-forwarded-host'] ?? normalized.host;
  if (!host) {
    return null;
  }
  const resolvedProtocol = normalized['x-forwarded-proto'] ?? protocol ?? 'http';
  return `${resolvedProtocol}://${host}`.replace(/\/$/u, '');
}

export async function dispatchTelegramUpdateToWorker({
  env,
  update,
  workerPath,
  headers = {},
  protocol,
  fetchImpl = globalThis.fetch,
}) {
  const baseUrl = resolveWorkerBaseUrl({ env, headers, protocol });
  if (!baseUrl) {
    throw new Error('Unable to resolve worker base URL');
  }
  if (typeof fetchImpl !== 'function') {
    throw new Error('Fetch implementation is not available for worker dispatch');
  }
  const response = await fetchImpl(`${baseUrl}${workerPath}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-anita-worker-token': createWorkerAuthToken(env),
    },
    body: JSON.stringify(update ?? {}),
  });
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`Worker dispatch failed with ${response.status}${body ? `: ${body}` : ''}`);
  }
}

export async function dispatchWorkerPayload({
  env,
  payload,
  workerPath,
  headers = {},
  protocol,
  fetchImpl = globalThis.fetch,
}) {
  const baseUrl = resolveWorkerBaseUrl({ env, headers, protocol });
  if (!baseUrl) {
    throw new Error('Unable to resolve worker base URL');
  }
  if (typeof fetchImpl !== 'function') {
    throw new Error('Fetch implementation is not available for worker dispatch');
  }
  const response = await fetchImpl(`${baseUrl}${workerPath}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-anita-worker-token': createWorkerAuthToken(env),
    },
    body: JSON.stringify(payload ?? {}),
  });
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`Worker dispatch failed with ${response.status}${body ? `: ${body}` : ''}`);
  }
}

export default {
  createWorkerAuthToken,
  isWorkerRequestAuthorized,
  resolveWorkerBaseUrl,
  dispatchTelegramUpdateToWorker,
  dispatchWorkerPayload,
};
