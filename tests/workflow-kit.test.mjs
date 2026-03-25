import test from 'node:test';
import assert from 'node:assert/strict';

import {
  BOT_LOG_COLUMNS,
  DATA_TABLE_NAMES,
  LOCKED_PROMPT_KEYS,
  buildBotLogEntry,
  buildCallbackTokenPayload,
  buildCollageLayout,
  buildCollectionKey,
  buildOpenRouterImagePayload,
  buildOpenRouterTextPayload,
  computeIdempotencyKey,
  normalizeTelegramUpdate,
  parseOpenRouterImageResponse,
  parseOpenRouterTextResponse,
  reclaimExpiredTopic,
  safeJsonParse,
  simpleHash,
  stableId,
  validateCallbackToken,
} from '../src/workflow-kit.mjs';

test('locked prompt keys stay aligned with the prompt contract', () => {
  assert.equal(LOCKED_PROMPT_KEYS.length, 10);
  assert.ok(LOCKED_PROMPT_KEYS.includes('help_message'));
  assert.ok(LOCKED_PROMPT_KEYS.includes('work_image_reframe_master'));
  assert.ok(LOCKED_PROMPT_KEYS.includes('work_collage_generation'));
  assert.ok(LOCKED_PROMPT_KEYS.includes('contact_block'));
});

test('table names and log columns stay aligned with the Supabase contract', () => {
  assert.ok(DATA_TABLE_NAMES.includes('prompt_templates'));
  assert.ok(DATA_TABLE_NAMES.includes('job_runtime_cache'));
  assert.ok(BOT_LOG_COLUMNS.includes('stage'));
  assert.ok(BOT_LOG_COLUMNS.includes('duration_ms'));
});

test('hash helpers are deterministic', () => {
  assert.equal(simpleHash('abc'), simpleHash('abc'));
  assert.equal(stableId('JOB', 'abc'), stableId('JOB', 'abc'));
  assert.notEqual(computeIdempotencyKey('scope', { a: 1 }), computeIdempotencyKey('scope', { a: 2 }));
});

test('collection keys prefer media groups and fall back to message id', () => {
  assert.equal(
    buildCollectionKey({ chatId: 42, mediaGroupId: 'mg-1', firstMessageId: 11 }),
    '42:group:mg-1',
  );
  assert.equal(
    buildCollectionKey({ chatId: 42, mediaGroupId: null, firstMessageId: 11 }),
    '42:single:11',
  );
});

test('telegram updates normalize commands and callback payloads', () => {
  const command = normalizeTelegramUpdate({
    update_id: 1,
    message: {
      message_id: 10,
      text: '/help',
      chat: { id: 100 },
      from: { id: 200 },
    },
  });
  assert.equal(command.kind, 'command');
  assert.equal(command.command, '/help');

  const commandWithBotName = normalizeTelegramUpdate({
    update_id: 3,
    message: {
      message_id: 11,
      text: '/help@anita_salon_bot',
      chat: { id: 100 },
      from: { id: 200 },
    },
  });
  assert.equal(commandWithBotName.kind, 'command');
  assert.equal(commandWithBotName.command, '/help');

  const startWithPayload = normalizeTelegramUpdate({
    update_id: 5,
    message: {
      message_id: 13,
      text: '/start@anita_salon_bot deeplink-payload',
      chat: { id: 100 },
      from: { id: 200 },
    },
  });
  assert.equal(startWithPayload.kind, 'command');
  assert.equal(startWithPayload.command, '/start');

  const startWithLeadingWhitespace = normalizeTelegramUpdate({
    update_id: 6,
    message: {
      message_id: 14,
      text: '   /start   ',
      chat: { id: 100 },
      from: { id: 200 },
    },
  });
  assert.equal(startWithLeadingWhitespace.kind, 'command');
  assert.equal(startWithLeadingWhitespace.command, '/start');

  const startWithInvisiblePrefix = normalizeTelegramUpdate({
    update_id: 7,
    message: {
      message_id: 15,
      text: '\u200B/start',
      chat: { id: 100 },
      from: { id: 200 },
    },
  });
  assert.equal(startWithInvisiblePrefix.kind, 'command');
  assert.equal(startWithInvisiblePrefix.command, '/start');

  const callback = normalizeTelegramUpdate({
    update_id: 2,
    callback_query: {
      id: 'cb-1',
      data: 'regenerate_text:token',
      from: { id: 300 },
      message: { message_id: 12, chat: { id: 400 } },
    },
  });
  assert.equal(callback.kind, 'callback');
  assert.equal(callback.callbackData, 'regenerate_text:token');
});

test('telegram photo normalization keeps only the largest photo size for one message', () => {
  const normalized = normalizeTelegramUpdate({
    update_id: 4,
    message: {
      message_id: 20,
      chat: { id: 100 },
      from: { id: 200 },
      photo: [
        { file_id: 'small', file_unique_id: 'u1', width: 90, height: 90, file_size: 1000 },
        { file_id: 'large', file_unique_id: 'u2', width: 1280, height: 1280, file_size: 5000 },
      ],
    },
  });

  assert.equal(normalized.kind, 'photo');
  assert.equal(normalized.photos.length, 1);
  assert.equal(normalized.photos[0].fileId, 'large');
});

test('callback token payload and validation support stale-token checks', () => {
  const payload = buildCallbackTokenPayload({
    jobId: 'JOB-1',
    revision: 2,
    action: 'regenerate_text',
    now: new Date('2026-03-17T10:00:00.000Z'),
  });

  const valid = validateCallbackToken({
    tokenRow: payload,
    expectedJobId: 'JOB-1',
    expectedRevision: 2,
    now: new Date('2026-03-17T10:30:00.000Z'),
  });
  assert.deepEqual(valid, { ok: true, reason: 'ok' });

  const stale = validateCallbackToken({
    tokenRow: payload,
    expectedJobId: 'JOB-1',
    expectedRevision: 3,
    now: new Date('2026-03-17T10:30:00.000Z'),
  });
  assert.equal(stale.reason, 'stale_revision');
});

test('OpenRouter payload builders use current image_url field names', () => {
  const textPayload = buildOpenRouterTextPayload({
    model: 'openai/gpt-5.4-mini',
    systemPrompt: 'System',
    userPrompt: 'User',
    imageUrls: ['data:image/jpeg;base64,abc'],
  });
  assert.equal(textPayload.messages[0].role, 'system');
  assert.equal(textPayload.messages[1].role, 'user');
  assert.equal(textPayload.messages[1].content[1].type, 'image_url');

  const imagePayload = buildOpenRouterImagePayload({
    model: 'google/gemini-3.1-flash-image-preview',
    prompt: 'Enhance this image',
    imageUrls: ['https://example.com/a.png'],
  });
  assert.equal(imagePayload.messages[0].content[1].type, 'image_url');
  assert.deepEqual(imagePayload.messages[0].content[1].image_url, {
    url: 'https://example.com/a.png',
  });
});

test('OpenRouter response parsers extract text and generated images', () => {
  const textResponse = parseOpenRouterTextResponse({
    choices: [{ message: { content: 'Caption' }, finish_reason: 'stop' }],
    usage: { total_tokens: 10 },
  });
  assert.equal(textResponse.text, 'Caption');

  const imageResponse = parseOpenRouterImageResponse({
    choices: [{
      message: {
        content: 'Done',
        images: [
          { image_url: { url: 'data:image/png;base64,abc' } },
          { image_url: { url: 'https://example.com/image.png' } },
        ],
      },
    }],
  });
  assert.equal(imageResponse.images.length, 2);
  assert.equal(imageResponse.images[0], 'data:image/png;base64,abc');
});

test('collage layout returns deterministic fallback manifests', () => {
  assert.equal(buildCollageLayout([1]).mode, 'reuse_single_image');
  assert.equal(buildCollageLayout([1, 2]).slots.length, 2);
  assert.equal(buildCollageLayout([1, 2, 3]).slots.length, 3);
  assert.throws(() => buildCollageLayout([]), /1..3/);
});

test('expired reserved topics are reclaimed back to ready', () => {
  const nextTopic = reclaimExpiredTopic({
    status: 'reserved',
    reserved_until: '2026-03-17T08:00:00.000Z',
    reserved_by_job_id: 'JOB-1',
  }, new Date('2026-03-17T09:00:00.000Z'));
  assert.equal(nextTopic.status, 'ready');
  assert.equal(nextTopic.reserved_by_job_id, null);
});

test('safe JSON parse supports downstream adapters', () => {
  assert.deepEqual(safeJsonParse('{"ok":true}'), { ok: true });
  assert.equal(safeJsonParse('{bad}', 'fallback'), 'fallback');
});

test('bot log entries stay structured and JSON-safe', () => {
  const entry = buildBotLogEntry({
    event: 'openrouter_request',
    executionId: '123',
    chatId: 42,
    jobId: 'JOB-1',
    node: 'Call OpenRouter Work Image',
    payload: { model: 'google/gemini-3.1-flash-image-preview', asset_count: 1 },
  });

  assert.equal(entry.level, 'INFO');
  assert.equal(entry.event, 'openrouter_request');
  assert.equal(entry.execution_id, '123');
  assert.equal(entry.chat_id, 42);
  assert.match(entry.payload_json, /asset_count/);
});
