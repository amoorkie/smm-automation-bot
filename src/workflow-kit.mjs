const ISO_DATETIME_RE = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})$/;

export const LOCKED_PROMPT_KEYS = [
  'work_album_consistency_extraction',
  'work_image_edit_keep',
  'work_image_edit_blur',
  'work_image_edit_neutral',
  'work_brow_consistency_extraction',
  'work_brow_edit_keep',
  'work_brow_edit_blur',
  'work_brow_edit_neutral',
  'work_collage_generation',
  'work_brow_collage_generation',
  'work_caption_generation',
  'work_brow_caption_generation',
  'topic_post_generation',
  'topic_image_generation',
  'help_message',
  'contact_block',
];

export const DATA_TABLE_NAMES = [
  'expert_topics',
  'content_queue',
  'prompt_templates',
  'publish_log',
  'bot_logs',
  'tg_sessions',
  'work_collections',
  'callback_tokens',
  'idempotency_keys',
  'publish_locks',
  'job_runtime_cache',
];

export const BOT_LOG_COLUMNS = [
  'ts',
  'level',
  'event',
  'workflow',
  'execution_id',
  'chat_id',
  'user_id',
  'job_id',
  'queue_id',
  'source_type',
  'stage',
  'collection_id',
  'node',
  'status',
  'duration_ms',
  'message',
  'payload_json',
];

export const JOB_STATUSES = [
  'collecting',
  'generating',
  'preview_ready',
  'cancelled',
  'failed',
];

export const QUEUE_STATUSES = [
  'draft',
  'preview_ready',
  'cancelled',
];

export function safeJsonParse(value, fallback = null) {
  if (value === null || value === undefined || value === '') {
    return fallback;
  }

  if (typeof value !== 'string') {
    return value;
  }

  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

export function simpleHash(input) {
  const source = typeof input === 'string' ? input : JSON.stringify(input);
  let hash = 2166136261;
  for (let index = 0; index < source.length; index += 1) {
    hash ^= source.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

export function stableId(prefix, input) {
  return `${prefix}-${simpleHash(input).toUpperCase()}`;
}

export function computeIdempotencyKey(scope, payload) {
  return `${scope}:${simpleHash({ scope, payload })}`;
}

export function buildBotLogEntry({
  ts = new Date().toISOString(),
  level = 'INFO',
  event,
  workflow = 'smm_automation_bot',
  executionId = null,
  chatId = null,
  userId = null,
  jobId = null,
  queueId = null,
  sourceType = null,
  stage = null,
  collectionId = null,
  node = null,
  status = 'ok',
  durationMs = null,
  message = '',
  payload = null,
}) {
  return {
    ts,
    level,
    event,
    workflow,
    execution_id: executionId,
    chat_id: chatId,
    user_id: userId,
    job_id: jobId,
    queue_id: queueId,
    source_type: sourceType,
    stage,
    collection_id: collectionId,
    node,
    status,
    duration_ms: durationMs,
    message,
    payload_json: payload ? JSON.stringify(payload) : '',
  };
}

export function buildCollectionKey({ chatId, mediaGroupId, firstMessageId }) {
  if (mediaGroupId) {
    return `${chatId}:group:${mediaGroupId}`;
  }
  return `${chatId}:single:${firstMessageId}`;
}

function getTelegramText(update) {
  return update?.message?.text ?? update?.edited_message?.text ?? '';
}

function getTelegramPhotos(message) {
  const photoSizes = Array.isArray(message?.photo) ? message.photo : [];
  if (photoSizes.length === 0) {
    return [];
  }

  const largestPhoto = [...photoSizes].sort((left, right) => {
    const leftArea = (left?.width ?? 0) * (left?.height ?? 0);
    const rightArea = (right?.width ?? 0) * (right?.height ?? 0);
    if (leftArea === rightArea) {
      return (right?.file_size ?? 0) - (left?.file_size ?? 0);
    }
    return rightArea - leftArea;
  })[0];

  return largestPhoto ? [largestPhoto] : [];
}

function normalizeCommand(text) {
  const value = String(text ?? '')
    .replace(/^[\s\u200B-\u200D\uFEFF]+/u, '')
    .trim();
  if (!value || !value.startsWith('/')) {
    return null;
  }
  return value.split(/\s+/u)[0].replace(/@[\p{L}\p{N}_]+$/u, '').toLowerCase();
}

export function normalizeTelegramUpdate(update) {
  const message = update?.message ?? update?.edited_message ?? null;
  const callback = update?.callback_query ?? null;
  const text = callback?.data ? null : getTelegramText(update);
  const command = normalizeCommand(text);
  const photos = getTelegramPhotos(message);

  const normalized = {
    updateId: update?.update_id ?? null,
    kind: 'unknown',
    command: null,
    chatId: message?.chat?.id ?? callback?.message?.chat?.id ?? null,
    userId: message?.from?.id ?? callback?.from?.id ?? null,
    messageId: message?.message_id ?? callback?.message?.message_id ?? null,
    mediaGroupId: message?.media_group_id ?? null,
    text: text ?? null,
    callbackData: callback?.data ?? null,
    callbackMessageId: callback?.message?.message_id ?? null,
    callbackQueryId: callback?.id ?? null,
    photos: photos.map((photo) => ({
      fileId: photo.file_id,
      uniqueFileId: photo.file_unique_id,
      width: photo.width,
      height: photo.height,
      fileSize: photo.file_size ?? null,
    })),
    replyToMessageId: message?.reply_to_message?.message_id ?? null,
  };

  if (callback) {
    normalized.kind = 'callback';
    return normalized;
  }

  if (command) {
    normalized.kind = 'command';
    normalized.command = command;
    return normalized;
  }

  if (photos.length > 0) {
    normalized.kind = 'photo';
    return normalized;
  }

  if (text) {
    normalized.kind = 'text';
    return normalized;
  }

  return normalized;
}

export function buildCallbackTokenPayload({
  jobId,
  revision,
  action,
  ttlMinutes = 120,
  now = new Date(),
}) {
  const issuedAt = new Date(now);
  const expiresAt = new Date(issuedAt.getTime() + (ttlMinutes * 60_000));
  const token = stableId(
    'CB',
    `${jobId}:${revision}:${action}:${issuedAt.toISOString()}`,
  );
  const tokenSetId = stableId(
    'CBS',
    `${jobId}:${revision}:${issuedAt.toISOString()}`,
  );

  return {
    token,
    tokenSetId,
    jobId,
    revision,
    action,
    issuedAt: issuedAt.toISOString(),
    expiresAt: expiresAt.toISOString(),
    used: false,
    superseded: false,
  };
}

export function validateCallbackToken({
  tokenRow,
  expectedJobId,
  expectedRevision,
  now = new Date(),
}) {
  if (!tokenRow) {
    return { ok: false, reason: 'missing' };
  }
  if (tokenRow.used) {
    return { ok: false, reason: 'used' };
  }
  if (tokenRow.superseded) {
    return { ok: false, reason: 'superseded' };
  }
  if (tokenRow.jobId !== expectedJobId) {
    return { ok: false, reason: 'wrong_job' };
  }
  if (Number(tokenRow.revision) !== Number(expectedRevision)) {
    return { ok: false, reason: 'stale_revision' };
  }
  if (new Date(tokenRow.expiresAt).getTime() <= new Date(now).getTime()) {
    return { ok: false, reason: 'expired' };
  }
  return { ok: true, reason: 'ok' };
}

export function buildOpenRouterTextPayload({
  model,
  systemPrompt,
  userPrompt,
  imageUrls = [],
  temperature = 0.7,
  maxTokens = null,
  metadata = {},
}) {
  const messages = [];
  if (systemPrompt) {
    messages.push({ role: 'system', content: systemPrompt });
  }
  if (Array.isArray(imageUrls) && imageUrls.length > 0) {
    const content = [{ type: 'text', text: userPrompt }];
    for (const url of imageUrls) {
      content.push({
        type: 'image_url',
        image_url: { url },
      });
    }
    messages.push({ role: 'user', content });
  } else {
    messages.push({ role: 'user', content: userPrompt });
  }

  const payload = {
    model,
    temperature,
    stream: false,
    messages,
    metadata,
  };
  if (Number.isFinite(Number(maxTokens)) && Number(maxTokens) > 0) {
    payload.max_tokens = Number(maxTokens);
  }
  return payload;
}

export function buildOpenRouterImagePayload({
  model,
  prompt,
  imageUrls = [],
  imageConfig = {},
  maxTokens = null,
  metadata = {},
  provider = null,
}) {
  const content = [{ type: 'text', text: prompt }];
  for (const url of imageUrls) {
    content.push({
      type: 'image_url',
      image_url: { url },
    });
  }

  const payload = {
    model,
    stream: false,
    modalities: ['image', 'text'],
    messages: [
      {
        role: 'user',
        content,
      },
    ],
    image_config: imageConfig,
    metadata,
  };
  if (provider && typeof provider === 'object') {
    payload.provider = provider;
  }
  if (Number.isFinite(Number(maxTokens)) && Number(maxTokens) > 0) {
    payload.max_tokens = Number(maxTokens);
  }
  return payload;
}

export function parseOpenRouterTextResponse(response) {
  const data = safeJsonParse(response, response);
  const choice = data?.choices?.[0];
  return {
    text: choice?.message?.content ?? null,
    finishReason: choice?.finish_reason ?? null,
    usage: data?.usage ?? null,
  };
}

export function parseOpenRouterImageResponse(response) {
  const data = safeJsonParse(response, response);
  const message = data?.choices?.[0]?.message ?? {};
  const images = Array.isArray(message.images)
    ? message.images
        .map((entry) => entry?.image_url?.url ?? null)
        .filter(Boolean)
    : [];

  return {
    text: message?.content ?? null,
    images,
    usage: data?.usage ?? null,
  };
}

export function buildCollageLayout(imageRefs) {
  const count = Array.isArray(imageRefs) ? imageRefs.length : 0;
  if (count < 1 || count > 3) {
    throw new Error('collage supports only 1..3 images');
  }

  if (count === 1) {
    return {
      mode: 'reuse_single_image',
      width: 1080,
      height: 1350,
      slots: [{ x: 0, y: 0, width: 1080, height: 1350, sourceIndex: 0 }],
    };
  }

  if (count === 2) {
    return {
      mode: 'equal_grid_2',
      width: 1080,
      height: 1350,
      slots: [
        { x: 0, y: 0, width: 540, height: 1350, sourceIndex: 0 },
        { x: 540, y: 0, width: 540, height: 1350, sourceIndex: 1 },
      ],
    };
  }

  return {
    mode: 'equal_grid_3',
    width: 1080,
    height: 1350,
    slots: [
      { x: 0, y: 0, width: 360, height: 1350, sourceIndex: 0 },
      { x: 360, y: 0, width: 360, height: 1350, sourceIndex: 1 },
      { x: 720, y: 0, width: 360, height: 1350, sourceIndex: 2 },
    ],
  };
}

export function reclaimExpiredTopic(topic, now = new Date()) {
  if (!topic) {
    return null;
  }

  if (topic.status !== 'reserved') {
    return topic;
  }

  const reservedUntil = new Date(topic.reserved_until ?? 0).getTime();
  if (reservedUntil > new Date(now).getTime()) {
    return topic;
  }

  return {
    ...topic,
    status: 'ready',
    reserved_until: null,
    reserved_by_job_id: null,
  };
}

export default {
  LOCKED_PROMPT_KEYS,
  DATA_TABLE_NAMES,
  JOB_STATUSES,
  QUEUE_STATUSES,
  safeJsonParse,
  simpleHash,
  stableId,
  computeIdempotencyKey,
  buildCollectionKey,
  normalizeTelegramUpdate,
  buildCallbackTokenPayload,
  validateCallbackToken,
  buildOpenRouterTextPayload,
  buildOpenRouterImagePayload,
  parseOpenRouterTextResponse,
  parseOpenRouterImageResponse,
  buildCollageLayout,
  reclaimExpiredTopic,
};
