import test from 'node:test';
import assert from 'node:assert/strict';

import VkPublisher from '../src/services/vk-publisher.mjs';

test('vk publisher uses user token for photo upload and community token for wall post', async () => {
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options = {}) => {
    const href = String(url);
    if (href.includes('/photos.getWallUploadServer')) {
      const params = Object.fromEntries(options.body.entries());
      calls.push({ method: 'photos.getWallUploadServer', accessToken: params.access_token });
      return Response.json({ response: { upload_url: 'https://upload.example.test/wall' } });
    }
    if (href === 'https://upload.example.test/wall') {
      calls.push({ method: 'upload' });
      return Response.json({ photo: '[]', server: 1, hash: 'hash' });
    }
    if (href.includes('/photos.saveWallPhoto')) {
      const params = Object.fromEntries(options.body.entries());
      calls.push({ method: 'photos.saveWallPhoto', accessToken: params.access_token });
      return Response.json({ response: [{ owner_id: 515194961, id: 457243736 }] });
    }
    if (href.includes('/wall.post')) {
      const params = Object.fromEntries(options.body.entries());
      calls.push({
        method: 'wall.post',
        accessToken: params.access_token,
        ownerId: params.owner_id,
        attachments: params.attachments,
      });
      return Response.json({ response: { post_id: 123 } });
    }
    throw new Error(`Unexpected fetch URL: ${href}`);
  };

  try {
    const publisher = new VkPublisher({
      accessToken: 'user-token',
      wallPostAccessToken: 'community-token',
      groupId: '237715719',
      enabled: true,
    });
    const result = await publisher.publishPost({
      caption: 'test',
      images: [{ buffer: Buffer.from('image'), mimeType: 'image/jpeg', fileName: 'test.jpg' }],
    });

    assert.equal(result.postId, '123');
    assert.deepEqual(calls, [
      { method: 'photos.getWallUploadServer', accessToken: 'user-token' },
      { method: 'upload' },
      { method: 'photos.saveWallPhoto', accessToken: 'user-token' },
      {
        method: 'wall.post',
        accessToken: 'community-token',
        ownerId: '-237715719',
        attachments: 'photo515194961_457243736',
      },
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
