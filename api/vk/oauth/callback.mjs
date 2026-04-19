import loadEnv from '../../../src/config/env.mjs';
import { renderVkOAuthErrorPage, renderVkOAuthSuccessPage } from '../../../src/http/vk-oauth-page.mjs';
import VkOAuthService from '../../../src/services/vk-oauth.mjs';

function resolveBaseUrl(request, env) {
  if (env.webhookBaseUrl) {
    return env.webhookBaseUrl.replace(/\/+$/u, '');
  }
  const protocol = request.headers['x-forwarded-proto'] ?? 'https';
  const host = request.headers['x-forwarded-host'] ?? request.headers.host;
  return host ? `${protocol}://${host}` : '';
}

function getQuery(request, env) {
  const baseUrl = resolveBaseUrl(request, env) || 'https://example.com';
  return new URL(request.url ?? '/', baseUrl).searchParams;
}

export default async function handler(request, response) {
  const env = loadEnv(process.env);
  const vkOAuth = new VkOAuthService({
    clientId: env.vkClientId,
    clientSecret: env.vkClientSecret,
    redirectUri: env.vkOAuthRedirectUri,
    scope: env.vkOAuthScope,
  });

  response.setHeader('cache-control', 'no-store');
  response.setHeader('content-type', 'text/html; charset=utf-8');

  try {
    const query = getQuery(request, env);
    if (query.get('error')) {
      const error = new Error(query.get('error_description') || query.get('error'));
      error.code = query.get('error');
      error.statusCode = 400;
      throw error;
    }

    const token = await vkOAuth.exchangeCode({
      code: query.get('code'),
      state: query.get('state'),
      baseUrl: resolveBaseUrl(request, env),
    });

    response.status(200).send(renderVkOAuthSuccessPage(token));
  } catch (error) {
    response.status(error.statusCode ?? 500).send(renderVkOAuthErrorPage(error));
  }
}
