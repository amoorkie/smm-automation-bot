import crypto from 'node:crypto';

import { withTimeout } from './resilience.mjs';

const VK_API_VERSION = '5.199';
const VK_OAUTH_AUTHORIZE_URL = 'https://oauth.vk.com/authorize';
const VK_OAUTH_ACCESS_TOKEN_URL = 'https://oauth.vk.com/access_token';
const DEFAULT_SCOPE = 'photos,wall';
const STATE_TTL_MS = 15 * 60 * 1000;

export class VkOAuthError extends Error {
  constructor(message, { code = 'vk_oauth_error', statusCode = 400, rawResponse = null } = {}) {
    super(message);
    this.name = 'VkOAuthError';
    this.code = code;
    this.statusCode = statusCode;
    this.rawResponse = rawResponse;
  }
}

function base64Url(input) {
  return Buffer.from(input)
    .toString('base64')
    .replace(/\+/gu, '-')
    .replace(/\//gu, '_')
    .replace(/=+$/u, '');
}

function signStatePayload(payload, secret) {
  return base64Url(crypto.createHmac('sha256', secret).update(payload).digest());
}

function parseTokenResponse(json) {
  if (!json?.access_token) {
    throw new VkOAuthError('VK OAuth did not return an access token', {
      code: 'vk_oauth_no_access_token',
      rawResponse: json,
    });
  }

  return {
    accessToken: String(json.access_token),
    expiresIn: Number(json.expires_in ?? 0),
    userId: json.user_id ? String(json.user_id) : '',
    obtainedAt: new Date().toISOString(),
  };
}

export default class VkOAuthService {
  constructor({
    clientId = '',
    clientSecret = '',
    redirectUri = '',
    scope = DEFAULT_SCOPE,
    apiVersion = VK_API_VERSION,
    stateSecret = '',
  } = {}) {
    this.clientId = String(clientId ?? '').trim();
    this.clientSecret = String(clientSecret ?? '').trim();
    this.redirectUri = String(redirectUri ?? '').trim();
    this.scope = String(scope ?? DEFAULT_SCOPE).trim() || DEFAULT_SCOPE;
    this.apiVersion = apiVersion;
    this.stateSecret = String(stateSecret || clientSecret || clientId || '').trim();
  }

  isConfigured() {
    return Boolean(this.clientId && this.clientSecret && this.stateSecret);
  }

  resolveRedirectUri(baseUrl = '') {
    if (this.redirectUri) {
      return this.redirectUri;
    }
    const normalizedBaseUrl = String(baseUrl ?? '').trim().replace(/\/+$/u, '');
    if (!normalizedBaseUrl) {
      throw new VkOAuthError('VK OAuth redirect URI is not configured', {
        code: 'vk_oauth_no_redirect_uri',
        statusCode: 500,
      });
    }
    return `${normalizedBaseUrl}/api/vk/oauth/callback`;
  }

  createState(now = Date.now()) {
    const payload = `${Number(now)}.${crypto.randomBytes(12).toString('hex')}`;
    const signature = signStatePayload(payload, this.stateSecret);
    return `${payload}.${signature}`;
  }

  validateState(state, now = Date.now()) {
    const normalized = String(state ?? '').trim();
    const parts = normalized.split('.');
    if (parts.length !== 3) {
      throw new VkOAuthError('Invalid VK OAuth state', { code: 'vk_oauth_invalid_state' });
    }

    const [timestamp, nonce, signature] = parts;
    if (!/^\d+$/u.test(timestamp) || !/^[a-f0-9]{24}$/iu.test(nonce)) {
      throw new VkOAuthError('Invalid VK OAuth state payload', { code: 'vk_oauth_invalid_state' });
    }

    const ageMs = Number(now) - Number(timestamp);
    if (ageMs < 0 || ageMs > STATE_TTL_MS) {
      throw new VkOAuthError('VK OAuth state has expired', { code: 'vk_oauth_expired_state' });
    }

    const payload = `${timestamp}.${nonce}`;
    const expected = signStatePayload(payload, this.stateSecret);
    const left = Buffer.from(signature);
    const right = Buffer.from(expected);
    if (left.length !== right.length || !crypto.timingSafeEqual(left, right)) {
      throw new VkOAuthError('Invalid VK OAuth state signature', { code: 'vk_oauth_invalid_state' });
    }

    return true;
  }

  buildAuthorizeUrl({ baseUrl = '', state = this.createState() } = {}) {
    if (!this.isConfigured()) {
      throw new VkOAuthError('VK OAuth is not configured', {
        code: 'vk_oauth_not_configured',
        statusCode: 503,
      });
    }

    const url = new URL(VK_OAUTH_AUTHORIZE_URL);
    url.searchParams.set('client_id', this.clientId);
    url.searchParams.set('display', 'page');
    url.searchParams.set('redirect_uri', this.resolveRedirectUri(baseUrl));
    url.searchParams.set('scope', this.scope);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('state', state);
    url.searchParams.set('v', this.apiVersion);
    return url.toString();
  }

  async exchangeCode({ code, state, baseUrl = '', fetchImpl = fetch } = {}) {
    if (!this.isConfigured()) {
      throw new VkOAuthError('VK OAuth is not configured', {
        code: 'vk_oauth_not_configured',
        statusCode: 503,
      });
    }

    const normalizedCode = String(code ?? '').trim();
    if (!normalizedCode) {
      throw new VkOAuthError('VK OAuth callback has no code', { code: 'vk_oauth_no_code' });
    }
    this.validateState(state);

    const url = new URL(VK_OAUTH_ACCESS_TOKEN_URL);
    url.searchParams.set('client_id', this.clientId);
    url.searchParams.set('client_secret', this.clientSecret);
    url.searchParams.set('redirect_uri', this.resolveRedirectUri(baseUrl));
    url.searchParams.set('code', normalizedCode);

    const response = await withTimeout(
      (signal) => fetchImpl(url, { method: 'GET', signal }),
      30_000,
      'VK OAuth token exchange timed out',
    );

    if (!response.ok) {
      throw new VkOAuthError(`VK OAuth token exchange failed with HTTP ${response.status}`, {
        code: 'vk_oauth_http_error',
        statusCode: 502,
        rawResponse: { status: response.status },
      });
    }

    const json = await response.json();
    if (json?.error) {
      throw new VkOAuthError(json.error_description || json.error || 'VK OAuth token exchange failed', {
        code: 'vk_oauth_provider_error',
        statusCode: 400,
        rawResponse: json,
      });
    }

    return parseTokenResponse(json);
  }
}
