import test from 'node:test';
import assert from 'node:assert/strict';

import VkOAuthService from '../src/services/vk-oauth.mjs';

test('vk oauth builds code flow authorize url', () => {
  const oauth = new VkOAuthService({
    clientId: '54547064',
    clientSecret: 'secret',
    redirectUri: 'https://bot.example.com/api/vk/oauth/callback',
    scope: 'photos,wall',
  });

  const url = new URL(oauth.buildAuthorizeUrl({ state: 'state-1' }));

  assert.equal(url.origin + url.pathname, 'https://oauth.vk.com/authorize');
  assert.equal(url.searchParams.get('client_id'), '54547064');
  assert.equal(url.searchParams.get('redirect_uri'), 'https://bot.example.com/api/vk/oauth/callback');
  assert.equal(url.searchParams.get('scope'), 'photos,wall');
  assert.equal(url.searchParams.get('response_type'), 'code');
  assert.equal(url.searchParams.get('state'), 'state-1');
});

test('vk oauth exchanges code for token with signed state', async () => {
  const calls = [];
  const oauth = new VkOAuthService({
    clientId: '54547064',
    clientSecret: 'secret',
    redirectUri: 'https://bot.example.com/api/vk/oauth/callback',
  });
  const state = oauth.createState();

  const result = await oauth.exchangeCode({
    code: 'auth-code',
    state,
    fetchImpl: async (url, options) => {
      calls.push({ url: new URL(url), options });
      return {
        ok: true,
        async json() {
          return {
            access_token: 'vk-token',
            expires_in: 86400,
            user_id: 515194961,
          };
        },
      };
    },
  });

  assert.equal(result.accessToken, 'vk-token');
  assert.equal(result.expiresIn, 86400);
  assert.equal(result.userId, '515194961');
  assert.equal(calls[0].url.origin + calls[0].url.pathname, 'https://oauth.vk.com/access_token');
  assert.equal(calls[0].url.searchParams.get('client_id'), '54547064');
  assert.equal(calls[0].url.searchParams.get('client_secret'), 'secret');
  assert.equal(calls[0].url.searchParams.get('code'), 'auth-code');
  assert.equal(calls[0].options.method, 'GET');
});

test('vk oauth rejects tampered state', async () => {
  const oauth = new VkOAuthService({
    clientId: '54547064',
    clientSecret: 'secret',
    redirectUri: 'https://bot.example.com/api/vk/oauth/callback',
  });

  await assert.rejects(
    () => oauth.exchangeCode({
      code: 'auth-code',
      state: '1.bad.bad',
      fetchImpl: async () => {
        throw new Error('fetch should not be called');
      },
    }),
    /Invalid VK OAuth state/u,
  );
});
