import loadEnv from '../../../src/config/env.mjs';
import VkOAuthService from '../../../src/services/vk-oauth.mjs';
import { renderVkOAuthErrorPage } from '../../../src/http/vk-oauth-page.mjs';

function resolveBaseUrl(request, env) {
  if (env.webhookBaseUrl) {
    return env.webhookBaseUrl.replace(/\/+$/u, '');
  }
  const protocol = request.headers['x-forwarded-proto'] ?? 'https';
  const host = request.headers['x-forwarded-host'] ?? request.headers.host;
  return host ? `${protocol}://${host}` : '';
}

export default async function handler(request, response) {
  const env = loadEnv(process.env);
  const vkOAuth = new VkOAuthService({
    clientId: env.vkClientId,
    clientSecret: env.vkClientSecret,
    redirectUri: env.vkOAuthRedirectUri,
    scope: env.vkOAuthScope,
  });

  try {
    const url = vkOAuth.buildAuthorizeUrl({ baseUrl: resolveBaseUrl(request, env) });
    response.statusCode = 302;
    response.setHeader('location', url);
    response.end();
  } catch (error) {
    response.status(error.statusCode ?? 500);
    response.setHeader('content-type', 'text/html; charset=utf-8');
    response.send(renderVkOAuthErrorPage(error));
  }
}
