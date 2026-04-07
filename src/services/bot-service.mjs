import { InputFile } from 'grammy';
import sharp from 'sharp';

import {
  CALLBACK_TTL_MINUTES,
  DEFAULT_PROMPTS,
  SHEET_HEADERS,
  SHEET_NAMES,
  USER_MESSAGES,
  TOPIC_RESERVATION_MINUTES,
  WORK_COLLECTION_DEBOUNCE_SECONDS,
  WORK_COLLECTION_INITIAL_ALBUM_GRACE_SECONDS,
  WORK_COLLECTION_PARTIAL_ALBUM_GRACE_SECONDS,
  WORK_SESSION_TTL_MINUTES,
} from '../config/defaults.mjs';
import {
  TOPIC_SALON_INTERIOR_GUIDANCE,
  TOPIC_SALON_REFERENCE_IMAGE_URLS,
} from '../config/topic-salon-refs.mjs';
import {
  buildCallbackTokenPayload,
  buildControlMessageText,
  buildHelpMessage,
  buildStartMessage,
  buildPreviewKeyboard,
  buildPreviewCaption,
  buildQueueRow,
  buildRenderModeKeyboard,
  buildWorkBackgroundKeyboard,
  buildWorkBrowOutputKeyboard,
  buildWorkPhotoTypeKeyboard,
  buildWorkCleanupKeyboard,
  buildWorkPromptModeKeyboard,
  buildWorkSubjectKeyboard,
  normalizeTelegramUpdate,
  nowIso,
  parseTags,
  reclaimExpiredTopic,
  safeJsonParse,
  stableId,
  toDataUrl,
  validateCallbackToken,
} from '../domain/index.mjs';
import { dispatchWorkerPayload } from '../http/worker-dispatch.mjs';
import { isRetryableHttpError, withRetry, withTimeout } from './resilience.mjs';
import { InlineKeyboard } from 'grammy';
import {
  composeCreativeSlide,
  composeSliderSlides,
  composeStorySlide,
} from './slide-composer.mjs';

function addMinutes(base, minutes) {
  return new Date(new Date(base).getTime() + (minutes * 60_000)).toISOString();
}

function addSeconds(base, seconds) {
  return new Date(new Date(base).getTime() + (seconds * 1000)).toISOString();
}

function isTelegramMessageNotModifiedError(error) {
  const message = String(error?.message ?? '');
  return /message is not modified/iu.test(message);
}

function shouldReplaceTelegramControlMessage(error) {
  const message = String(error?.message ?? '');
  return /message to edit not found/iu.test(message)
    || /message can't be edited/iu.test(message)
    || /MESSAGE_ID_INVALID/iu.test(message)
    || /message identifier is not specified/iu.test(message);
}

function sanitizeCaption(text) {
  return String(text ?? '').trim() || USER_MESSAGES.fallbackCaption;
}

function appendContactBlock(text, contactBlock) {
  const caption = sanitizeCaption(text);
  const line = String(contactBlock ?? '').trim();
  if (!line || /\[.*номер.*\]/iu.test(line) || /укажите номер/iu.test(line) || caption.includes(line)) {
    return caption;
  }
  return `${caption}\n\n${line}`;
}

function extractPhoneNumber(contactBlock) {
  const line = String(contactBlock ?? '').trim();
  const match = line.match(/(\+?\d[\d\s()-]{8,}\d)/u);
  return match?.[1]?.trim() ?? '';
}

function appendTopicOutro(text, contactBlock) {
  const caption = sanitizeCaption(text);
  const phone = extractPhoneNumber(contactBlock);
  if (phone && caption.includes(phone)) {
    return caption;
  }

  const outroLines = [
    'Так что вот, такие дела) Следите за собой, а я вам в этом помогу 💛',
    phone ? `Записаться можно по телефону ${phone} 📞` : String(contactBlock ?? '').trim(),
  ].filter(Boolean);

  if (outroLines.length === 0) {
    return caption;
  }

  return `${caption}\n\n${outroLines.join('\n')}`;
}

function basenameForMime(mimeType, fallback = 'image.jpg') {
  if (mimeType?.includes('png')) {
    return fallback.replace(/\.\w+$/u, '.png');
  }
  if (mimeType?.includes('webp')) {
    return fallback.replace(/\.\w+$/u, '.webp');
  }
  return fallback;
}

async function measureDuration(action) {
  const startedAt = Date.now();
  const result = await action();
  return {
    result,
    durationMs: Date.now() - startedAt,
  };
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isDuplicateIdempotencyError(error) {
  const message = String(error?.message ?? '');
  return /duplicate key|already exists|23505|unique constraint|violates unique/i.test(message);
}

const TELEGRAM_PHOTO_CAPTION_LIMIT = 1024;
const TOPIC_LIKE_PAGE_SIZE = 10;
const TOPIC_LIKE_PICKER_TTL_MINUTES = 120;
const SOURCE_RECLAIM_CACHE_MS = 30_000;

const TOPIC_LIKE_MODE_CONFIG = {
  topic: {
    command: '/topic',
    sourceSheetName: SHEET_NAMES.expertTopics,
    pickerTitle: 'Выбери тему для профессионального поста',
    emptyMessage: USER_MESSAGES.noReadyTopic,
    promptKeys: {
      text: 'topic_post_generation',
      image: 'topic_image_generation',
    },
    previewKind: 'topic',
  },
  stories: {
    command: '/stories',
    sourceSheetName: SHEET_NAMES.storyTopics,
    pickerTitle: 'Выбери тему для stories',
    emptyMessage: 'Сейчас нет готовых тем для stories.',
    promptKeys: {
      manifest: 'story_manifest_generation',
      visual: 'story_visual_generation',
    },
    previewKind: 'story',
  },
  creative: {
    command: '/creative',
    sourceSheetName: SHEET_NAMES.creativeIdeas,
    pickerTitle: 'Выбери идею для креатива',
    emptyMessage: 'Сейчас нет готовых идей для креативов.',
    promptKeys: {
      manifest: 'creative_manifest_generation',
      visual: 'creative_visual_generation',
    },
    previewKind: 'creative',
  },
  slider: {
    command: '/slider',
    sourceSheetName: SHEET_NAMES.sliderTopics,
    pickerTitle: 'Выбери тему для слайдера',
    emptyMessage: 'Сейчас нет готовых тем для слайдеров.',
    promptKeys: {
      manifest: 'slider_manifest_generation',
      visual: 'slider_visual_generation',
    },
    previewKind: 'slider',
  },
};

function shouldDetachPreviewText(caption, runtime = null) {
  if (String(caption ?? '').length > TELEGRAM_PHOTO_CAPTION_LIMIT) {
    return true;
  }
  return Boolean(
    runtime?.collage_message_id
    && runtime?.text_message_id
    && runtime.text_message_id !== runtime.collage_message_id,
  );
}

function buildPreviewMetaCaption({
  revision,
  totalRevisions,
  renderMode,
}) {
  return buildPreviewCaption({
    caption: '',
    revision,
    totalRevisions,
    renderMode,
  }).trim();
}

function toStoredText(value) {
  if (value === undefined || value === null) {
    return '';
  }
  return String(value);
}

const PINNED_WORK_TEXT_MODEL_ID = 'openai/gpt-5.4';
const MODEL_IMAGE_MAX_DIMENSION = 1280;
const MODEL_IMAGE_JPEG_QUALITY = 82;
const REQUIRED_WORK_PROMPT_KEYS = [
  'work_album_consistency_extraction',
  'work_brow_consistency_extraction',
  'work_image_edit_keep',
  'work_image_edit_blur',
  'work_image_edit_neutral',
  'work_brow_edit_keep',
  'work_brow_edit_blur',
  'work_brow_edit_neutral',
  'work_collage_generation',
  'work_brow_collage_generation',
  'work_caption_generation',
  'work_brow_caption_generation',
  'contact_block',
];

export class SalonBotService {
  constructor({
    env,
    bot,
    repos,
    store,
    openrouter,
    promptConfig,
    botLogger,
  }) {
    this.env = env;
    this.bot = bot;
    this.repos = repos;
    this.store = store;
    this.openrouter = openrouter;
    this.promptConfig = promptConfig;
    this.botLogger = botLogger;
    this.localLocks = new Map();
    this.sourceReclaimState = new Map();
    this.workerDispatchDisabledReason = '';
  }

  buildUserErrorMessage(error, fallback = USER_MESSAGES.genericError) {
    return error?.userMessage || fallback;
  }

  formatCaptionWithContact(text, contactBlock = DEFAULT_PROMPTS.contact_block) {
    return appendContactBlock(text, contactBlock);
  }

  isEmptyProviderTextError(error) {
    return error?.name === 'ProviderEmptyResultError'
      || /returned no text/i.test(String(error?.message ?? ''));
  }

  shouldDisableWorkerDispatch(error) {
    const message = String(error?.message ?? '');
    return /Worker dispatch failed with 401/i.test(message)
      || /Authentication Required/i.test(message)
      || /unauthorized_worker_request/i.test(message);
  }

  getWorkerDispatchSkipReason() {
    if (this.workerDispatchDisabledReason) {
      return this.workerDispatchDisabledReason;
    }
    if (!this.env?.internalWorkerDispatchEnabled) {
      return 'worker_dispatch_disabled';
    }
    const webhookBaseUrl = String(this.env?.webhookBaseUrl ?? '').trim();
    if (!webhookBaseUrl) {
      return 'missing_base_url';
    }
    if (this.env?.webhookBaseUrlDerivedFromDeploymentUrl) {
      return 'protected_deployment_base_url';
    }
    try {
      const host = new URL(webhookBaseUrl).hostname.toLowerCase();
      if (host === 'vercel.app' || host.endsWith('.vercel.app')) {
        return 'protected_vercel_host';
      }
    } catch {
      return 'invalid_base_url';
    }
    return '';
  }

  buildFallbackWorkCaption(sourceAssetCount = 1, { subjectType = 'hair', browOutputMode = 'after_only' } = {}) {
    if (subjectType === 'brows') {
      if (browOutputMode === 'before_after') {
        return 'Показываю брови до и после ✨\nФорму и насыщенность вывела аккуратно, чтобы результат выглядел чисто, ровно и естественно.';
      }
      return 'Показываю готовый результат по бровям ✨\nСделала форму чище и аккуратнее, чтобы взгляд смотрелся мягко и собранно.';
    }
    if (Number(sourceAssetCount) > 1) {
      return 'Показываю работу с нескольких ракурсов ✨\nФорма и силуэт читаются чище, а волосы выглядят аккуратно и собранно.';
    }
    return 'Аккуратная работа с формой и текстурой ✨\nСделала образ чище и выразительнее, чтобы волосы выглядели ухоженно и легко читались в кадре.';
  }

  async generateWorkCaptionText({
    prompts,
    sourceAssetCount = 1,
    imageUrls = [],
    jobId = '',
    revision = null,
    renderMode = 'separate',
    subjectType = 'hair',
    browOutputMode = 'after_only',
    chatId = null,
    userId = null,
    queueId = '',
    collectionId = '',
  }) {
    try {
      const result = await this.openrouter.generateText({
        systemPrompt: subjectType === 'brows'
          ? (prompts.work_brow_caption_generation ?? DEFAULT_PROMPTS.work_brow_caption_generation)
          : (prompts.work_caption_generation ?? DEFAULT_PROMPTS.work_caption_generation),
        userPrompt: this.buildWorkCaptionUserPrompt(sourceAssetCount, { subjectType, browOutputMode }),
        imageUrls,
        temperature: 0.9,
        maxTokens: 220,
        model: this.getWorkTextModelId(),
        metadata: {
          source_type: 'work',
          job_id: jobId,
          revision,
          model: this.getWorkTextModelId(),
          source_asset_count: sourceAssetCount,
          render_mode: renderMode,
          subject_type: subjectType,
          brow_output_mode: browOutputMode,
          pass: 'work_caption',
        },
      });
      return {
        text: this.formatCaptionWithContact(result.text, prompts.contact_block),
        fallback: false,
      };
    } catch (error) {
      if (!this.isEmptyProviderTextError(error)) {
        throw error;
      }
      this.logEventBestEffort({
        level: 'ERROR',
        event: 'work_caption_provider_empty',
        stage: 'processing',
        chatId,
        userId,
        jobId,
        queueId,
        collectionId,
        sourceType: 'work',
        status: 'fallback',
        message: error.message,
        payload: {
          model: this.getWorkTextModelId(),
          sourceAssetCount,
          renderMode,
          subjectType,
          browOutputMode,
        },
      });
      return {
        text: this.formatCaptionWithContact(
          this.buildFallbackWorkCaption(sourceAssetCount, { subjectType, browOutputMode }),
          prompts.contact_block,
        ),
        fallback: true,
      };
    }
  }

  formatTopicCaption(text, contactBlock = DEFAULT_PROMPTS.contact_block) {
    return appendTopicOutro(text, contactBlock);
  }

  buildWorkCaptionUserPrompt(assetCount, { subjectType = 'hair', browOutputMode = 'after_only' } = {}) {
    if (subjectType === 'brows') {
      return [
        `Сделай готовый короткий пост к работе мастера по бровям. Количество фото: ${assetCount}.`,
        `Режим показа: ${browOutputMode === 'before_after' ? 'до и после' : 'только после'}.`,
        'Это должен быть финальный текст для публикации, а не комментарий к задаче.',
        'Не задавай вопросов, не проси прислать фото, не объясняй процесс.',
        'Пиши от первого лица одного мастера.',
        'Не используй формулировки "мы", "наши мастера", "один из мастеров", "команда".',
        'Сделай текст коротким и живым: иногда достаточно 2 коротких строк, иногда 1-2 коротких абзацев.',
        'Если по фото можно уверенно назвать работу перманентным макияжем или оформлением бровей — назови это. Если уверенности нет, используй нейтральную формулировку про брови.',
        'Главный акцент делай на результате для клиента, а не на предпочтениях мастера.',
        'Не повторяй формулировки вроде "люблю", "обожаю", "именно так я люблю" и похожие обороты. Такие фразы допустимы редко и только если действительно к месту.',
        'Добавь живую человеческую подачу без канцелярита.',
        'Контактный блок добавлять не нужно.',
      ].join('\n');
    }
    return [
      `Сделай готовый короткий пост к работе мастера. Количество фото: ${assetCount}.`,
      'Это должен быть финальный текст для публикации, а не комментарий к задаче.',
      'Не задавай вопросов, не проси прислать фото, не объясняй процесс.',
      'Пиши от первого лица одного мастера.',
      'Не используй формулировки "мы", "наши мастера", "один из мастеров", "команда".',
      'Сделай текст коротким и разнообразным по длине: иногда достаточно 2 коротких строк, иногда 1-2 коротких абзацев.',
      'Если тип работы можно уверенно определить по фото, назови его в начале. Если уверенности нет — не выдумывай и используй нейтральную формулировку.',
      'Не называй работу свадебной, вечерней, мужской, окрашиванием или любой другой конкретной услугой без прямых визуальных признаков.',
      'Главный акцент делай на результате для клиента: что получилось, как выглядит форма, текстура, силуэт, аккуратность и удобство в носке.',
      'Не повторяй формулировки вроде "люблю", "обожаю", "именно так я люблю" и похожие обороты. Такие фразы допустимы редко и только если действительно к месту.',
      'Добавь умеренно больше эмодзи и живую человеческую подачу.',
      'Допустима лёгкая разговорная шероховатость, но без явных ошибок и без сломанной грамматики.',
      'Контактный блок добавлять не нужно.',
    ].join('\n');
  }

  async toModelImageUrl(asset) {
    if (!asset?.buffer) {
      return null;
    }
    try {
      const normalizedBuffer = await sharp(asset.buffer, { failOn: 'none' })
        .rotate()
        .resize({
          width: MODEL_IMAGE_MAX_DIMENSION,
          height: MODEL_IMAGE_MAX_DIMENSION,
          fit: 'inside',
          withoutEnlargement: true,
        })
        .jpeg({ quality: MODEL_IMAGE_JPEG_QUALITY, mozjpeg: true })
        .toBuffer();
      return toDataUrl(normalizedBuffer, 'image/jpeg');
    } catch {
      return toDataUrl(asset.buffer, asset.mimeType ?? 'image/jpeg');
    }
  }

  async buildWorkCaptionImageUrls(assets) {
    const urls = await Promise.all((assets ?? []).map((asset) => this.toModelImageUrl(asset)));
    return urls.filter(Boolean).slice(0, 3);
  }

  async buildWorkCollageImageUrls(assets) {
    const urls = await Promise.all((assets ?? []).map((asset) => this.toModelImageUrl(asset)));
    return urls.filter(Boolean).slice(0, 3);
  }

  getWorkImageConfig(pass) {
    if (pass === 'compose_collage') {
      return { aspect_ratio: '4:5' };
    }
    return { aspect_ratio: '3:4' };
  }

  isRecoverableWorkImageProviderFailure(error) {
    return this.isRecoverableImageProviderFailure(error);
  }

  isRecoverableImageProviderFailure(error) {
    if (!error) {
      return false;
    }
    if (error?.name === 'ProviderEmptyResultError' || error?.name === 'ProviderRequestError') {
      return true;
    }
    const message = String(error?.message ?? '');
    return /openrouter error (402|429)/iu.test(message)
      || /returned no images/iu.test(message)
      || /did not return a work image/iu.test(message)
      || /temporarily rate-limited upstream|rate-?limit/iu.test(message);
  }

  async buildDegradedLocalWorkAsset(inputAsset) {
    const buffer = await sharp(inputAsset.buffer, { failOn: 'none' })
      .rotate()
      .resize({
        width: MODEL_IMAGE_MAX_DIMENSION,
        height: MODEL_IMAGE_MAX_DIMENSION,
        fit: 'inside',
        withoutEnlargement: true,
      })
      .normalize()
      .modulate({
        brightness: 1.03,
        saturation: 1.07,
      })
      .gamma(1.02)
      .sharpen(1.1, 1, 2)
      .jpeg({ quality: 90, mozjpeg: true })
      .toBuffer();
    return {
      buffer,
      mimeType: 'image/jpeg',
      filename: basenameForMime('image/jpeg', inputAsset.filename ?? 'work.jpg'),
    };
  }

  shouldAllowDegradedLocalWorkFallback({
    sourceAssetCount = 1,
    subjectType = 'hair',
    backgroundMode = '',
    cleanupMode = 'off',
    promptMode = 'normal',
  } = {}) {
    if (Number(sourceAssetCount) !== 1) {
      return false;
    }
    if (this.getWorkSubjectType(subjectType) !== 'hair') {
      return false;
    }
    return String(backgroundMode || '') === 'keep'
      && String(cleanupMode || 'off') === 'off'
      && String(promptMode || 'normal') === 'normal';
  }

  inferWorkBackgroundMode(consistencyNotes = '') {
    const notes = String(consistencyNotes ?? '');
    if (/NEUTRAL_LIGHT_BACKGROUND/u.test(notes)) {
      return 'neutral';
    }
    return 'blur';
  }

  getWorkSubjectType(value = '') {
    return String(value || '') === 'brows' ? 'brows' : 'hair';
  }

  getBrowOutputMode(value = '') {
    return String(value || '') === 'before_after' ? 'before_after' : 'after_only';
  }

  getWorkImagePromptKey(subjectType = 'hair', backgroundMode = 'blur') {
    if (this.getWorkSubjectType(subjectType) === 'brows') {
      if (backgroundMode === 'neutral') {
        return 'work_brow_edit_neutral';
      }
      if (backgroundMode === 'keep') {
        return 'work_brow_edit_keep';
      }
      return 'work_brow_edit_blur';
    }
    if (backgroundMode === 'neutral') {
      return 'work_image_edit_neutral';
    }
    if (backgroundMode === 'keep') {
      return 'work_image_edit_keep';
    }
    return 'work_image_edit_blur';
  }

  buildUnifiedWorkImagePrompt(prompts, {
    consistencyNotes = '',
    backgroundMode = '',
    cleanupMode = 'off',
    promptMode = 'normal',
    subjectType = 'hair',
    browOutputMode = 'after_only',
    browPassKind = 'after',
  } = {}) {
    const normalizedBackgroundMode = backgroundMode || this.inferWorkBackgroundMode(consistencyNotes);
    const normalizedSubjectType = this.getWorkSubjectType(subjectType);
    const promptKey = this.getWorkImagePromptKey(normalizedSubjectType, normalizedBackgroundMode);
    const basePrompt = prompts[promptKey] ?? DEFAULT_PROMPTS[promptKey];
    return [
      basePrompt,
      normalizedSubjectType === 'brows'
        ? (
          this.getBrowOutputMode(browOutputMode) === 'before_after' && browPassKind === 'before'
            ? 'Brow mode: create a realistic BEFORE state from the same real person and same close-up. Keep the exact same eyebrow placement, face geometry, eyes, eyelids, squint, nose, ears, beard or stubble, clothing, pose, and camera angle. Make the brows visibly sparser, less filled, less tidy, a bit duller, and less defined, but still believable and natural. Do not invent a different person or a new facial expression.'
            : 'Brow mode: create a realistic AFTER state from the same real person and same close-up. Show аккуратный, ровный, естественный permanent makeup result with cleaner shape, richer but believable pigment, and a polished eyebrow finish. Do not invent a different person or change the face.'
        )
        : '',
      normalizedBackgroundMode === 'neutral'
        ? 'Neutral background override: fully replace the busy salon background with a plain clean light studio wall or a soft light gray seamless background. Remove mirrors, shelves, bottles, certificates, posters, window details, and all other interior distractions from the final frame.'
        : normalizedBackgroundMode === 'blur'
          ? 'Blur background override: keep the same room only as an extremely strong creamy blur so the main beauty result stays dominant and the background no longer reads as a detailed salon interior. Bottles, shelves, certificates, mirrors, windows, and text must stop being recognizable objects.'
          : '',
      cleanupMode === 'on'
        ? 'Cleanup rule: visibly clean the background. Remove or simplify small distracting clutter such as bottles, tools, cords, shelf junk, table mess, busy reflections, posters, and certificates whenever they distract from the main beauty result. If blur is selected, the cleaned background still must stay strongly blurred. Keep the person, beauty work, clothing, pose, body geometry, mirror placement, and main room perspective unchanged.'
        : '',
      cleanupMode === 'on' && normalizedBackgroundMode === 'blur'
        ? 'Combined blur plus cleanup rule: after cleanup, leave the remaining room only as a heavy blur. Background items must not survive as distinct readable objects.'
        : '',
      cleanupMode === 'on' && normalizedBackgroundMode === 'keep'
        ? 'Combined keep plus cleanup rule: preserve the room structure, but make it visibly tidier and calmer without changing the person or the beauty result.'
        : '',
      promptMode === 'test'
        ? 'Test mode: add a subtle studio contour relight and slightly clearer separation of the main beauty result from the background, but keep the result natural and physically plausible. Avoid any cutout, pasted, floating, or over-staged look.'
        : '',
      consistencyNotes ? `Locked album facts:\n${consistencyNotes}` : '',
    ].filter(Boolean).join('\n');
  }

  buildCompactWorkImagePrompt({
    backgroundMode = '',
    cleanupMode = 'off',
    promptMode = 'normal',
    consistencyNotes = '',
    subjectType = 'hair',
    browOutputMode = 'after_only',
    browPassKind = 'after',
  } = {}) {
    const normalizedBackgroundMode = backgroundMode || this.inferWorkBackgroundMode(consistencyNotes);
    const normalizedSubjectType = this.getWorkSubjectType(subjectType);
    return [
      'IMAGE EDIT ONLY. Use only the uploaded real photo.',
      normalizedSubjectType === 'brows'
        ? 'Preserve the exact same person, exact side profile, eyes, squint, eyelids, brows, nose, ears, beard or stubble, clothing, pose, and face geometry.'
        : 'Preserve the exact same person, exact side profile, eyes, brows, nose, ears, beard or stubble, clothing, pose, neck line, haircut shape, hair length, fade or graduation, neckline, and silhouette.',
      normalizedSubjectType === 'brows'
        ? 'Keep the camera visually level. Make one eyebrow or both eyebrows with the eyes dominate the frame naturally.'
        : 'Keep the camera visually level. Make the head and haircut dominate the frame naturally.',
      normalizedSubjectType === 'brows'
        ? (
          this.getBrowOutputMode(browOutputMode) === 'before_after' && browPassKind === 'before'
            ? 'Create a realistic BEFORE brow state: sparser, duller, less tidy, but still the same real person and same eyebrow placement.'
            : 'Create a realistic AFTER brow state with аккуратный natural permanent makeup styling while preserving the same person and same eyebrow placement.'
        )
        : '',
      normalizedBackgroundMode === 'neutral'
        ? 'Replace the busy salon background with a plain clean light studio background. Remove all readable text, certificates, mirrors, shelves, bottles, windows, and clutter from the final background.'
        : normalizedBackgroundMode === 'blur'
          ? 'Keep the real room only as an extremely strong soft blur. Do not keep any readable text, certificates, mirrors, shelves, bottles, or detailed clutter recognizable in the background.'
          : 'Keep the real room structure, but make the background calmer, cleaner, and less distracting. Any readable text must become unreadable.',
      cleanupMode === 'on'
        ? 'Clean up distracting small background clutter and junk, and if blur is selected keep the cleaned background strongly blurred. Do not change the person, beauty work, clothing, or scene geometry.'
        : '',
      cleanupMode === 'on' && normalizedBackgroundMode === 'blur'
        ? 'When blur and cleanup are both selected, remove or simplify clutter first and then leave the rest only as a heavy blur, not as recognizable objects.'
        : '',
      cleanupMode === 'on' && normalizedBackgroundMode === 'keep'
        ? 'When keep and cleanup are both selected, preserve the room structure but make the scene visibly tidier, calmer, and cleaner.'
        : '',
      promptMode === 'test'
        ? 'Use a subtle professional contour relight and gentle subject separation, but avoid any cutout or pasted look.'
        : '',
      'Apply realistic relight, upscale, texture clarity, and premium polish in this single pass.',
      consistencyNotes ? `Locked album facts:\n${consistencyNotes}` : '',
    ].filter(Boolean).join('\n');
  }

  async buildBeforeAfterPreviewAsset(beforeAsset, afterAsset, seed = 'brow-before-after') {
    const gap = 24;
    const targetHeight = 1350;
    const panelWidth = 528;
    const width = (panelWidth * 2) + gap;
    const background = { r: 245, g: 245, b: 245, alpha: 1 };

    const [beforeBuffer, afterBuffer] = await Promise.all([
      sharp(beforeAsset.buffer, { failOn: 'none' })
        .rotate()
        .resize({ width: panelWidth, height: targetHeight, fit: 'cover', position: 'centre' })
        .jpeg({ quality: 90, mozjpeg: true })
        .toBuffer(),
      sharp(afterAsset.buffer, { failOn: 'none' })
        .rotate()
        .resize({ width: panelWidth, height: targetHeight, fit: 'cover', position: 'centre' })
        .jpeg({ quality: 90, mozjpeg: true })
        .toBuffer(),
    ]);

    const buffer = await sharp({
      create: {
        width,
        height: targetHeight,
        channels: 4,
        background,
      },
    })
      .composite([
        { input: beforeBuffer, left: 0, top: 0 },
        { input: afterBuffer, left: panelWidth + gap, top: 0 },
      ])
      .jpeg({ quality: 92, mozjpeg: true })
      .toBuffer();

    return {
      buffer,
      mimeType: 'image/jpeg',
      filename: basenameForMime('image/jpeg', `${seed}.jpg`),
    };
  }

  buildWorkCollagePrompt(prompts, {
    consistencyNotes = '',
    backgroundMode = '',
    cleanupMode = 'off',
    promptMode = 'normal',
    subjectType = 'hair',
    browOutputMode = '',
  } = {}) {
    const normalizedBackgroundMode = backgroundMode || this.inferWorkBackgroundMode(consistencyNotes);
    const normalizedSubjectType = this.getWorkSubjectType(subjectType);
    return [
      normalizedSubjectType === 'brows'
        ? (prompts.work_brow_collage_generation ?? DEFAULT_PROMPTS.work_brow_collage_generation)
        : (prompts.work_collage_generation ?? DEFAULT_PROMPTS.work_collage_generation),
      normalizedBackgroundMode === 'neutral'
        ? 'Final collage background rule: every panel must keep the clean neutral light studio background treatment. Do not reintroduce salon interior details, mirrors, shelves, bottles, posters, certificates, windows, or readable background text.'
        : normalizedBackgroundMode === 'blur'
          ? 'Final collage background rule: every panel must keep the real room only as an extremely strong soft blur. Do not let the salon interior become detailed, recognizable, or readable again.'
          : 'Final collage background rule: preserve the original room structure, but keep it visibly calmer and less distracting. Any background text must remain unreadable.',
      cleanupMode === 'on'
        ? 'Final collage cleanup rule: keep distracting clutter, bottles, tools, cords, shelf junk, posters, certificates, and busy reflections cleaned up or visually minimized across all panels. If blur is selected, the cleaned background must still remain strongly blurred.'
        : '',
      promptMode === 'test'
        ? 'Test mode collage rule: keep the haircut clearly separated from the background with a subtle professional contour relight, but avoid any cutout, pasted, or floating look.'
        : '',
      normalizedSubjectType === 'brows'
        ? 'Eyebrow collage rule: keep eyebrows and eye area readable in every panel and do not zoom out into a wide salon scene.'
        : '',
      normalizedSubjectType === 'brows' && browOutputMode === 'before_after'
        ? 'Eyebrow before/after collage rule: preserve the before-versus-after eyebrow comparison in every panel. Do not collapse the result into after-only frames.'
        : '',
      consistencyNotes ? `Locked album facts:\n${consistencyNotes}` : '',
    ].filter(Boolean).join('\n');
  }

  async runWorkImagePass({
    inputAsset,
    prompt,
    jobId,
    index,
    revision = null,
    pass,
    renderMode = 'separate',
    sourceAssetCount = 1,
  }) {
    const result = await this.openrouter.generateImages({
      prompt,
      imageUrls: [await this.toModelImageUrl(inputAsset)].filter(Boolean),
      imageConfig: this.getWorkImageConfig(pass),
      metadata: {
        source_type: 'work',
        job_id: jobId,
        asset_index: index,
        revision,
        model: this.env.imageModelId,
        pass,
        render_mode: renderMode,
        source_asset_count: sourceAssetCount,
      },
    });
    const generatedSource = result.images[0];
    if (!generatedSource) {
      throw new Error(`OpenRouter did not return a work image for pass ${pass}`);
    }
    return {
      asset: await this.resolveRemoteImage(generatedSource),
      durationMs: result.durationMs ?? 0,
    };
  }

  isTopicSourceStatusMutationsEnabled() {
    return Boolean(this.env?.topicSourceStatusMutationsEnabled);
  }

  buildTopicUserPrompt(topic) {
    return [
      `Title: ${topic?.title ?? ''}`,
      `Brief: ${topic?.brief ?? ''}`,
      `Tags: ${Array.isArray(topic?.tags) ? topic.tags.join(', ') : topic?.tags ?? ''}`,
    ].join('\n');
  }

  buildTopicImagePrompt(topic, prompts) {
    const visualMode = this.pickTopicVisualMode(topic);
    return [
      prompts.topic_image_generation,
      this.buildTopicVisualModePrompt(visualMode),
      TOPIC_SALON_INTERIOR_GUIDANCE,
      this.buildTopicUserPrompt(topic),
    ].join('\n');
  }

  getTopicLikeModeConfig(jobType) {
    return TOPIC_LIKE_MODE_CONFIG[jobType] ?? null;
  }

  getTopicLikeModeByCommand(command) {
    return Object.entries(TOPIC_LIKE_MODE_CONFIG)
      .find(([, config]) => config.command === command)?.[0] ?? null;
  }

  getPickerSessionId(chatId, jobType) {
    return `picker:${jobType}:${chatId}`;
  }

  truncatePickerLabel(text, limit = 52) {
    const value = String(text ?? '').trim();
    if (!value) {
      return 'Без названия';
    }
    if (value.length <= limit) {
      return value;
    }
    return `${value.slice(0, Math.max(0, limit - 1)).trim()}…`;
  }

  getTopicLikeSourceSheet(jobType) {
    return this.getTopicLikeModeConfig(jobType)?.sourceSheetName ?? null;
  }

  async getSourceRowByTopicId(sheetName, topicId) {
    if (!sheetName || !topicId) {
      return null;
    }
    if (typeof this.store.getRowByQuery === 'function') {
      return this.store.getRowByQuery(sheetName, {
        eq: { topic_id: topicId },
      });
    }
    const rows = await this.store.getRows(sheetName);
    return rows.find((item) => item.topic_id === topicId) ?? null;
  }

  async getQueueRowByJobId(jobId) {
    if (!jobId) {
      return null;
    }
    if (typeof this.repos.getQueueRowByJobId === 'function') {
      return this.repos.getQueueRowByJobId(jobId);
    }
    if (typeof this.store.getRowByQuery === 'function') {
      return this.store.getRowByQuery(SHEET_NAMES.contentQueue, {
        eq: { job_id: jobId },
      });
    }
    const rows = await this.store.getRows(SHEET_NAMES.contentQueue);
    return rows.find((row) => row.job_id === jobId) ?? null;
  }

  logDurationBestEffort(entry, startedAt, payload = null) {
    this.logEventBestEffort({
      ...entry,
      durationMs: Math.max(0, Date.now() - startedAt),
      ...(payload ? { payload } : {}),
    });
  }

  isExpiredSourceReservation(row = {}) {
    const reclaimed = reclaimExpiredTopic({
      ...row,
      reserved_until: row.reservation_expires_at,
      reserved_by_job_id: row.reserved_by,
    });
    return reclaimed.status !== row.status;
  }

  async reclaimExpiredSourceRow(sheetName, row) {
    if (!row || !this.isExpiredSourceReservation(row)) {
      return row;
    }
    const nextRow = {
      ...row,
      status: 'ready',
      reserved_by: '',
      reserved_at: '',
      reservation_expires_at: '',
    };
    await this.store.updateRowByNumber(
      sheetName,
      row.__rowNumber,
      nextRow,
      SHEET_HEADERS[sheetName],
    );
    return nextRow;
  }

  async ensureSourceRowReserved(sheetName, topicId, jobId) {
    if (!this.isTopicSourceStatusMutationsEnabled()) {
      return;
    }
    if (!sheetName || !topicId || !jobId) {
      return;
    }

    const row = await this.getSourceRowByTopicId(sheetName, topicId);
    if (!row || String(row.status ?? '').toLowerCase() === 'published') {
      return;
    }

    await this.store.updateRowByNumber(
      sheetName,
      row.__rowNumber,
      {
        ...row,
        status: 'reserved',
        reserved_by: jobId,
        reserved_at: row.reserved_at || nowIso(),
        reservation_expires_at: row.reservation_expires_at || addMinutes(new Date(), TOPIC_RESERVATION_MINUTES),
        last_job_id: jobId,
      },
      SHEET_HEADERS[sheetName],
    );
  }

  buildTopicVisualModePrompt(mode) {
    const promptsByMode = {
      exact_salon_room: [
        'Visual planner mode: exact_salon_room.',
        'Keep the salon room as close to the references as possible.',
        'Preserve the same black-and-white checkered floor pattern, the same mirror shapes, the same diploma placement between mirrors, the same black chairs, and the same room proportions.',
        'Allowed change: only camera angle, crop, distance, or focus inside the same room.',
      ],
      exact_salon_closeup: [
        'Visual planner mode: exact_salon_closeup.',
        'Stay inside the exact same salon, but move closer to one working zone or object.',
        'The room still needs to be recognisable by floor pattern, mirrors, diplomas, chair geometry, and furniture language.',
        'Do not turn this into a different salon or abstract beauty studio.',
      ],
      neutral_nonhuman_object: [
        'Visual planner mode: neutral_nonhuman_object.',
        'A non-human object-first scene is allowed when the topic is better explained through tools, products, towels, brushes, or routine details.',
        'Do not use faces, people, or finished hairstyles as the hero subject.',
      ],
    };
    return (promptsByMode[mode] ?? promptsByMode.exact_salon_closeup).join(' ');
  }

  pickTopicVisualMode(topic) {
    const haystack = [
      topic?.title ?? '',
      topic?.brief ?? '',
      Array.isArray(topic?.tags) ? topic.tags.join(', ') : topic?.tags ?? '',
    ].join(' ').toLowerCase();

    if (/(чек|топ|подбор|средств|набор|что\s+нужно|что\s+купить|ошибк|термо|маск|шампун|кондиционер|спрей|масл|расчес|щетк|диффуз|полотенц)/u.test(haystack)) {
      return 'neutral_nonhuman_object';
    }
    if (/(салон|рабоч|кресл|зеркал|интерьер|уголок|место)/u.test(haystack)) {
      return 'exact_salon_room';
    }
    return 'exact_salon_closeup';
  }

  pickStoryBackgroundStyle(seedSource = '') {
    const seed = String(seedSource ?? '');
    let hash = 0;
    for (let index = 0; index < seed.length; index += 1) {
      hash = ((hash * 31) + seed.charCodeAt(index)) >>> 0;
    }

    const variants = ['clear', 'light_blur', 'soft_blur'];
    return variants[hash % variants.length] ?? 'light_blur';
  }

  isWeakStoryBrief(brief = '') {
    const value = String(brief ?? '').trim().toLowerCase();
    if (!value) {
      return true;
    }

    if (/[;|]/u.test(value)) {
      return true;
    }

    const weakMarkers = [
      'тема про',
      'это тема',
      'это про',
      'короткая тема',
      'короткая памятка',
      'проверка нового режима',
      'проверка публикации',
      'помогает цвету и длине выглядеть аккуратно',
      'короткое объяснение',
      'подборка по теме',
    ];

    return weakMarkers.some((marker) => value.startsWith(marker) || value.includes(marker));
  }

  getStoryVoiceLead(sourceRow = {}) {
    const seed = String(sourceRow?.title ?? sourceRow?.topic_id ?? '');
    const variants = [
      'Если коротко,',
      'Часто слышу этот вопрос.',
      'Я бы сказала так:',
      'По опыту скажу так:',
    ];
    const index = [...seed].reduce((sum, char) => sum + char.charCodeAt(0), 0) % variants.length;
    return variants[index];
  }

  hasStoryFirstPerson(text = '') {
    return /\b(я|мне|у меня|я бы|я обычно|я всегда|скажу|слышу)\b/iu.test(String(text ?? ''));
  }

  lowercaseStoryLead(text = '') {
    const value = String(text ?? '').trim();
    if (!value) {
      return value;
    }
    return value.charAt(0).toLowerCase() + value.slice(1);
  }

  humanizeStoryBody(body = '', sourceRow = {}) {
    const value = String(body ?? '').trim().replace(/\s+/gu, ' ');
    if (!value || this.hasStoryFirstPerson(value)) {
      return value;
    }

    const lead = this.getStoryVoiceLead(sourceRow);
    if (lead.endsWith(',') || lead.endsWith(':')) {
      return `${lead} ${this.lowercaseStoryLead(value)}`.trim();
    }
    return `${lead} ${value}`.trim();
  }

  isWeakCreativeSubhead(text = '') {
    const value = String(text ?? '').trim().toLowerCase();
    if (!value) {
      return true;
    }
    if (value.split(/\s+/u).length < 4) {
      return true;
    }
    return [
      'ироничный креатив про',
      'креатив про',
      'тема про',
      'это про',
      'короткий креатив',
      'идея про',
      'шутка про',
      'ирония про',
    ].some((marker) => value.startsWith(marker) || value.includes(marker));
  }

  buildCreativeFallbackSubhead(sourceRow) {
    const title = String(sourceRow?.title ?? '').toLowerCase();
    const tags = parseTags(sourceRow?.tags);
    const signal = `${title} ${tags.join(' ').toLowerCase()}`.trim();

    if (signal.includes('термо') || signal.includes('утюж') || signal.includes('фен')) {
      return 'Когда жара в уходе становится слишком частой, длина это замечает раньше всех.';
    }

    if (signal.includes('окраш') || signal.includes('цвет')) {
      return 'Иногда цвет устаёт не от краски, а от того, как с ним живут дома потом.';
    }

    if (signal.includes('сух') || signal.includes('ломк') || signal.includes('длин')) {
      return 'Сухая длина чаще просит не магии, а пары простых привычек без перегруза.';
    }

    return 'Иногда вся разница между красивым видом и уставшей длиной сидит в одной привычке.';
  }

  normalizeCreativeBullets(items = []) {
    const list = Array.isArray(items) ? items : [];
    return list
      .flatMap((item) => String(item ?? '').split(/\n+/u))
      .map((item) => this.normalizeOverlayBullet(item))
      .filter(Boolean)
      .filter((item) => item.length > 6)
      .slice(0, 2);
  }

  normalizeOverlayBullet(item = '') {
      const cleaned = String(item ?? '')
        .replace(/\r/gu, '')
        .replace(/^[•●◦▪▸►‣–—−‑-]+\s*/u, '')
        .replace(/^\(?\d{1,2}[.)]\s*/u, '')
        .replace(/\s+/gu, ' ')
        .replace(/[;]+/gu, ', ')
        .trim();
    return this.normalizeDisplaySentenceCase(this.simplifyEverydayHairText(cleaned));
  }

  capitalizeOverlayText(text = '') {
      const value = String(text ?? '').trim();
      if (!value) {
        return '';
      }
      return value.replace(/^([«"(\[]*\s*)([a-zа-яё])/iu, (_, prefix, letter) => `${prefix}${letter.toUpperCase()}`);
  }

  normalizeDisplaySentenceCase(text = '') {
      const value = String(text ?? '').trim();
      if (!value) {
        return '';
      }

      const words = value.split(/\s+/u);
      const titleCaseWords = words.filter((word) => /^[«"(\[]*[А-ЯЁ][а-яё-]+[.,!?)]*$/u.test(word)).length;
      const looksLikeTitleCase = words.length >= 2 && titleCaseWords >= Math.max(2, Math.ceil(words.length * 0.6));

      if (!looksLikeTitleCase) {
        return this.capitalizeOverlayText(value);
      }

      const normalized = words.map((word, index) => {
        if (!/[А-ЯЁа-яё]/u.test(word)) {
          return word;
        }
        if (/[A-Za-z]/u.test(word) || /^[А-ЯЁ]{2,}$/u.test(word)) {
          return index === 0 ? this.capitalizeOverlayText(word) : word;
        }

        const lower = word.replace(/[А-ЯЁа-яё-]+/gu, (chunk) => chunk.toLocaleLowerCase('ru-RU'));
        return index === 0
          ? lower.replace(/^([«"(\[]*\s*)([а-яё])/u, (_, prefix, letter) => `${prefix}${letter.toUpperCase()}`)
          : lower;
      }).join(' ');

      return this.capitalizeOverlayText(normalized);
  }

  simplifyEverydayHairText(text = '') {
      return String(text ?? '')
      .replace(/коже головы и длине/giu, 'коже головы и волосам')
      .replace(/корни и длина/giu, 'корни и волосы')
      .replace(/сама длина/giu, 'сами волосы')
      .replace(/сухая длина/giu, 'сухие волосы')
      .replace(/окрашенная длина/giu, 'окрашенные волосы')
      .replace(/по длине волос/giu, 'на волосы')
      .replace(/по длине и концам/giu, 'на волосы, особенно от середины к концам')
      .replace(/по длине/giu, 'на волосы')
      .replace(/длина остаётся/giu, 'волосы остаются')
      .replace(/длина теряет/giu, 'волосы теряют')
      .replace(/длина собирает/giu, 'волосы собирают')
      .replace(/длина выглядит/giu, 'волосы выглядят')
      .replace(/длина быстрее/giu, 'волосы быстрее')
      .replace(/длине /giu, 'волосам ')
      .replace(/длину/giu, 'волосы')
      .replace(/длина/giu, 'волосы')
      .replace(/длиной/giu, 'волосами')
      .replace(/щётка/giu, 'расчёска')
      .replace(/щетк/giu, 'расческ')
        .replace(/закрывает кутикулу/giu, 'сглаживает внешний слой волоса')
        .replace(/закрыть кутикулу/giu, 'сгладить внешний слой волоса')
        .replace(/кутикулу/giu, 'внешний слой волоса')
        .replace(/себум/giu, 'кожный жир');
  }

  getOverlayGlossaryEntries() {
      return [
        ['себум', 'Себум — это кожный жир, который вырабатывает кожа головы.'],
        ['кутикул', 'Кутикула — это внешний слой волоса, который отвечает за гладкость и блеск.'],
        ['полотно', 'Полотно — это основная длина волос, без акцента на корни и концы.'],
        ['детокс-шампун', 'Детокс-шампунь — это более глубоко очищающий шампунь для снятия накоплений ухода и себума.'],
        ['несмываем', 'Несмываемый уход — это спрей, крем, лосьон или флюид, который оставляют на волосах после мытья.'],
        ['термозащит', 'Термозащита — это средство, которое снижает пересушивание волос от фена и горячих инструментов.'],
      ];
  }

  buildOverlayGlossaryHaystack(...parts) {
      return parts
        .flatMap((part) => Array.isArray(part) ? part : [part])
        .map((item) => String(item ?? '').toLowerCase())
        .join('\n');
  }

  buildOverlayGlossaryFooter(...parts) {
      const glossary = this.getOverlayGlossaryEntries();

      const haystack = this.buildOverlayGlossaryHaystack(...parts);

      const lines = glossary
        .filter(([needle]) => haystack.includes(needle))
        .map(([, explanation]) => explanation);

      return lines.join('\n');
  }

  normalizeExplicitOverlayFooter(existingFooter = '', ...parts) {
      const explicit = String(existingFooter ?? '').trim();
      if (!explicit) {
        return '';
      }

      const haystack = this.buildOverlayGlossaryHaystack(...parts);
      const glossary = this.getOverlayGlossaryEntries();

      const lines = explicit
        .split(/\n+/u)
        .map((line) => this.normalizeSliderText(line))
        .map((line) => this.capitalizeOverlayText(line))
        .filter(Boolean)
        .filter((line) => {
          const lower = line.toLowerCase();
          const glossaryEntry = glossary.find(([needle, explanation]) => lower.includes(needle) || lower === explanation.toLowerCase());
          return glossaryEntry ? haystack.includes(glossaryEntry[0]) : false;
        });

      return [...new Set(lines)].join('\n');
  }

  mergeOverlayFooter(existingFooter = '', ...parts) {
      const explicit = this.normalizeExplicitOverlayFooter(existingFooter, ...parts);
      const glossary = this.buildOverlayGlossaryFooter(...parts);
      return [...new Set([explicit, glossary].filter(Boolean).flatMap((chunk) => chunk.split(/\n+/u).map((line) => line.trim()).filter(Boolean)))]
        .join('\n')
        .trim();
  }

  splitDisplaySentences(text = '') {
      return String(text ?? '')
        .split(/(?<=[.!?…])\s+/u)
        .map((item) => item.trim())
        .filter(Boolean);
  }

  looksLikeInlineTermDefinition(sentence = '') {
      const value = String(sentence ?? '').trim().toLowerCase();
      if (!value) {
        return false;
      }
      const hasGlossaryNeedle = this.getOverlayGlossaryEntries().some(([needle]) => value.includes(needle));
      return hasGlossaryNeedle && /(?:—|-)\s*это\b/u.test(value);
  }

  removeInlineTermDefinition(text = '') {
      const sentences = this.splitDisplaySentences(text);
      if (sentences.length === 0) {
        return '';
      }

      const filtered = sentences.filter((sentence) => !this.looksLikeInlineTermDefinition(sentence));

      return filtered.join(' ').trim();
  }

  normalizeCompareText(text = '') {
      return String(text ?? '')
        .toLowerCase()
        .replace(/^\d+\.\s*/u, '')
        .replace(/[«»"“”'.,:;!?()\-—]/gu, ' ')
        .replace(/\s+/gu, ' ')
        .trim();
  }

  dedupeRepeatedPhrase(title = '', body = '') {
      const normalizedTitle = this.normalizeCompareText(title);
      const sentences = this.splitDisplaySentences(body);
      if (!normalizedTitle || sentences.length <= 1) {
        return body;
      }

      const filtered = [...sentences];
      const first = this.normalizeCompareText(filtered[0]);
      if (first && (first.startsWith(normalizedTitle) || first.includes(normalizedTitle))) {
        filtered.shift();
      }

      return filtered.join(' ').trim() || body;
  }

  normalizeDisplayBody(text = '', { title = '' } = {}) {
      const simplified = this.normalizeSliderText(text);
      const withoutDefinitions = this.removeInlineTermDefinition(simplified);
      const base = withoutDefinitions || (this.looksLikeInlineTermDefinition(simplified) ? '' : simplified);
      const deduped = this.dedupeRepeatedPhrase(title, base);
      return this.capitalizeOverlayText(deduped || base || '');
  }

  getSliderSemanticKey(...parts) {
    const value = this.normalizeCompareText(parts.filter(Boolean).join(' '));
    if (!value) {
      return '';
    }
    if (/несмываем|спрей|лосьон|флюид|крем\b/u.test(value)) {
      return 'leave_in';
    }
    if (/кондиционер/u.test(value)) {
      return 'conditioner';
    }
    if (/маск/u.test(value)) {
      return 'mask';
    }
    if (/шампун/u.test(value)) {
      return 'shampoo';
    }
    if (/термозащит|фен|утюж|горяч/u.test(value)) {
      return 'heat_protect';
    }
    if (/расчес|расч[eё]сыван/u.test(value)) {
      return 'combing';
    }
    if (/рук|касан|лиц/u.test(value)) {
      return 'hands_off';
    }
    if (/свеж|жирн|чист/u.test(value)) {
      return 'freshness';
    }
    return value.split(/\s+/u).slice(0, 4).join(' ');
  }

  normalizeCreativeManifest(manifest, sourceRow) {
      const headline = String(manifest.headline ?? manifest.title ?? sourceRow.title ?? '').trim();
    const subheadCandidates = [
      manifest.subhead,
      manifest.body,
      manifest.support,
      manifest.description,
      sourceRow.brief,
    ];
    const subheadRaw = subheadCandidates
      .map((item) => String(item ?? '').trim())
      .find(Boolean) ?? '';
      const normalizedSubhead = this.normalizeDisplayBody(subheadRaw, { title: headline });
      const subhead = this.isWeakCreativeSubhead(normalizedSubhead)
        ? this.buildCreativeFallbackSubhead(sourceRow)
        : normalizedSubhead;
      const bullets = this.normalizeCreativeBullets(manifest.bullets ?? manifest.points ?? []);

      return {
        eyebrow: '',
        headline: this.capitalizeOverlayText(this.normalizeSliderText(headline)),
        subhead,
        bullets,
        footer: this.mergeOverlayFooter(
          String(manifest.footer ?? manifest.closing ?? '').trim(),
          this.capitalizeOverlayText(this.normalizeSliderText(headline)),
          subhead,
          bullets,
        ),
      };
  }

  isWeakSliderCopy(text = '') {
    const value = String(text ?? '').trim().toLowerCase();
    if (!value) {
      return true;
    }
    if (/[;|]/u.test(value)) {
      return true;
    }
    return [
      'небольшая карусель',
      'карусель о',
      'тема про',
      'это про',
      'короткая карусель',
      'повседневных действиях',
    ].some((marker) => value.startsWith(marker) || value.includes(marker));
  }

  getSliderScenario(sourceRow) {
    const title = String(sourceRow?.title ?? '').toLowerCase();
    const tags = parseTags(sourceRow?.tags);
    const signal = `${title} ${tags.join(' ').toLowerCase()}`.trim();

    if (signal.includes('баз') || signal.includes('набор') || signal.includes('средств') || signal.includes('дома') || signal.includes('домаш')) {
      return 'basic_set';
    }

    if (signal.includes('чищ') || signal.includes('свеж') || signal.includes('жир')) {
      return 'freshness';
    }

    if (signal.includes('окраш') || signal.includes('цвет') || signal.includes('мягк')) {
      return 'color_care';
    }

    if (signal.includes('термо') || signal.includes('фен') || signal.includes('утюж')) {
      return 'heat_protection';
    }

    if (
      signal.includes('constant delight')
      || signal.includes('constanta delight')
      || signal.includes('чем работ')
      || signal.includes('что использ')
      || signal.includes('какую косметик')
      || signal.includes('какой шампун')
    ) {
      return 'master_products';
    }

    return 'generic';
  }

  buildSliderCoverSubtitle(sourceRow) {
    switch (this.getSliderScenario(sourceRow)) {
      case 'basic_set':
        return 'Если дома держать шампунь, кондиционер, маску и несмываемый уход, например спрей, крем или лосьон, уже закрываются очищение, мягкость, питание и защита длины без лишних баночек.';
      case 'freshness':
        return 'Когда корни и длина получают разный уход, волосы дольше выглядят чище, а сама длина остаётся мягкой и аккуратной без тяжести.';
      case 'color_care':
        return 'После окрашивания мягкость держится дольше, если дома оставить мягкое мытьё, кондиционер после каждого мытья, маску по необходимости и меньше перегрева.';
      case 'heat_protection':
        return 'Даже обычный фен пересушивает длину, если сушить волосы слишком жарко. Здесь собрала короткую схему, как этого не допускать каждый день.';
      case 'master_products':
        return 'Когда спрашивают, чем я бы закрыла базовый уход дома, я всегда смотрю на мягкое очищение, уход по длине, питание без перегруза и защиту под фен.';
      default:
        return 'Здесь собрала короткую рабочую схему по теме: без воды, но с понятным объяснением, что делать и зачем это нужно волосам.';
    }
  }

  buildSliderCoverBullets(sourceRow, slides = []) {
    const scenario = this.getSliderScenario(sourceRow);
    const slideTitles = Array.isArray(slides)
      ? slides
        .map((slide) => this.normalizeOverlayBullet(slide?.title ?? ''))
        .filter(Boolean)
      : [];

    if (scenario !== 'basic_set' && slideTitles.length >= 3) {
      return slideTitles.slice(0, 4);
    }

    switch (scenario) {
      case 'basic_set':
        return [
          'Шампунь по коже головы',
          'Кондиционер после каждого мытья',
          'Маска 1-2 раза в неделю',
          'Несмываемый уход по длине, например спрей или крем',
        ];
      case 'freshness':
        return [
          'Шампунь по коже головы',
          'Кондиционер только по длине',
          'Меньше касаний руками',
          'Чистая щётка',
        ];
      case 'color_care':
        return [
          'Мягкое мытьё',
          'Кондиционер после каждого мытья',
          'Маска 1-2 раза в неделю',
          'Меньше перегрева',
        ];
      case 'heat_protection':
        return [
          'Термозащита перед феном',
          'Не греть одну зону',
          'Средний нагрев',
          'Внимание к концам',
        ];
      case 'master_products':
        return [
          'Мягкий шампунь',
          'Кондиционер как база',
          'Маска без перегруза',
          'Защита под фен',
        ];
      default:
        return [];
    }
  }

  buildSliderFallbackSlides(sourceRow) {
    switch (this.getSliderScenario(sourceRow)) {
      case 'basic_set':
      return [
        {
          eyebrow: 'Шаг 1',
          title: '1. Шампунь',
          body: 'Шампунь отвечает за чистую кожу головы и мягкое очищение без ощущения сухости или тяжести по длине.',
          bullets: [
            'Подбирайте по коже головы, а не по длине волос.',
            'Для базы дома лучше мягкое очищение без агрессивного скрипа.',
          ],
        },
        {
          eyebrow: 'Шаг 2',
          title: '2. Кондиционер',
          body: 'Кондиционер сглаживает длину после шампуня, делает волосы мягче и помогает им меньше путаться после каждого мытья.',
          bullets: [
            'Наносите после каждого мытья, но только по длине и концам.',
            'Если волосы быстро утяжеляются, на корни его лучше не поднимать.',
          ],
        },
        {
          eyebrow: 'Шаг 3',
          title: '3. Маска',
          body: 'Маска даёт более глубокое питание и поддерживает сухую или окрашенную длину, когда обычного кондиционера уже становится мало.',
          bullets: [
            'Обычно хватает 1-2 раз в неделю вместо кондиционера.',
            'Если волосы тонкие, держите меньше по времени и не наносите на корни.',
          ],
        },
        {
          eyebrow: 'Шаг 4',
          title: '4. Несмываемый уход',
          body: 'Несмываемый уход, например спрей, крем или лосьон, снимает пушение, облегчает расчёсывание и помогает длине дольше выглядеть гладкой и собранной каждый день.',
          bullets: [
            'Крем или спрей выбирайте по плотности волос и задаче.',
            'Перед феном он часто работает и как защита, и как уход по длине.',
          ],
        },
      ];
      case 'freshness':
      return [
        {
          eyebrow: 'Шаг 1',
          title: 'Шампунь по коже головы',
          body: 'Корни дольше выглядят свежими, если шампунь подбираете именно под кожу головы, а не по обещаниям для длины.',
          bullets: [
            'Если кожа жирнится быстро, слишком мягкий шампунь не всегда справляется.',
            'Длину отдельно тереть шампунем не нужно, ей обычно хватает пены при смывании.',
          ],
        },
        {
          eyebrow: 'Шаг 2',
          title: 'Меньше касаний руками',
          body: 'Чем чаще трогают волосы в течение дня, тем быстрее длина теряет аккуратный вид и собирает всё лишнее.',
          bullets: [
            'Если постоянно поправлять пряди у лица, чистота уходит заметно быстрее.',
          ],
        },
        {
          eyebrow: 'Шаг 3',
          title: 'Кондиционер только по длине',
          body: 'Так волосы остаются мягкими, но корни не утяжеляются раньше времени и не теряют свежесть к вечеру.',
          bullets: [
            'По корням кондиционер и плотные маски лучше не распределять.',
          ],
        },
        {
          eyebrow: 'Шаг 4',
          title: 'Чистая щётка тоже важна',
          body: 'Щётка быстро возвращает на волосы всё, что на ней накопилось, поэтому уход работает хуже, чем мог бы.',
          bullets: [
            'Щётку и расчёску лучше мыть регулярно, особенно если пользуетесь несмываемым уходом.',
          ],
        },
      ];
      case 'color_care':
      return [
        {
          eyebrow: 'Шаг 1',
          title: 'Мягкое мытьё',
          body: 'После окрашивания длину проще сохранить мягкой, если шампунь очищает спокойно и не пересушивает полотно.',
          bullets: [
            'Слишком жёсткое очищение быстрее съедает и мягкость, и красивый блеск.',
          ],
        },
        {
          eyebrow: 'Шаг 2',
          title: 'Кондиционер каждый раз',
          body: 'Кондиционер помогает длине оставаться более гладкой, мягкой и меньше путаться уже после каждого мытья.',
          bullets: [
            'Это базовый шаг, который после окрашивания лучше не пропускать.',
          ],
        },
        {
          eyebrow: 'Шаг 3',
          title: 'Маска без перегруза',
          body: 'Маска поддерживает сухую длину глубже, но чаще всего достаточно 1-2 раз в неделю без лишнего утяжеления.',
          bullets: [
            'Если волосы тонкие, наносите меньше и держите умеренно по времени.',
          ],
        },
        {
          eyebrow: 'Шаг 4',
          title: 'Меньше жара',
          body: 'Чем аккуратнее с феном и утюжком, тем дольше цвет и сама длина выглядят живыми и аккуратными.',
          bullets: [
            'Термозащита и средний нагрев здесь работают лучше, чем сильный жар каждый день.',
          ],
        },
      ];
      case 'heat_protection':
      return [
        {
          eyebrow: 'Шаг 1',
          title: 'Защита перед феном',
          body: 'Термозащита нужна не только под утюжок. Фен и горячий воздух тоже постепенно сушат длину и делают её жёстче.',
          bullets: [
            'Наносить её удобнее на влажную длину перед сушкой.',
          ],
        },
        {
          eyebrow: 'Шаг 2',
          title: 'Не грейте одну зону',
          body: 'Если долго держать горячий воздух в одном месте, длина быстрее теряет мягкость и начинает сильнее пушиться.',
          bullets: [
            'Фен лучше двигать, а не держать в одной точке.',
          ],
        },
        {
          eyebrow: 'Шаг 3',
          title: 'Средний нагрев лучше',
          body: 'Для повседневной сушки среднего режима обычно достаточно, особенно если не нужна жёсткая укладка.',
          bullets: [
            'Сильный жар лучше оставлять только под конкретную задачу.',
          ],
        },
        {
          eyebrow: 'Шаг 4',
          title: 'Концы берегите сильнее',
          body: 'Именно концы чаще всего первыми теряют мягкость, блеск и начинают выглядеть пересушенными.',
          bullets: [
            'На эту зону уход и защита почти всегда нужны чуть внимательнее.',
          ],
        },
      ];
      case 'master_products':
        return [
          {
            eyebrow: 'Шаг 1',
            title: 'Мягкий шампунь',
            body: 'Когда спрашивают, чем я бы закрыла базу дома, я сначала смотрю на мягкий шампунь, который чисто работает по коже головы и не сушит длину.',
            bullets: [
              'Из рабочих линеек мне часто нравятся спокойные формулы Constant Delight.',
              'Но сам шампунь всё равно подбираю под кожу головы, а не под концы.',
            ],
          },
          {
            eyebrow: 'Шаг 2',
            title: 'Кондиционер как база',
            body: 'Кондиционер собирает длину после мытья обратно в более гладкое и мягкое состояние, поэтому я бы не убирала его из регулярного ухода.',
            bullets: [
              'Это шаг после каждого мытья.',
              'Наносить лучше по длине и концам.',
            ],
          },
          {
            eyebrow: 'Шаг 3',
            title: 'Маска без перегруза',
            body: 'Маска нужна, когда длине уже мало базы и хочется больше питания, но без ощущения тяжёлой плёнки на волосах.',
            bullets: [
              'Обычно достаточно 1-2 раз в неделю.',
              'На тонких волосах важнее не количество, а умеренность.',
            ],
          },
          {
            eyebrow: 'Шаг 4',
            title: 'Защита под фен',
            body: 'Несмываемый уход и защита под фен помогают держать длину более гладкой, меньше пушащейся и легче расчёсываемой каждый день.',
            bullets: [
              'Формат крема или спрея выбирайте по плотности длины.',
              'Перед феном защита особенно важна для концов.',
            ],
          },
        ];
      default:
        return [
          {
            eyebrow: 'Шаг 1',
            title: 'Мягкое очищение',
            body: 'Обычно результат начинается с спокойного мытья без лишней агрессии, особенно если кожа головы быстро реагирует на слишком жёсткий шампунь.',
            bullets: [
              'Шампунь лучше подбирать по состоянию кожи головы.',
              'Длину отдельно тереть шампунем чаще всего не нужно.',
            ],
          },
          {
            eyebrow: 'Шаг 2',
            title: 'Уход по длине',
            body: 'После мытья длине почти всегда нужен кондиционер или другой базовый уход, иначе она быстрее становится сухой и непослушной.',
            bullets: [
              'Если длина сухая, одного шампуня обычно мало.',
              'Кондиционер лучше не поднимать на корни.',
            ],
          },
          {
            eyebrow: 'Шаг 3',
            title: 'Питание по мере необходимости',
            body: 'Когда волосам уже мало базового ухода, маска закрывает этот вопрос лучше, чем постоянное утяжеление каждого этапа.',
            bullets: [
              'Обычно хватает 1-2 раз в неделю.',
              'Лучше точечно, чем каждый день и слишком много.',
            ],
          },
          {
            eyebrow: 'Шаг 4',
            title: 'Защита каждый день',
            body: 'Фен, жара и сухой воздух тоже влияют на длину, даже если укладка кажется лёгкой и уже привычной.',
            bullets: [
              'Если сушите волосы регулярно, защиту лучше не пропускать.',
              'Несмываемый уход помогает держать гладкость дольше.',
            ],
          },
        ];
    }
  }

  normalizeSliderText(text = '') {
    return this.simplifyEverydayHairText(String(text ?? '')
      .replace(/[;]+/gu, ', ')
      .replace(/\s+/gu, ' ')
      .trim());
  }

  alignSliderCoverCount(title = '', slideCount = 0) {
    const normalizedTitle = this.normalizeSliderText(title);
    if (!normalizedTitle || !Number.isFinite(slideCount) || slideCount < 1) {
      return normalizedTitle;
    }

    if (/^\s*(?:топ[-\s]*)?\d+\b/iu.test(normalizedTitle)) {
      return normalizedTitle.replace(/^(\s*(?:топ[-\s]*)?)(\d+)\b/iu, `$1${slideCount}`);
    }

    return normalizedTitle;
  }

  normalizeSliderSlide(slide = {}, sourceRow = {}, index = 0) {
      const title = this.capitalizeOverlayText(this.normalizeSliderText(slide.title ?? ''));
      const body = this.normalizeDisplayBody(slide.body ?? '', { title });
      const bullets = this.normalizeCreativeBullets(slide.bullets ?? []).slice(0, 2);
      return {
        eyebrow: String(slide.eyebrow ?? `Шаг ${index + 1}`).trim(),
        title,
        body,
        bullets,
        footer: this.mergeOverlayFooter(this.normalizeSliderText(slide.footer ?? ''), title, body, bullets),
      };
  }

  normalizeSliderDeckConsistency(sourceRow, deck = {}) {
    const slides = Array.isArray(deck.slides) ? deck.slides.filter(Boolean) : [];
    const coverTitle = this.alignSliderCoverCount(deck.coverTitle ?? sourceRow?.title ?? '', slides.length);
    const coverSubtitle = this.isWeakSliderCopy(deck.coverSubtitle ?? '')
      ? this.buildSliderCoverSubtitle(sourceRow)
      : this.normalizeSliderText(deck.coverSubtitle ?? '');
    const coverBullets = this.buildSliderCoverBullets(sourceRow, slides).slice(0, 4);
    const footer = this.mergeOverlayFooter(deck.footer ?? '', coverTitle, coverSubtitle, coverBullets);

    return {
      eyebrow: '',
      coverTitle,
      coverSubtitle,
      coverBullets,
      slides,
      footer,
    };
  }

  isWeakSliderSlideTitle(text = '') {
    const value = this.normalizeSliderText(text).toLowerCase();
    if (!value) {
      return true;
    }
    return value.split(/\s+/u).length < 2 || ['привычки', 'уход', 'советы', 'шаг', 'набор'].includes(value);
  }

  isWeakSliderSlideBody(text = '') {
    const value = this.normalizeSliderText(text);
    return !value || value.split(/\s+/u).length < 10 || this.isWeakSliderCopy(value);
  }

  buildStoryFallbackBody(sourceRow) {
    const title = String(sourceRow?.title ?? '').toLowerCase();
    const tags = parseTags(sourceRow?.tags);
    const signal = `${title} ${tags.join(' ').toLowerCase()}`.trim();

    if (signal.includes('окраш') || signal.includes('цвет') || signal.includes('мягк')) {
      return 'Часто слышу этот вопрос. После окрашивания я обычно советую оставить мягкий шампунь, кондиционер после каждого мытья и маску пару раз в неделю. Тогда длина остаётся мягче, а цвет не тускнеет раньше времени.';
    }

    if (signal.includes('термо') || signal.includes('фен') || signal.includes('утюж')) {
      return 'Если коротко, термозащита нужна не только под утюжок. Я наношу её и перед феном, потому что горячий воздух тоже сушит длину и со временем делает её жёстче.';
    }

    if (signal.includes('жир') || signal.includes('корн') || signal.includes('свеж')) {
      return 'По опыту скажу так: коже головы и длине часто правда нужен разный уход. Корням важнее хорошее очищение, а длине мягкость и защита, тогда волосы выглядят аккуратнее без лишней тяжести.';
    }

    if (signal.includes('сух') || signal.includes('ломк') || signal.includes('длин')) {
      return 'Я бы сказала так: когда длина сухая, не нужен сложный ритуал. Обычно я советую мягкий шампунь, кондиционер после мытья и одно хорошее несмываемое средство по длине.';
    }

    if (!this.isWeakStoryBrief(sourceRow?.brief)) {
      return this.humanizeStoryBody(String(sourceRow?.brief ?? '').trim(), sourceRow);
    }

    return 'Чаще всего лучше работает спокойный домашний уход без перегруза. Я бы оставила мягкое мытьё, уход по длине и защиту от пересушивания, этого уже хватает для заметного результата.';
  }

  buildStoryFallbackBullets(sourceRow) {
    const title = String(sourceRow?.title ?? '').toLowerCase();
    const tags = parseTags(sourceRow?.tags);
    const signal = `${title} ${tags.join(' ').toLowerCase()}`.trim();

    if (signal.includes('окраш') || signal.includes('цвет') || signal.includes('мягк')) {
      return [
        'После каждого мытья я бы оставила кондиционер по длине.',
        'Слишком очищающий шампунь после окрашивания лучше не брать.',
        'Маску достаточно подключать 1-2 раза в неделю.',
      ];
    }

    if (signal.includes('термо') || signal.includes('фен') || signal.includes('утюж')) {
      return [
        'Перед феном я бы термозащиту не пропускала.',
        'Слишком горячий воздух в одну зону долго не направляйте.',
        'Концы лучше сушить на среднем нагреве.',
      ];
    }

    if (signal.includes('жир') || signal.includes('корн') || signal.includes('свеж')) {
      return [
        'Шампунь подбирайте под кожу головы, а не под длину.',
        'Плотные маски и масла на корни лучше не наносить.',
        'По длине уход нужен отдельно, чтобы она не пересушивалась.',
      ];
    }

    return [
      'Я бы не делала уход слишком сложным без необходимости.',
      'После мытья длине почти всегда нужен кондиционер или бальзам.',
      'Перед сушкой феном термозащиту лучше не пропускать.',
    ];
  }

  normalizeStoryBullets(items = []) {
    const list = Array.isArray(items) ? items : [];
    return list
      .flatMap((item) => String(item ?? '').split(/\n+/u))
      .map((item) => this.normalizeOverlayBullet(item))
      .filter(Boolean)
      .filter((item) => item.length > 6)
      .slice(0, 4);
  }

  normalizeStoryBody(body = '', sourceRow = {}) {
      const raw = String(body ?? '').trim();
      const candidate = this.isWeakStoryBrief(raw) ? this.buildStoryFallbackBody(sourceRow) : this.humanizeStoryBody(raw, sourceRow);
      const simplified = this.normalizeDisplayBody(candidate, { title: sourceRow?.title ?? '' });
      const sentences = simplified
        .split(/(?<=[.!?…])\s+/u)
        .map((item) => item.trim())
      .filter(Boolean);

    if (sentences.length >= 2) {
      return `${sentences[0]} ${sentences[1]}`.trim();
    }
    if (sentences.length === 1) {
      return sentences[0];
    }
    return simplified;
  }

  normalizeStoryManifest(manifest, sourceRow) {
    const bodyCandidates = [
      manifest.body,
      manifest.answer,
      manifest.support,
      manifest.supportLine,
      manifest.subtitle,
      manifest.description,
      sourceRow.brief,
    ];
    const body = bodyCandidates
      .map((item) => String(item ?? '').trim())
      .find(Boolean) ?? '';
    const normalizedBody = this.normalizeStoryBody(body, sourceRow);
    const normalizedBullets = this.normalizeStoryBullets(
      manifest.bullets
      ?? manifest.points
      ?? manifest.tips
      ?? manifest.steps
      ?? manifest.items
      ?? [],
    );

      return {
        eyebrow: '',
        title: this.capitalizeOverlayText(String(manifest.title ?? sourceRow.title ?? '').trim()),
        body: normalizedBody,
        bullets: normalizedBullets.length > 0 ? normalizedBullets : this.buildStoryFallbackBullets(sourceRow),
        footer: this.mergeOverlayFooter(
          String(manifest.footer ?? manifest.closing ?? '').trim(),
          String(manifest.title ?? sourceRow.title ?? '').trim(),
          normalizedBody,
          normalizedBullets.length > 0 ? normalizedBullets : this.buildStoryFallbackBullets(sourceRow),
      ),
    };
  }

  getTopicImageReferenceUrls() {
    return TOPIC_SALON_REFERENCE_IMAGE_URLS;
  }

  async extractAlbumConsistencyNotes({ assets, prompts, jobId, revision = null, subjectType = 'hair' }) {
    if (!Array.isArray(assets) || assets.length <= 1) {
      return '';
    }
    const imageUrls = (await Promise.all((assets ?? []).map((asset) => this.toModelImageUrl(asset))))
      .filter(Boolean)
      .slice(0, 3);
    if (imageUrls.length <= 1) {
      return '';
    }
    try {
      const consistency = await this.openrouter.generateText({
        systemPrompt: this.getWorkSubjectType(subjectType) === 'brows'
          ? (prompts.work_brow_consistency_extraction ?? DEFAULT_PROMPTS.work_brow_consistency_extraction)
          : (prompts.work_album_consistency_extraction ?? DEFAULT_PROMPTS.work_album_consistency_extraction),
        userPrompt: this.getWorkSubjectType(subjectType) === 'brows'
          ? 'Опиши только locked facts, которые должны сохраняться одинаковыми на всех кадрах альбома с бровями.'
          : 'Опиши только locked facts, которые должны сохраняться одинаковыми на всех кадрах альбома.',
        imageUrls,
        temperature: 0.1,
        maxTokens: 220,
        model: this.getWorkTextModelId(),
        metadata: {
          source_type: 'work',
          job_id: jobId,
          revision,
          model: this.getWorkTextModelId(),
          pass: 'consistency',
          source_asset_count: imageUrls.length,
          subject_type: this.getWorkSubjectType(subjectType),
        },
      });
      return String(consistency?.text ?? '').trim();
    } catch (error) {
      if (!this.isEmptyProviderTextError(error)) {
        throw error;
      }
      this.logEventBestEffort({
        level: 'ERROR',
        event: 'consistency_provider_empty',
        stage: 'processing',
        jobId,
        sourceType: 'work',
        status: 'fallback',
        message: error.message,
        payload: {
          revision,
          sourceAssetCount: imageUrls.length,
          model: this.getWorkTextModelId(),
        },
      });
      return '';
    }
  }

  getWorkTextModelId() {
    return PINNED_WORK_TEXT_MODEL_ID;
  }

  async resolveWorkPrompts({ jobId = '', revision = null, sourceAssetCount = 0, renderMode = '', subjectType = 'hair' } = {}) {
    const prompts = await this.promptConfig.refresh();
    let remoteKeys = [];
    let fallbackKeys = [...REQUIRED_WORK_PROMPT_KEYS];
    let missingKeys = [];

    if (typeof this.promptConfig.getWorkPromptCoverage === 'function') {
      const coverage = await this.promptConfig.getWorkPromptCoverage(subjectType);
      remoteKeys = [...(coverage.supabaseKeys ?? [])];
      fallbackKeys = [...(coverage.fallbackKeys ?? [])];
      missingKeys = [...(coverage.missingRequiredKeys ?? [])];
    }

    this.logEventBestEffort({
      event: 'work_prompt_source_resolved',
      stage: 'config',
      jobId,
      sourceType: 'work',
      status: missingKeys.length > 0 ? 'missing_keys' : 'ok',
      message: `remote=${remoteKeys.length} fallback=${fallbackKeys.length}`,
      payload: {
        revision,
        renderMode,
        sourceAssetCount,
        subjectType: this.getWorkSubjectType(subjectType),
        remoteKeys,
        fallbackKeys,
        missingKeys,
      },
    });

    if (missingKeys.length > 0) {
      this.logEventBestEffort({
        level: 'ERROR',
        event: 'work_prompt_misconfigured',
        stage: 'config',
        jobId,
        sourceType: 'work',
        status: 'missing_keys',
        message: missingKeys.join(', '),
        payload: {
          remoteKeys,
          fallbackKeys,
          missingKeys,
        },
      });
    }

    return prompts;
  }

  getCollectionDeadlineAt(currentTime, { mediaGroupId, assetCount }) {
    if (mediaGroupId) {
      const normalizedCount = Number(assetCount);
      if (normalizedCount <= 1) {
        return addSeconds(currentTime, WORK_COLLECTION_INITIAL_ALBUM_GRACE_SECONDS);
      }
      if (normalizedCount < 3) {
        return addSeconds(currentTime, WORK_COLLECTION_PARTIAL_ALBUM_GRACE_SECONDS);
      }
    }
    return addSeconds(currentTime, WORK_COLLECTION_DEBOUNCE_SECONDS);
  }

  shouldAwaitInlineFinalize({ mediaGroupId, collectionCount }) {
    return !mediaGroupId || Number(collectionCount) > 1;
  }

  async buildFinalWorkPreviewAsset(assets, jobId, prompts = DEFAULT_PROMPTS, consistencyNotes = '', {
    backgroundMode = '',
    cleanupMode = 'off',
    promptMode = 'normal',
    subjectType = 'hair',
    browOutputMode = '',
  } = {}) {
    if (!Array.isArray(assets) || assets.length === 0) {
      throw new Error('No processed work assets available for preview');
    }
    if (assets.length === 1) {
      return {
        finalRenderMode: 'single',
        asset: assets[0],
      };
    }
    const collageImageUrls = await this.buildWorkCollageImageUrls(assets);
    if (collageImageUrls.length !== assets.length) {
      throw new Error('Missing processed work assets for collage composition');
      }
      const collageResult = await this.openrouter.generateImages({
        prompt: this.buildWorkCollagePrompt(prompts, {
          consistencyNotes,
          backgroundMode,
          cleanupMode,
          promptMode,
          subjectType,
          browOutputMode,
        }),
        imageUrls: collageImageUrls,
        imageConfig: this.getWorkImageConfig('compose_collage'),
        metadata: {
        source_type: 'work',
        job_id: jobId,
        model: this.env.imageModelId,
        pass: 'compose_collage',
        source_asset_count: assets.length,
      },
    });
    const generatedSource = collageResult.images[0];
    if (!generatedSource) {
      throw new Error('OpenRouter did not return a composed work collage');
    }
    const asset = await this.resolveRemoteImage(generatedSource);

    return {
      finalRenderMode: 'collage',
      asset,
    };
  }

  buildRevisionEntry({
    revision,
    captionText,
    previewTelegramFileIds,
    finalRenderMode,
    sourceAssetCount,
    createdAt = nowIso(),
  }) {
    return {
      revision,
      captionText,
      previewTelegramFileIds: [...(previewTelegramFileIds ?? [])],
      finalRenderMode,
      sourceAssetCount,
      createdAt,
    };
  }

  getRevisionHistory(payload) {
    return [...(payload?.revisionHistory ?? [])]
      .map((entry) => ({
        ...entry,
        revision: Number(entry.revision ?? 0),
        previewTelegramFileIds: [...(entry.previewTelegramFileIds ?? [])],
        sourceAssetCount: Number(entry.sourceAssetCount ?? 0),
      }))
      .sort((left, right) => left.revision - right.revision);
  }

  getViewedRevision(payload) {
    const revisions = this.getRevisionHistory(payload);
    const requested = Number(payload?.viewRevision ?? payload?.revision ?? revisions.at(-1)?.revision ?? 0);
    return revisions.find((entry) => entry.revision === requested) ?? revisions.at(-1) ?? null;
  }

  buildPreviewKeyboardForRuntime(tokensByAction, options, jobType) {
    const keyboard = buildPreviewKeyboard(tokensByAction, options);
    if (jobType !== 'work' && tokensByAction.publish_confirm) {
      keyboard.row().text('Подтвердить публикацию', `publish_confirm:${tokensByAction.publish_confirm}`);
    }
    return keyboard;
  }

  buildTopicLikePickerKeyboard({
    itemButtons = [],
    prevButton = null,
    nextButton = null,
    cancelButton = null,
  }) {
    const keyboard = new InlineKeyboard();

    for (const item of itemButtons) {
      if (!item?.token || !item?.action) {
        continue;
      }
      keyboard.text(item.label, `${item.action}:${item.token}`).row();
    }

    if (prevButton?.token && prevButton?.action) {
      keyboard.text('← Назад', `${prevButton.action}:${prevButton.token}`);
    }
    if (nextButton?.token && nextButton?.action) {
      keyboard.text('Дальше →', `${nextButton.action}:${nextButton.token}`);
    }
    if (prevButton?.token || nextButton?.token) {
      keyboard.row();
    }

    if (cancelButton?.token && cancelButton?.action) {
      keyboard.text('Отмена', `${cancelButton.action}:${cancelButton.token}`);
    }

    return keyboard;
  }

  createCallbackRows({ jobId, revision, chatId, definitions = [] }) {
    const issuedAt = new Date();
    const rows = [];
    const entries = [];

    for (const definition of definitions) {
      const payload = buildCallbackTokenPayload({
        jobId,
        revision,
        action: definition.action,
        ttlMinutes: CALLBACK_TTL_MINUTES,
        now: issuedAt,
      });
      rows.push({
        token: payload.token,
        token_set_id: payload.tokenSetId,
        job_id: jobId,
        revision,
        action: definition.action,
        used: 0,
        superseded: 0,
        expires_at: payload.expiresAt,
        issued_at: payload.issuedAt,
        payload_json: JSON.stringify({
          chatId,
          ...(definition.payload ?? {}),
        }),
        created_at: nowIso(),
        updated_at: nowIso(),
      });
      entries.push({
        ...definition,
        token: payload.token,
      });
    }

    return {
      tokenRows: rows,
      entries,
      tokenSetId: rows[0]?.token_set_id ?? '',
    };
  }

  async processSingleWorkAsset({
    fileId,
    prompts,
    jobId,
    index,
    revision = null,
    consistencyNotes = '',
    originalAsset = null,
    renderMode = 'separate',
    promptMode = 'normal',
    subjectType = 'hair',
    browOutputMode = 'after_only',
    backgroundMode = '',
    cleanupMode = 'off',
    sourceAssetCount = 1,
    logContext = {},
  }) {
    const original = originalAsset ?? await this.downloadTelegramFile(fileId);
    const logBase = {
      stage: 'processing',
      chatId: logContext.chatId ?? null,
      userId: logContext.userId ?? null,
      jobId,
      queueId: logContext.queueId ?? null,
      collectionId: logContext.collectionId ?? null,
      sourceType: 'work',
      payload: {
        model: this.env.imageModelId,
        assetIndex: index,
        renderMode,
        revision,
        sourceAssetCount,
        promptMode,
        subjectType,
        browOutputMode,
        backgroundMode: backgroundMode || '',
        cleanupMode,
      },
    };
    const normalizedSubjectType = this.getWorkSubjectType(subjectType);
    const normalizedBrowOutputMode = this.getBrowOutputMode(browOutputMode);
    const effectiveBackgroundMode = backgroundMode || this.inferWorkBackgroundMode(consistencyNotes);
    logBase.payload.backgroundMode = effectiveBackgroundMode;
    const editPassBase = effectiveBackgroundMode === 'neutral'
      ? 'edit_neutral'
      : effectiveBackgroundMode === 'keep'
        ? 'edit_keep'
        : 'edit_blur';
    const editPass = normalizedSubjectType === 'brows'
      ? `brow_${editPassBase}`
      : editPassBase;
    const unifiedPrompt = this.buildUnifiedWorkImagePrompt(prompts, {
      consistencyNotes,
      backgroundMode: effectiveBackgroundMode,
      cleanupMode,
      promptMode,
      subjectType: normalizedSubjectType,
      browOutputMode: normalizedBrowOutputMode,
      browPassKind: 'after',
    });

    await this.logEvent({
      ...logBase,
      event: 'image_enhancement_started',
      status: 'started',
      message: `asset=${index + 1}`,
    });

    let processedAsset;
    let editDurationMs = 0;
      try {
        const measuredEdit = await measureDuration(async () => (
          (await this.runWorkImagePass({
          inputAsset: original,
          prompt: unifiedPrompt,
          jobId,
          index,
          revision,
          pass: editPass,
          renderMode,
          sourceAssetCount,
        })).asset
        ));
        processedAsset = measuredEdit.result;
        editDurationMs = measuredEdit.durationMs;
        if (normalizedSubjectType === 'brows' && normalizedBrowOutputMode === 'before_after') {
          const beforeMeasured = await measureDuration(async () => (
            (await this.runWorkImagePass({
              inputAsset: original,
              prompt: this.buildUnifiedWorkImagePrompt(prompts, {
                consistencyNotes,
                backgroundMode: effectiveBackgroundMode,
                cleanupMode,
                promptMode,
                subjectType: normalizedSubjectType,
                browOutputMode: normalizedBrowOutputMode,
                browPassKind: 'before',
              }),
              jobId,
              index,
              revision,
              pass: `${editPass}_before`,
              renderMode,
              sourceAssetCount,
            })).asset
          ));
          processedAsset = await this.buildBeforeAfterPreviewAsset(beforeMeasured.result, processedAsset, `${jobId}-${index}-brows`);
          editDurationMs += beforeMeasured.durationMs;
        }
      } catch (error) {
        const degradedAccept = this.shouldAllowDegradedLocalWorkFallback({
          sourceAssetCount,
          subjectType: normalizedSubjectType,
          backgroundMode: effectiveBackgroundMode,
          cleanupMode,
          promptMode,
        }) && this.isRecoverableWorkImageProviderFailure(error);
        await this.logEvent({
          ...logBase,
          event: 'image_provider_first_pass_failed',
        status: degradedAccept ? 'degraded_accept' : 'failed',
        message: error?.message || `asset=${index + 1}`,
        payload: {
          ...logBase.payload,
          degradedAccept,
            reason: degradedAccept ? 'local_sharp_fallback' : 'provider_failure',
          },
        });
        const shouldRetryWithCompactPrompt = !degradedAccept && this.isRecoverableWorkImageProviderFailure(error);
        if (shouldRetryWithCompactPrompt) {
          const compactPrompt = this.buildCompactWorkImagePrompt({
            backgroundMode: effectiveBackgroundMode,
            cleanupMode,
            promptMode,
            consistencyNotes,
            subjectType: normalizedSubjectType,
            browOutputMode: normalizedBrowOutputMode,
            browPassKind: 'after',
          });
          await this.logEvent({
            ...logBase,
            event: 'image_provider_retry_started',
            status: 'retrying',
            message: error?.message || `asset=${index + 1}`,
            payload: {
              ...logBase.payload,
              retryMode: 'compact_prompt',
            },
          });
          try {
            const retryMeasured = await measureDuration(async () => (
              (await this.runWorkImagePass({
                inputAsset: original,
                prompt: compactPrompt,
                jobId,
                index,
                revision,
                pass: `${editPass}_retry`,
                renderMode,
                sourceAssetCount,
              })).asset
            ));
            processedAsset = retryMeasured.result;
            editDurationMs = retryMeasured.durationMs;
            if (normalizedSubjectType === 'brows' && normalizedBrowOutputMode === 'before_after') {
              const beforeRetryMeasured = await measureDuration(async () => (
                (await this.runWorkImagePass({
                  inputAsset: original,
                  prompt: this.buildCompactWorkImagePrompt({
                    backgroundMode: effectiveBackgroundMode,
                    cleanupMode,
                    promptMode,
                    consistencyNotes,
                    subjectType: normalizedSubjectType,
                    browOutputMode: normalizedBrowOutputMode,
                    browPassKind: 'before',
                  }),
                  jobId,
                  index,
                  revision,
                  pass: `${editPass}_before_retry`,
                  renderMode,
                  sourceAssetCount,
                })).asset
              ));
              processedAsset = await this.buildBeforeAfterPreviewAsset(beforeRetryMeasured.result, processedAsset, `${jobId}-${index}-brows`);
              editDurationMs += beforeRetryMeasured.durationMs;
            }
            await this.logEvent({
              ...logBase,
              event: 'image_provider_retry_succeeded',
              status: 'ok',
              durationMs: editDurationMs,
              message: `asset=${index + 1}`,
              payload: {
                ...logBase.payload,
                retryMode: 'compact_prompt',
                pass: `${editPass}_retry`,
              },
            });
          } catch (retryError) {
            await this.logEvent({
              ...logBase,
              event: 'image_provider_retry_failed',
              status: 'failed',
              message: retryError?.message || `asset=${index + 1}`,
              payload: {
                ...logBase.payload,
                retryMode: 'compact_prompt',
                pass: `${editPass}_retry`,
              },
            });
            throw retryError;
          }
        }
        if (processedAsset) {
          return {
            originalTelegramFileId: fileId,
            asset: processedAsset,
          };
        }
        if (!degradedAccept) {
          throw error;
        }
      const degradedAsset = await this.buildDegradedLocalWorkAsset(original);
      await this.logEvent({
        ...logBase,
        event: 'image_provider_degraded_fallback_applied',
        status: 'degraded',
        message: error?.message || `asset=${index + 1}`,
        payload: {
          ...logBase.payload,
          fallback: 'local_sharp',
        },
      });
      return {
        originalTelegramFileId: fileId,
        asset: degradedAsset,
      };
    }
    await this.logEvent({
      ...logBase,
      event: 'image_edit_completed',
      status: 'ok',
      durationMs: editDurationMs,
      message: `asset=${index + 1}`,
      payload: {
        ...logBase.payload,
        pass: editPass,
        backgroundMode,
      },
    });
    return {
      originalTelegramFileId: fileId,
      asset: processedAsset,
    };
  }

  async sendProgress(chatId, text) {
    return this.sendMessage(chatId, text);
  }

  async logEvent(entry) {
    return this.botLogger.log(entry);
  }

  async logEventBestEffort(entry) {
    const logger = typeof this.botLogger?.logBestEffort === 'function'
      ? this.botLogger.logBestEffort.bind(this.botLogger)
      : this.botLogger?.log?.bind(this.botLogger);
    if (!logger) {
      return;
    }
    logger(entry).catch(() => {});
  }

  getWorkModeStatusText(renderMode) {
    return USER_MESSAGES.generationQueued[renderMode] ?? USER_MESSAGES.workProcessingStarted;
  }

  async upsertControlMessage(chatId, text, {
    existingMessageId = null,
    replyMarkup = null,
  } = {}) {
    if (existingMessageId) {
      try {
        const edited = await this.callTelegram('editMessageText', chatId, existingMessageId, text, {
          reply_markup: replyMarkup,
        });
        return edited?.message_id ?? existingMessageId;
      } catch (error) {
        if (isTelegramMessageNotModifiedError(error)) {
          return existingMessageId;
        }
        if (shouldReplaceTelegramControlMessage(error)) {
          const message = await this.sendMessage(chatId, text, {
            reply_markup: replyMarkup,
          });
          return message.message_id;
        }
        throw error;
      }
    }

    const message = await this.sendMessage(chatId, text, {
      reply_markup: replyMarkup,
    });
    return message.message_id;
  }

  async updateRuntimeStatusMessage(runtime, text) {
    if (runtime?.job_type === 'work') {
      return this.upsertControlMessage(runtime.chat_id, text, {
        existingMessageId: runtime?.text_message_id ?? null,
        replyMarkup: { inline_keyboard: [] },
      });
    }

    if (!runtime?.text_message_id) {
      const message = await this.sendMessage(runtime.chat_id, text);
      return message.message_id;
    }

    const emptyKeyboard = { inline_keyboard: [] };
    const isMediaMessage = runtime.collage_message_id
      && String(runtime.collage_message_id) === String(runtime.text_message_id);
    if (isMediaMessage) {
      const edited = await this.callTelegram('editMessageCaption', runtime.chat_id, runtime.text_message_id, {
        caption: text,
        reply_markup: emptyKeyboard,
      });
      return edited?.message_id ?? runtime.text_message_id;
    }

    const edited = await this.callTelegram('editMessageText', runtime.chat_id, runtime.text_message_id, text, {
      reply_markup: emptyKeyboard,
    });
    return edited?.message_id ?? runtime.text_message_id;
  }

  async queueRuntimeGeneration(runtime, { action, renderMode = '' }) {
    const previousPayload = runtime.draft_payload ?? runtime.preview_payload ?? {};
    const nextPayload = {
      ...previousPayload,
      renderMode: renderMode || previousPayload.renderMode || previousPayload.finalRenderMode || 'collage',
      viewRevision: Number(previousPayload.viewRevision ?? previousPayload.revision ?? runtime.active_revision ?? 0),
    };
    const controlMessageId = await this.updateRuntimeStatusMessage(
      runtime,
      action === 'generate_initial'
        ? this.getWorkModeStatusText(nextPayload.renderMode)
        : USER_MESSAGES.actionMessages[action] || USER_MESSAGES.workProcessingStarted,
    );

    if (runtime.active_callback_set_id) {
      await this.repos.supersedeTokenSet(runtime.active_callback_set_id, nowIso());
    }

    await this.repos.upsertRuntime({
      job_id: runtime.job_id,
      job_type: runtime.job_type,
      chat_id: runtime.chat_id,
      user_id: runtime.user_id,
      topic_id: runtime.topic_id ?? '',
      collection_id: runtime.collection_id ?? '',
      active_revision: runtime.active_revision,
      runtime_status: 'queued_for_generation',
      collage_message_id: toStoredText(runtime.collage_message_id),
      assets_message_ids_json: JSON.stringify(runtime.assets_message_ids ?? []),
      text_message_id: toStoredText(controlMessageId),
      active_callback_set_id: '',
      schedule_input_pending: 0,
      lock_flags_json: JSON.stringify({
        ...(runtime.lock_flags ?? {}),
        queued_action: action,
      }),
      preview_payload_json: JSON.stringify(nextPayload),
      draft_payload_json: JSON.stringify(nextPayload),
      updated_at: nowIso(),
    });

    this.logEventBestEffort({
      event: 'generation_queued',
      stage: 'processing',
      chatId: runtime.chat_id,
      userId: runtime.user_id,
      jobId: runtime.job_id,
      queueId: nextPayload.queueId ?? '',
      collectionId: runtime.collection_id ?? '',
      sourceType: runtime.job_type,
      status: action,
      message: nextPayload.renderMode || action,
      payload: {
        action,
        renderMode: nextPayload.renderMode || '',
        sourceAssetCount: nextPayload.sourceAssetCount ?? 0,
      },
    });

    const dispatchResult = await this.dispatchQueuedRuntimeActionBestEffort(runtime.job_id, action, {
      chatId: runtime.chat_id,
      userId: runtime.user_id,
      queueId: nextPayload.queueId ?? '',
      collectionId: runtime.collection_id ?? '',
      sourceType: runtime.job_type,
      renderMode: nextPayload.renderMode || '',
      sourceAssetCount: nextPayload.sourceAssetCount ?? 0,
    });
    if (dispatchResult.dispatched) {
      return {
        ok: true,
        queued: true,
        inline: false,
        dispatched: true,
      };
    }

    const result = await this.runQueuedGenerationJob(runtime.job_id, action);
    return {
      ok: true,
      dispatched: false,
      queued: false,
      inline: true,
      result,
    };
  }

  async dispatchQueuedRuntimeActionBestEffort(jobId, action, {
    chatId = null,
    userId = null,
    queueId = '',
    collectionId = '',
    sourceType = '',
    renderMode = '',
    sourceAssetCount = 0,
  } = {}) {
    const skipReason = this.getWorkerDispatchSkipReason();
    if (skipReason) {
      this.logEventBestEffort({
        event: 'worker_dispatch_skipped',
        stage: 'processing',
        chatId,
        userId,
        jobId,
        queueId,
        collectionId,
        sourceType,
        status: skipReason,
        message: renderMode || action,
        payload: {
          action,
          renderMode,
          sourceAssetCount,
          reason: skipReason,
          workerPath: '/api/worker/runtime-action',
        },
      });
      return { dispatched: false, reason: skipReason };
    }
    try {
      await dispatchWorkerPayload({
        env: this.env,
        payload: { jobId, action },
        workerPath: '/api/worker/runtime-action',
      });
      this.logEventBestEffort({
        event: 'generation_dispatched',
        stage: 'processing',
        chatId,
        userId,
        jobId,
        queueId,
        collectionId,
        sourceType,
        status: action,
        message: renderMode || action,
        payload: {
          action,
          renderMode,
          sourceAssetCount,
          workerPath: '/api/worker/runtime-action',
        },
      });
      return { dispatched: true };
    } catch (error) {
      if (this.shouldDisableWorkerDispatch(error)) {
        this.workerDispatchDisabledReason = error.message;
      }
      this.logEventBestEffort({
        level: 'ERROR',
        event: 'worker_dispatch_failed',
        stage: 'processing',
        chatId,
        userId,
        jobId,
        queueId,
        collectionId,
        sourceType,
        status: 'failed',
        message: error.message,
        payload: {
          action,
          renderMode,
          sourceAssetCount,
          workerPath: '/api/worker/runtime-action',
        },
      });
      return { dispatched: false, reason: error.message };
    }
  }

  async dispatchCollectionFinalizeAsync(collectionId, {
    chatId = null,
    userId = null,
    collectionIdForLog = '',
    mediaGroupId = '',
    count = 0,
  } = {}) {
    const skipReason = this.getWorkerDispatchSkipReason();
    if (skipReason) {
      this.logEventBestEffort({
        event: 'collection_finalize_dispatch_skipped',
        stage: 'collection',
        chatId,
        userId,
        collectionId: collectionIdForLog || collectionId,
        sourceType: 'work',
        status: skipReason,
        message: `count=${count}`,
        payload: {
          mediaGroupId,
          count,
          reason: skipReason,
          workerPath: '/api/worker/collection-finalize',
        },
      });
      return false;
    }
    try {
      await dispatchWorkerPayload({
        env: this.env,
        payload: { collectionId },
        workerPath: '/api/worker/collection-finalize',
      });
      this.logEventBestEffort({
        event: 'collection_finalize_dispatched',
        stage: 'collection',
        chatId,
        userId,
        collectionId: collectionIdForLog || collectionId,
        sourceType: 'work',
        status: 'queued',
        message: `count=${count}`,
        payload: {
          mediaGroupId,
          count,
        },
      });
      return true;
    } catch (error) {
      if (this.shouldDisableWorkerDispatch(error)) {
        this.workerDispatchDisabledReason = error.message;
      }
      this.logEventBestEffort({
        level: 'ERROR',
        event: 'collection_finalize_dispatch_failed',
        stage: 'error',
        chatId,
        userId,
        collectionId: collectionIdForLog || collectionId,
        sourceType: 'work',
        status: 'failed',
        message: error.message,
        node: error.step ?? 'dispatch_collection_finalize',
        payload: {
          mediaGroupId,
          count,
        },
      });
      return false;
    }
  }

  async handleTelegramUpdate(update) {
    const normalized = normalizeTelegramUpdate(update);
    try {
      const idempotency = await this.repos.recordIdempotency(
        'telegram_update',
        { updateId: normalized.updateId },
        nowIso(),
        addMinutes(new Date(), 1_440),
      );
      if (!idempotency.inserted) {
        return { ok: true, duplicate: true };
      }

      this.logEventBestEffort({
        event: 'incoming_update',
        stage: normalized.kind === 'callback'
          ? 'callback'
          : normalized.kind === 'text'
            ? 'message'
            : normalized.kind === 'photo'
              ? 'collection'
              : 'command',
        chatId: normalized.chatId,
        userId: normalized.userId,
        status: normalized.kind,
        message: normalized.command ?? normalized.text ?? normalized.callbackData ?? '',
        payload: { updateId: normalized.updateId },
      });

      if (normalized.kind === 'command') {
        return await this.handleCommand(normalized);
      }
      if (normalized.kind === 'photo') {
        return await this.handlePhoto(normalized);
      }
      if (normalized.kind === 'callback') {
        return await this.handleCallback(normalized);
      }
      if (normalized.kind === 'text') {
        return await this.handleText(normalized);
      }
      return { ok: true, ignored: true };
    } catch (error) {
      if (isDuplicateIdempotencyError(error)) {
        return { ok: true, duplicate: true };
      }
      await this.logEvent({
        level: 'ERROR',
        event: 'update_failed',
        stage: 'error',
        chatId: normalized.chatId,
        userId: normalized.userId,
        status: 'failed',
        collectionId: error.collectionId ?? null,
        jobId: error.jobId ?? null,
        queueId: error.queueId ?? null,
        node: error.step ?? null,
        message: error.message,
      });
      if (normalized.chatId) {
        await this.sendMessage(normalized.chatId, this.buildUserErrorMessage(error));
      }
      return { ok: false, error: error.message };
    }
  }

  async handleCommand(normalized) {
    switch (normalized.command) {
      case '/start':
        return this.handleStart(normalized);
      case '/help':
        return this.handleHelp(normalized);
      case '/work':
        return this.handleWorkCommand(normalized);
      case '/topic':
        return this.openTopicLikePicker(normalized, 'topic');
      case '/stories':
        return this.openTopicLikePicker(normalized, 'stories');
      case '/creative':
        return this.openTopicLikePicker(normalized, 'creative');
      case '/slider':
        return this.openTopicLikePicker(normalized, 'slider');
      default:
        await this.sendMessage(normalized.chatId, USER_MESSAGES.unknownCommand);
        return { ok: true, command: normalized.command };
    }
  }

  async handleHelp(normalized) {
    const helpMessage = buildHelpMessage(await this.promptConfig.get('help_message', DEFAULT_PROMPTS.help_message));
    await this.sendMessage(normalized.chatId, helpMessage);
    return { ok: true, command: '/help' };
  }

  async handleStart(normalized) {
    const startMessage = buildStartMessage(await this.promptConfig.get('help_message', DEFAULT_PROMPTS.help_message));
    await this.sendMessage(normalized.chatId, startMessage);
    return { ok: true, command: '/start' };
  }

  async reclaimExpiredSourceRows(sheetName) {
    if (!this.isTopicSourceStatusMutationsEnabled()) {
      return 0;
    }
    const state = this.sourceReclaimState.get(sheetName) ?? {};
    const now = Date.now();
    if (state.promise) {
      return state.promise;
    }
    if (state.lastRunAt && (now - state.lastRunAt) < SOURCE_RECLAIM_CACHE_MS) {
      return 0;
    }

    const run = (async () => {
    const rows = typeof this.store.getRowsByQuery === 'function'
      ? await this.store.getRowsByQuery(sheetName, {
        eq: { status: 'reserved' },
      })
      : await this.store.getRows(sheetName);
    let reclaimedCount = 0;
    for (const row of rows) {
      if (this.isExpiredSourceReservation(row)) {
        reclaimedCount += 1;
        await this.reclaimExpiredSourceRow(sheetName, row);
      }
    }
      return reclaimedCount;
    })();

    this.sourceReclaimState.set(sheetName, {
      ...state,
      promise: run,
      lastRunAt: now,
    });

    try {
      return await run;
    } finally {
      const nextState = this.sourceReclaimState.get(sheetName) ?? {};
      this.sourceReclaimState.set(sheetName, {
        ...nextState,
        promise: null,
        lastRunAt: Date.now(),
      });
    }
  }

  async listReadySourceRows(sheetName) {
    await this.reclaimExpiredSourceRows(sheetName);
    const rows = typeof this.store.getRowsByQuery === 'function'
      ? await this.store.getRowsByQuery(sheetName, {
        eq: { status: 'ready' },
        columns: ['id', 'topic_id', 'title', 'priority', 'status'],
        orderBy: [
          { column: 'priority', ascending: true },
          { column: 'title', ascending: true },
        ],
      })
      : await this.store.getRows(sheetName);
    return rows
      .filter((row) => String(row.status).toLowerCase() === 'ready')
      .sort((left, right) => {
        const leftPriority = Number(left.priority ?? 9999);
        const rightPriority = Number(right.priority ?? 9999);
        if (leftPriority !== rightPriority) {
          return leftPriority - rightPriority;
        }
        return String(left.title ?? '').localeCompare(String(right.title ?? ''), 'ru');
      });
  }

  async countReadySourceRows(sheetName) {
    await this.reclaimExpiredSourceRows(sheetName);
    if (typeof this.store.countRowsByQuery === 'function') {
      return this.store.countRowsByQuery(sheetName, {
        eq: { status: 'ready' },
      });
    }
    const rows = await this.listReadySourceRows(sheetName);
    return rows.length;
  }

  async listReadySourceRowsPage(sheetName, page = 0, pageSize = TOPIC_LIKE_PAGE_SIZE) {
    const totalRows = await this.countReadySourceRows(sheetName);
    if (totalRows === 0) {
      return { rows: [], totalRows: 0, totalPages: 0, page: 0 };
    }

    const totalPages = Math.max(1, Math.ceil(totalRows / pageSize));
    const safePage = Math.max(0, Math.min(totalPages - 1, Number(page) || 0));

    if (typeof this.store.getRowsByQuery === 'function') {
      const rows = await this.store.getRowsByQuery(sheetName, {
        eq: { status: 'ready' },
        columns: ['id', 'topic_id', 'title', 'priority', 'status'],
        orderBy: [
          { column: 'priority', ascending: true },
          { column: 'title', ascending: true },
        ],
        offset: safePage * pageSize,
        limit: pageSize,
      });
      return { rows, totalRows, totalPages, page: safePage };
    }

    const rows = await this.listReadySourceRows(sheetName);
    return {
      rows: rows.slice(safePage * pageSize, (safePage + 1) * pageSize),
      totalRows,
      totalPages,
      page: safePage,
    };
  }

  async reserveSourceRow(sheetName, topicId, reservedBy) {
    if (!this.isTopicSourceStatusMutationsEnabled()) {
      const sourceRow = await this.getSourceRowByTopicId(sheetName, topicId);
      return sourceRow && String(sourceRow.status).toLowerCase() === 'ready'
        ? sourceRow
        : null;
    }
    let sourceRow = await this.getSourceRowByTopicId(sheetName, topicId);
    if (sourceRow && String(sourceRow.status).toLowerCase() === 'reserved' && this.isExpiredSourceReservation(sourceRow)) {
      sourceRow = await this.reclaimExpiredSourceRow(sheetName, sourceRow);
    }
    if (!sourceRow || String(sourceRow.status).toLowerCase() !== 'ready') {
      return null;
    }
    const reservedAt = nowIso();
    const nextRow = {
      ...sourceRow,
      status: 'reserved',
      reserved_by: reservedBy,
      reserved_at: reservedAt,
      reservation_expires_at: addMinutes(reservedAt, TOPIC_RESERVATION_MINUTES),
    };
    await this.store.updateRowByNumber(
      sheetName,
      sourceRow.__rowNumber,
      nextRow,
      SHEET_HEADERS[sheetName],
    );
    return nextRow;
  }

  async releaseSourceRow(sheetName, topicId) {
    if (!this.isTopicSourceStatusMutationsEnabled()) {
      return;
    }
    const row = await this.getSourceRowByTopicId(sheetName, topicId);
    if (!row) {
      return;
    }
    await this.store.updateRowByNumber(
      sheetName,
      row.__rowNumber,
      {
        ...row,
        status: 'ready',
        reserved_by: '',
        reserved_at: '',
        reservation_expires_at: '',
      },
      SHEET_HEADERS[sheetName],
    );
  }

  async markSourceRowPublished(sheetName, topicId, jobId) {
    if (!this.isTopicSourceStatusMutationsEnabled()) {
      return;
    }
    const row = await this.getSourceRowByTopicId(sheetName, topicId);
    if (!row) {
      return;
    }
    await this.store.updateRowByNumber(
      sheetName,
      row.__rowNumber,
      {
        ...row,
        status: 'published',
        reserved_by: '',
        reserved_at: '',
        reservation_expires_at: '',
        last_job_id: jobId,
        last_published_at: nowIso(),
      },
      SHEET_HEADERS[sheetName],
    );
  }

  async openTopicLikePicker(normalized, jobType) {
    const startedAt = Date.now();
    const config = this.getTopicLikeModeConfig(jobType);
    if (!config) {
      return { ok: false, unknownMode: true };
    }

    const readyRowCount = await this.countReadySourceRows(config.sourceSheetName);
    if (readyRowCount === 0) {
      await this.sendMessage(normalized.chatId, config.emptyMessage);
      return { ok: true, command: config.command, empty: true };
    }

    const pickerMessage = await this.presentTopicLikePicker({
      chatId: normalized.chatId,
      userId: normalized.userId,
      jobType,
      page: 0,
      existingMessageId: null,
    });

    await this.repos.upsertSession({
      session_id: this.getPickerSessionId(normalized.chatId, jobType),
      chat_id: normalized.chatId,
      user_id: normalized.userId,
      mode: `${jobType}_picker`,
      state: 'choosing_source',
      active_job_id: pickerMessage.jobId,
      pending_payload_json: JSON.stringify({
        page: 0,
        tokenSetId: pickerMessage.tokenSetId,
        messageId: pickerMessage.messageId,
        jobType,
      }),
      expires_at: addMinutes(new Date(), TOPIC_LIKE_PICKER_TTL_MINUTES),
      updated_at: nowIso(),
    });

    this.logDurationBestEffort({
      event: 'picker_opened',
      stage: 'picker',
      chatId: normalized.chatId,
      userId: normalized.userId,
      sourceType: jobType,
      status: 'ok',
      message: `page=1 rows=${pickerMessage.rowCount}`,
    }, startedAt, { rowCount: pickerMessage.rowCount });

    return { ok: true, command: config.command, picker: true };
  }

  async presentTopicLikePicker({
    chatId,
    userId,
    jobType,
    page = 0,
    existingMessageId = null,
  }) {
    const startedAt = Date.now();
    const config = this.getTopicLikeModeConfig(jobType);
    const pageData = await this.listReadySourceRowsPage(config.sourceSheetName, page, TOPIC_LIKE_PAGE_SIZE);
    if (pageData.totalRows === 0) {
      let messageId = existingMessageId;
      if (existingMessageId) {
        const edited = await this.callTelegram('editMessageText', chatId, existingMessageId, config.emptyMessage, {
          reply_markup: new InlineKeyboard(),
        });
        messageId = edited.message_id ?? existingMessageId;
      }
      return {
        messageId,
        tokenSetId: '',
        page: 0,
        jobId: `PICK:${jobType}:${chatId}`,
        userId,
        empty: true,
        rowCount: 0,
      };
    }
    const { rows: pageRows, totalRows, totalPages, page: safePage } = pageData;
    const pickerJobId = `PICK:${jobType}:${chatId}`;
    const definitions = [];

    for (const [index, row] of pageRows.entries()) {
      definitions.push({
        action: `pick_source_${safePage}_${index}`,
        kind: 'item',
        payload: {
          pickerJobType: jobType,
          sourceSheetName: config.sourceSheetName,
          topicId: row.topic_id,
          page: safePage,
        },
      });
    }

    if (safePage > 0) {
      definitions.push({
        action: `picker_prev_${safePage}`,
        kind: 'prev',
        payload: { pickerJobType: jobType, page: safePage - 1 },
      });
    }
    if (safePage < totalPages - 1) {
      definitions.push({
        action: `picker_next_${safePage}`,
        kind: 'next',
        payload: { pickerJobType: jobType, page: safePage + 1 },
      });
    }
    definitions.push({
      action: `picker_cancel_${safePage}`,
      kind: 'cancel',
      payload: { pickerJobType: jobType, page: safePage },
    });

    const { tokenRows, entries, tokenSetId } = this.createCallbackRows({
      jobId: pickerJobId,
      revision: 0,
      chatId,
      definitions,
    });
    await this.repos.createCallbackTokens(tokenRows);

    const itemButtons = pageRows.map((row, index) => {
      const entry = entries.find((item) => item.kind === 'item' && item.payload?.topicId === row.topic_id && item.action === `pick_source_${safePage}_${index}`);
      return {
        label: this.truncatePickerLabel(row.title),
        action: entry.action,
        token: entry.token,
      };
    });
    const prevButton = entries.find((entry) => entry.kind === 'prev') ?? null;
    const nextButton = entries.find((entry) => entry.kind === 'next') ?? null;
    const cancelButton = entries.find((entry) => entry.kind === 'cancel') ?? null;

    const text = [
      config.pickerTitle,
      '',
      `Страница ${safePage + 1}/${totalPages}`,
      `Доступно тем: ${totalRows}`,
      '',
      'Нажми на нужную тему ниже.',
    ].join('\n');

    const keyboard = this.buildTopicLikePickerKeyboard({
      itemButtons,
      prevButton,
      nextButton,
      cancelButton,
    });

    let messageId = existingMessageId;
    if (existingMessageId) {
      const edited = await this.callTelegram('editMessageText', chatId, existingMessageId, text, {
        reply_markup: keyboard,
      });
      messageId = edited.message_id ?? existingMessageId;
    } else {
      const message = await this.sendMessage(chatId, text, {
        reply_markup: keyboard,
      });
      messageId = message.message_id;
    }

    this.logDurationBestEffort({
      event: existingMessageId ? 'picker_page_switched' : 'picker_rendered',
      stage: 'picker',
      chatId,
      userId,
      jobId: pickerJobId,
      sourceType: jobType,
      status: 'ok',
      message: `page=${safePage + 1}/${totalPages}`,
    }, startedAt, { rowCount: totalRows, pageRows: pageRows.length });

    return {
      messageId,
      tokenSetId,
      page: safePage,
      jobId: pickerJobId,
      userId,
      rowCount: totalRows,
    };
  }

  async handleWorkCommand(normalized) {
    const sessionId = this.getWorkSessionId(normalized.chatId);
    const existingSession = await this.repos.getSessionById(sessionId);
    const existingPayload = this.parseWorkSessionPayload(existingSession);
    if (existingPayload.tokenSetId) {
      await this.repos.supersedeTokenSet(existingPayload.tokenSetId, nowIso());
    }
    const { tokenRows, tokensByAction, tokenSetId } = this.createCallbackSet({
      jobId: this.getWorkSessionJobId(normalized.chatId),
      revision: 0,
      chatId: normalized.chatId,
      actions: ['work_photo_type_normal', 'work_photo_type_studio', 'cancel'],
    });
    await this.repos.createCallbackTokens(tokenRows);
    const { textMessageId } = await this.sendWorkPhotoTypePrompt({
      chatId: normalized.chatId,
      tokensByAction,
    });
    await this.repos.upsertSession({
      session_id: sessionId,
      chat_id: normalized.chatId,
      user_id: normalized.userId,
      mode: 'work',
      state: 'awaiting_photo_type',
      active_job_id: '',
      pending_payload_json: JSON.stringify({
        tokenSetId,
        textMessageId,
        photoType: '',
        backgroundMode: '',
        subjectType: '',
        promptMode: 'normal',
        browOutputMode: '',
        collectionId: '',
      }),
      expires_at: addMinutes(new Date(), WORK_SESSION_TTL_MINUTES),
      updated_at: nowIso(),
    });
    this.logEventBestEffort({
      event: 'work_command_started',
      stage: 'command',
      chatId: normalized.chatId,
      userId: normalized.userId,
      sourceType: 'work',
      status: 'awaiting_photo_type',
      message: USER_MESSAGES.workPhotoTypeChoice,
    });
    return {
      ok: true,
      command: '/work',
      resumed: existingSession?.state === 'awaiting_photo_type',
    };
  }

  async handleTopicCommand(normalized) {
    return this.openTopicLikePicker(normalized, 'topic');
  }

  parseJsonModelOutput(text, fallback = {}) {
    const raw = String(text ?? '').trim();
    if (!raw) {
      return fallback;
    }
    const fenced = raw.match(/```(?:json)?\s*([\s\S]+?)```/u)?.[1];
    const candidate = fenced ?? raw.slice(raw.indexOf('{') >= 0 ? raw.indexOf('{') : 0, raw.lastIndexOf('}') + 1);
    try {
      return JSON.parse(candidate);
    } catch {
      return fallback;
    }
  }

  buildSliderContentSlides(sourceRow, candidateSlides = []) {
    const normalized = Array.isArray(candidateSlides)
      ? candidateSlides
        .filter((slide) => slide && (slide.title || slide.body || (Array.isArray(slide.bullets) && slide.bullets.length > 0)))
        .map((slide, index) => {
          const normalizedSlide = this.normalizeSliderSlide(slide, sourceRow, index);
          return {
            ...normalizedSlide,
            _semanticKey: this.getSliderSemanticKey(
              normalizedSlide.title,
              normalizedSlide.body,
              ...(normalizedSlide.bullets ?? []),
            ),
          };
        })
        .filter((slide) => slide.title || slide.body || slide.bullets.length > 0)
      : [];

    const fallbackQueue = this.buildSliderFallbackSlides(sourceRow).map((slide) => ({
      ...slide,
      _semanticKey: this.getSliderSemanticKey(slide.title, slide.body, ...(slide.bullets ?? [])),
    }));
    const fallbackByKey = new Map(
      fallbackQueue
        .filter((slide) => slide._semanticKey)
        .map((slide) => [slide._semanticKey, slide]),
    );

    const slides = normalized.map((slide, index) => {
        const fallback = fallbackByKey.get(slide._semanticKey) ?? fallbackQueue[index] ?? {};
        const useFallbackTitle = this.isWeakSliderSlideTitle(slide.title);
        const useFallbackBody = this.isWeakSliderSlideBody(slide.body);
        const useFallbackBullets = !Array.isArray(slide.bullets) || slide.bullets.length < 2;
        const title = useFallbackTitle ? (fallback.title ?? slide.title) : slide.title;
        const body = useFallbackBody ? fallback.body ?? slide.body : slide.body;
        const bullets = useFallbackBullets ? (fallback.bullets ?? slide.bullets ?? []) : slide.bullets;
        return {
          ...slide,
          title,
          body,
          bullets,
          _semanticKey: this.getSliderSemanticKey(title, body, ...(bullets ?? [])),
          footer: this.mergeOverlayFooter(slide.footer ?? fallback.footer ?? '', title, body, bullets),
        };
      });

      for (const candidate of fallbackQueue) {
        if (slides.length >= 5) {
          break;
        }
        const duplicate = slides.some((slide) => (
          (slide._semanticKey && candidate._semanticKey && slide._semanticKey === candidate._semanticKey)
          || (slide.title === candidate.title && slide.body === candidate.body)
        ));
        if (!duplicate) {
          slides.push(candidate);
        }
      }

      return slides
        .slice(0, 5)
        .map((slide, index) => ({
            ...slide,
            eyebrow: slide.eyebrow || `Шаг ${index + 1}`,
          }))
          .map(({ _semanticKey, ...slide }) => slide)
          .slice(0, Math.max(2, Math.min(5, slides.length)));
    }

  normalizeTopicLikeManifest(jobType, manifest, sourceRow) {
    if (jobType === 'stories') {
      return this.normalizeStoryManifest(manifest, sourceRow);
    }

    if (jobType === 'creative') {
      return this.normalizeCreativeManifest(manifest, sourceRow);
    }

      if (jobType === 'slider') {
        const coverSubtitleRaw = String(manifest.coverSubtitle ?? manifest.subtitle ?? manifest.description ?? sourceRow.brief ?? '').trim();
        const slides = this.buildSliderContentSlides(sourceRow, manifest.slides);
        return this.normalizeSliderDeckConsistency(sourceRow, {
          eyebrow: '',
          coverTitle: manifest.coverTitle ?? manifest.title ?? sourceRow.title,
          coverSubtitle: coverSubtitleRaw,
          coverBullets: this.normalizeCreativeBullets(manifest.coverBullets ?? manifest.points ?? []),
          slides,
          footer: manifest.footer ?? '',
        });
        }

    return manifest;
  }

  async generateTopicLikeVisualAssets({ jobType, prompts, manifest, sourceRow, revision, jobId }) {
    const config = this.getTopicLikeModeConfig(jobType);

    if (jobType === 'topic') {
      const imageResult = await this.openrouter.generateImages({
        prompt: this.buildTopicImagePrompt(sourceRow, prompts),
        imageUrls: this.getTopicImageReferenceUrls(),
        metadata: { source_type: 'topic', topic_id: sourceRow.topic_id, job_id: jobId, revision },
      });
      const previewAssets = await Promise.all(imageResult.images.slice(0, 1).map((source) => this.resolveRemoteImage(source)));
      return {
        assets: previewAssets,
        finalRenderMode: 'single',
        captionText: manifest.captionText,
      };
    }

    const visualSummary = jobType === 'creative'
      ? JSON.stringify({
        headline: manifest.headline ?? '',
        subhead: manifest.subhead ?? '',
        bullets: manifest.bullets ?? [],
      })
      : jobType === 'stories'
        ? JSON.stringify({
          title: manifest.title ?? '',
          body: manifest.body ?? '',
          bullets: manifest.bullets ?? [],
        })
        : JSON.stringify({
          coverTitle: manifest.coverTitle ?? '',
          coverSubtitle: manifest.coverSubtitle ?? '',
          coverBullets: manifest.coverBullets ?? [],
          slideTitles: Array.isArray(manifest.slides) ? manifest.slides.map((slide) => slide?.title ?? '').filter(Boolean) : [],
        });

    const visualPrompt = [
      prompts[config.promptKeys.visual],
      `Title: ${sourceRow.title ?? ''}`,
      `Brief: ${sourceRow.brief ?? ''}`,
      `Tags: ${Array.isArray(sourceRow.tags) ? sourceRow.tags.join(', ') : sourceRow.tags ?? ''}`,
      `Manifest summary: ${visualSummary}`,
    ].join('\n');
    const compactVisualPrompt = [
      prompts[config.promptKeys.visual],
      `Title: ${sourceRow.title ?? ''}`,
      `Tags: ${Array.isArray(sourceRow.tags) ? sourceRow.tags.join(', ') : sourceRow.tags ?? ''}`,
      'Return one clean 9:16 background image only.',
      'No text, no collage, no grid, no poster layout.',
    ].join('\n');
    const imageMetadata = {
      source_type: jobType,
      topic_id: sourceRow.topic_id,
      job_id: jobId,
      revision,
      model: this.env.imageModelId,
    };
    let imageResult;
    try {
      imageResult = await this.openrouter.generateImages({
        prompt: visualPrompt,
        imageConfig: { aspect_ratio: '9:16' },
        metadata: imageMetadata,
      });
    } catch (error) {
      if (!this.isRecoverableImageProviderFailure(error)) {
        throw error;
      }
      this.logEventBestEffort({
        event: 'topic_like_visual_retry_started',
        stage: 'processing',
        chatId: sourceRow.chat_id ?? '',
        userId: sourceRow.user_id ?? '',
        jobId,
        sourceType: jobType,
        status: 'retrying',
        message: error?.message ?? sourceRow.title ?? '',
        payload: { retryMode: 'compact_prompt', revision },
      });
      imageResult = await this.openrouter.generateImages({
        prompt: compactVisualPrompt,
        imageConfig: { aspect_ratio: '9:16' },
        metadata: { ...imageMetadata, retry_mode: 'compact_prompt' },
      });
      this.logEventBestEffort({
        event: 'topic_like_visual_retry_succeeded',
        stage: 'processing',
        chatId: sourceRow.chat_id ?? '',
        userId: sourceRow.user_id ?? '',
        jobId,
        sourceType: jobType,
        status: 'ok',
        message: sourceRow.title ?? '',
        payload: { retryMode: 'compact_prompt', revision },
      });
    }
      const backgroundSource = imageResult.images[0];
      const backgroundAsset = backgroundSource ? await this.resolveRemoteImage(backgroundSource) : null;
      const backgroundStyle = this.pickStoryBackgroundStyle(`${jobType}|${sourceRow.title}|${revision}`);

      if (jobType === 'stories') {
        const slide = await composeStorySlide({ backgroundAsset, manifest, backgroundStyle });
        return {
          assets: [slide],
          finalRenderMode: 'single',
          captionText: [manifest.title ?? sourceRow.title, manifest.body ?? sourceRow.brief].filter(Boolean).join('\n\n'),
        };
      }

      if (jobType === 'creative') {
        const slide = await composeCreativeSlide({ backgroundAsset, manifest, backgroundStyle });
        return {
          assets: [slide],
          finalRenderMode: 'single',
          captionText: [manifest.headline ?? sourceRow.title, manifest.subhead ?? sourceRow.brief].filter(Boolean).join('\n\n'),
        };
      }

      const slides = await composeSliderSlides({ backgroundAsset, manifest, backgroundStyle });
    return {
      assets: slides,
      finalRenderMode: slides.length > 1 ? 'separate' : 'single',
      captionText: [manifest.coverTitle ?? sourceRow.title, manifest.coverSubtitle ?? sourceRow.brief].filter(Boolean).join('\n\n'),
    };
  }

  async generateTopicLikeManifest({ jobType, prompts, sourceRow, jobId, revision }) {
    if (jobType === 'topic') {
      const { result, durationMs } = await measureDuration(() => this.openrouter.generateText({
      systemPrompt: prompts.topic_post_generation,
      userPrompt: this.buildTopicUserPrompt(sourceRow),
      maxTokens: 700,
      metadata: { source_type: 'topic', topic_id: sourceRow.topic_id, job_id: jobId, revision },
    }));
      return {
        manifest: {
          captionText: this.formatTopicCaption(result.text, prompts.contact_block),
        },
        durationMs,
      };
    }

    const config = this.getTopicLikeModeConfig(jobType);
    const { result, durationMs } = await measureDuration(() => this.openrouter.generateText({
      systemPrompt: prompts[config.promptKeys.manifest],
      userPrompt: this.buildTopicUserPrompt(sourceRow),
      temperature: 0.7,
      maxTokens: 1200,
      metadata: { source_type: jobType, topic_id: sourceRow.topic_id, job_id: jobId, revision },
    }));

    const parsed = this.parseJsonModelOutput(result.text, {});
    const fallbackManifest = {
      stories: {
        eyebrow: 'Stories',
        title: sourceRow.title,
        body: sourceRow.brief,
        bullets: parseTags(sourceRow.tags).slice(0, 4),
        footer: '',
      },
      creative: {
        eyebrow: '',
        headline: sourceRow.title,
        subhead: this.buildCreativeFallbackSubhead(sourceRow),
        bullets: [],
        footer: '',
      },
      slider: {
        eyebrow: '',
        coverTitle: sourceRow.title,
        coverSubtitle: this.buildSliderCoverSubtitle(sourceRow),
        slides: this.buildSliderFallbackSlides(sourceRow),
        footer: '',
      },
    };

    return {
      manifest: this.normalizeTopicLikeManifest(jobType, { ...fallbackManifest[jobType], ...parsed }, sourceRow),
      durationMs,
    };
  }

  async startTopicLikeJob(normalized, sourceRow, jobType) {
    const config = this.getTopicLikeModeConfig(jobType);
    const jobId = stableId('JOB', `${jobType}:${sourceRow.topic_id}:${Date.now()}`);
    const queueId = stableId('QUE', jobId);
    const prompts = await this.promptConfig.refresh();
    const tags = parseTags(sourceRow.tags);

    await this.logEvent({
      event: 'topic_like_reserved',
      stage: 'command',
      chatId: normalized.chatId,
      userId: normalized.userId,
      jobId,
      queueId,
      sourceType: jobType,
      status: 'reserved',
      message: sourceRow.title,
    });

    await this.sendProgress(normalized.chatId, USER_MESSAGES.topicTaken);
    await this.sendProgress(normalized.chatId, USER_MESSAGES.topicGeneratingText);
    const { manifest, durationMs: manifestDurationMs } = await this.generateTopicLikeManifest({
      jobType,
      prompts,
      sourceRow: { ...sourceRow, tags },
      jobId,
      revision: 1,
    });
    await this.logEvent({
      event: 'topic_like_manifest_ready',
      stage: 'processing',
      chatId: normalized.chatId,
      userId: normalized.userId,
      jobId,
      queueId,
      sourceType: jobType,
      status: 'ok',
      durationMs: manifestDurationMs,
      message: sourceRow.title,
    });

    await this.sendProgress(normalized.chatId, USER_MESSAGES.topicGeneratingImages);
    const visualStartedAt = Date.now();
    const { assets: previewAssets, finalRenderMode, captionText } = await this.generateTopicLikeVisualAssets({
      jobType,
      prompts,
      manifest,
      sourceRow: { ...sourceRow, tags },
      revision: 1,
      jobId,
    });
    this.logDurationBestEffort({
      event: 'topic_like_visual_ready',
      stage: 'processing',
      chatId: normalized.chatId,
      userId: normalized.userId,
      jobId,
      queueId,
      sourceType: jobType,
      status: 'ok',
      message: sourceRow.title,
    }, visualStartedAt, { assetCount: previewAssets.length, renderMode: finalRenderMode });

    const revision = 1;
    const basePayload = {
      jobId,
      queueId,
      jobType,
      revision,
      viewRevision: revision,
      chatId: normalized.chatId,
      userId: normalized.userId,
      topicId: sourceRow.topic_id,
      title: sourceRow.title,
      brief: sourceRow.brief,
      tags,
      captionText,
      manifest,
      originalTelegramFileIds: [],
      previewTelegramFileIds: [],
      renderMode: finalRenderMode,
      finalRenderMode,
      sourceAssetCount: previewAssets.length,
      createdAt: nowIso(),
    };
    const revisionEntry = this.buildRevisionEntry({
      revision,
      captionText,
      previewTelegramFileIds: [],
      finalRenderMode,
      sourceAssetCount: previewAssets.length,
    });
    const draftPayload = {
      ...basePayload,
      revisionHistory: [revisionEntry],
    };

    const { tokenRows, tokensByAction, tokenSetId } = this.createCallbackSet({
      jobId,
      revision,
      chatId: normalized.chatId,
      actions: ['version_prev', 'version_next', 'regenerate_images', 'regenerate_text', 'regenerate_all', 'publish_confirm', 'cancel'],
    });
    await this.repos.createCallbackTokens(tokenRows);

    await this.sendProgress(normalized.chatId, USER_MESSAGES.assemblingPreview);
    const previewMessages = await this.presentPreviewRevision({
      chatId: normalized.chatId,
      payload: draftPayload,
      revisionEntry,
      tokensByAction,
      runtime: null,
      assets: previewAssets,
    });
    revisionEntry.previewTelegramFileIds = previewMessages.previewTelegramFileIds;

    const previewPayload = {
      ...draftPayload,
      previewTelegramFileIds: previewMessages.previewTelegramFileIds,
      revisionHistory: [{ ...revisionEntry }],
    };

    await this.store.upsertRowByColumn(
      SHEET_NAMES.contentQueue,
      'queue_id',
      queueId,
      buildQueueRow({
        queueId,
        jobId,
        jobType,
        revision,
        status: 'preview_ready',
        captionText,
        assetDriveFileIds: previewMessages.previewTelegramFileIds,
        manifestDriveFileId: '',
        topicId: sourceRow.topic_id,
      }),
      SHEET_HEADERS[SHEET_NAMES.contentQueue],
    );

    await this.repos.upsertRuntime({
      job_id: jobId,
      job_type: jobType,
      chat_id: normalized.chatId,
      user_id: normalized.userId,
      topic_id: sourceRow.topic_id,
      collection_id: '',
      active_revision: revision,
      runtime_status: 'preview_ready',
      collage_message_id: toStoredText(previewMessages.collageMessageId),
      assets_message_ids_json: JSON.stringify(previewMessages.assetsMessageIds),
      text_message_id: toStoredText(previewMessages.textMessageId),
      active_callback_set_id: toStoredText(tokenSetId),
      schedule_input_pending: 0,
      lock_flags_json: JSON.stringify({ source_type: jobType, source_sheet: config.sourceSheetName }),
      preview_payload_json: JSON.stringify(previewPayload),
      draft_payload_json: JSON.stringify(previewPayload),
      updated_at: nowIso(),
    });

    if (this.isTopicSourceStatusMutationsEnabled()) {
      await this.store.upsertRowByColumn(
        config.sourceSheetName,
        'topic_id',
        sourceRow.topic_id,
        {
          ...sourceRow,
          status: 'reserved',
          reserved_by: jobId,
          reserved_at: sourceRow.reserved_at ?? nowIso(),
          reservation_expires_at: sourceRow.reservation_expires_at ?? addMinutes(new Date(), TOPIC_RESERVATION_MINUTES),
          last_job_id: jobId,
        },
        SHEET_HEADERS[config.sourceSheetName],
      );
    }
    await this.ensureSourceRowReserved(config.sourceSheetName, sourceRow.topic_id, jobId);

    return { ok: true, command: config.command, jobId, queueId };
  }
  async handlePhoto(normalized) {
    let workSession = await this.repos.getSessionByChatAndMode(normalized.chatId, 'work');
    if (workSession?.state === 'awaiting_photo_type') {
      const sessionPayload = this.parseWorkSessionPayload(workSession);
      if (sessionPayload.tokenSetId) {
        await this.repos.supersedeTokenSet(sessionPayload.tokenSetId, nowIso());
      }
      const textMessageId = await this.upsertControlMessage(normalized.chatId, USER_MESSAGES.workPhotoRequest, {
        existingMessageId: sessionPayload.textMessageId ?? null,
        replyMarkup: { inline_keyboard: [] },
      });
      await this.repos.upsertSession({
        session_id: workSession.session_id,
        chat_id: workSession.chat_id,
        user_id: workSession.user_id,
        mode: 'work',
        state: 'awaiting_assets',
        active_job_id: '',
        pending_payload_json: JSON.stringify({
          ...sessionPayload,
          tokenSetId: '',
          photoType: 'normal',
          textMessageId,
        }),
        expires_at: addMinutes(new Date(), WORK_SESSION_TTL_MINUTES),
        updated_at: nowIso(),
      });
      workSession = await this.repos.getSessionByChatAndMode(normalized.chatId, 'work');
    }
    const lateAlbumCollectionId = normalized.mediaGroupId
      ? stableId('COL', `group:${normalized.chatId}:${normalized.mediaGroupId}`)
      : null;
    const lateAlbumCollection = lateAlbumCollectionId
      ? await this.repos.getCollectionById(lateAlbumCollectionId)
      : null;
    const canResumeLateAlbum = Boolean(
      normalized.mediaGroupId
      && lateAlbumCollection
      && ['collecting', 'awaiting_brow_output_mode', 'awaiting_render_mode', 'awaiting_background_mode', 'awaiting_cleanup_mode'].includes(String(lateAlbumCollection.status ?? ''))
      && Number(lateAlbumCollection.count ?? 0) < 3
      && (Date.now() - new Date(lateAlbumCollection.last_message_at ?? 0).getTime()) < 120_000
    );

    if ((!workSession || workSession.state !== 'awaiting_assets') && !canResumeLateAlbum) {
      if (workSession?.state === 'awaiting_photo_type') {
        const sessionPayload = this.parseWorkSessionPayload(workSession);
        const tokenRows = sessionPayload.tokenSetId
          ? await this.repos.listCallbackTokensByTokenSet(sessionPayload.tokenSetId)
          : [];
        const tokensByAction = Object.fromEntries(tokenRows.map((row) => [row.action, row.token]));
        await this.sendWorkPhotoTypePrompt({
          chatId: normalized.chatId,
          tokensByAction,
          existingMessageId: sessionPayload.textMessageId ?? null,
        });
        return { ok: true, ignored: true };
      }
      if (workSession?.state === 'awaiting_subject_type') {
        const sessionPayload = this.parseWorkSessionPayload(workSession);
        const tokenRows = sessionPayload.tokenSetId
          ? await this.repos.listCallbackTokensByTokenSet(sessionPayload.tokenSetId)
          : [];
        const tokensByAction = Object.fromEntries(tokenRows.map((row) => [row.action, row.token]));
        await this.sendWorkSubjectPrompt({
          chatId: normalized.chatId,
          tokensByAction,
          existingMessageId: sessionPayload.textMessageId ?? null,
        });
        return { ok: true, ignored: true };
      }
      if (workSession?.state === 'awaiting_prompt_mode') {
        const sessionPayload = this.parseWorkSessionPayload(workSession);
        const tokenRows = sessionPayload.tokenSetId
          ? await this.repos.listCallbackTokensByTokenSet(sessionPayload.tokenSetId)
          : [];
        const tokensByAction = Object.fromEntries(tokenRows.map((row) => [row.action, row.token]));
        await this.sendWorkPromptModePrompt({
          chatId: normalized.chatId,
          tokensByAction,
          existingMessageId: sessionPayload.textMessageId ?? null,
        });
        return { ok: true, ignored: true };
      }
      await this.sendMessage(normalized.chatId, USER_MESSAGES.workBeforePhoto);
      return { ok: true, ignored: true };
    }

    const asset = {
      ...normalized.photos[0],
      messageId: normalized.messageId,
      mediaGroupId: normalized.mediaGroupId,
      receivedAt: nowIso(),
    };

    const collectionLockKey = normalized.mediaGroupId
      ? `collection:${normalized.chatId}:${normalized.mediaGroupId}`
      : `collection:${normalized.chatId}:single`;
    const { collection, created, reopenedAwaitingRenderMode } = await this.withLocalLock(
      collectionLockKey,
      () => this.getOrCreateWorkCollection(normalized, asset),
    );
    if (reopenedAwaitingRenderMode) {
      const lateRuntime = await this.repos.getRuntime(stableId('JOB', `work:${collection.collection_id}`));
      if (lateRuntime) {
        if (lateRuntime.active_callback_set_id) {
          await this.repos.supersedeTokenSet(lateRuntime.active_callback_set_id, nowIso());
        }
        await this.repos.upsertRuntime({
          job_id: lateRuntime.job_id,
          job_type: lateRuntime.job_type,
          chat_id: lateRuntime.chat_id,
          user_id: lateRuntime.user_id,
          topic_id: lateRuntime.topic_id ?? '',
          collection_id: lateRuntime.collection_id ?? '',
          active_revision: lateRuntime.active_revision,
          runtime_status: 'collecting',
          collage_message_id: toStoredText(lateRuntime.collage_message_id),
          assets_message_ids_json: JSON.stringify(lateRuntime.assets_message_ids ?? []),
          text_message_id: toStoredText(lateRuntime.text_message_id),
          active_callback_set_id: '',
          schedule_input_pending: 0,
          lock_flags_json: JSON.stringify(lateRuntime.lock_flags ?? {}),
          preview_payload_json: JSON.stringify(lateRuntime.preview_payload ?? {}),
          draft_payload_json: JSON.stringify(lateRuntime.draft_payload ?? {}),
          updated_at: nowIso(),
        });
      }
    }
    this.logEventBestEffort({
      event: created ? 'work_album_started' : 'collection_debounce_extended',
      stage: 'collection',
      chatId: normalized.chatId,
      userId: normalized.userId,
      collectionId: collection.collection_id,
      sourceType: 'work',
      status: 'collecting',
      message: `count=${collection.count}`,
      payload: {
        mediaGroupId: normalized.mediaGroupId ?? '',
        count: collection.count,
      },
    });
    this.logEventBestEffort({
      event: 'photo_accepted',
      stage: 'collection',
      chatId: normalized.chatId,
      userId: normalized.userId,
      collectionId: collection.collection_id,
      sourceType: 'work',
      status: 'collecting',
      message: USER_MESSAGES.progressPhotoAccepted(collection.count),
      payload: {
        mediaGroupId: normalized.mediaGroupId ?? '',
        count: collection.count,
        messageId: normalized.messageId,
      },
    });
    const shouldAwaitFinalize = this.shouldAwaitInlineFinalize({
      mediaGroupId: normalized.mediaGroupId,
      collectionCount: collection.count,
    });
    try {
      if (shouldAwaitFinalize) {
        const dispatched = await this.dispatchCollectionFinalizeAsync(collection.collection_id, {
          chatId: normalized.chatId,
          userId: normalized.userId,
          collectionIdForLog: collection.collection_id,
          mediaGroupId: normalized.mediaGroupId ?? '',
          count: collection.count,
        });
        if (!dispatched) {
          await this.scheduleCollectionFinalize(collection.collection_id);
        }
      }
    } catch (error) {
      this.logEventBestEffort({
        level: 'ERROR',
        event: 'collection_finalize_schedule_failed',
        stage: 'error',
        chatId: normalized.chatId,
        userId: normalized.userId,
        collectionId: collection.collection_id,
        sourceType: 'work',
        status: 'failed',
        message: error.message,
        node: error.step ?? 'schedule_collection_finalize',
      });
    }
    return { ok: true, collectionId: collection.collection_id };
  }

  async handleText(normalized) {
    return { ok: true, ignored: true };
  }

  async handleCallback(normalized) {
    const [action, token] = String(normalized.callbackData ?? '').split(':');
    if (!action || !token) {
      return { ok: false, error: 'invalid_callback' };
    }
    await this.logEvent({
      event: 'callback_received',
      stage: 'callback',
      chatId: normalized.chatId,
      userId: normalized.userId,
      status: action,
      message: normalized.callbackData,
    });
    const tokenRow = await this.repos.getCallbackToken(token);
    if (!tokenRow) {
      await this.answerCallback(normalized.callbackQueryId, USER_MESSAGES.callbackStale);
      await this.logEvent({
        event: 'callback_rejected',
        stage: 'callback',
        chatId: normalized.chatId,
        userId: normalized.userId,
        status: 'missing_token',
        message: action,
      });
      return { ok: false, missing: true };
    }

    const normalizedAction = action.startsWith('pick_source_')
      ? 'pick_source'
      : action.startsWith('picker_prev_')
        ? 'picker_prev'
        : action.startsWith('picker_next_')
          ? 'picker_next'
          : action.startsWith('picker_cancel_')
            ? 'picker_cancel'
            : action;

    if (['pick_source', 'picker_prev', 'picker_next', 'picker_cancel'].includes(normalizedAction)) {
      await this.repos.markCallbackUsed(token, nowIso());
      return this.handleTopicPickerCallback({
        normalized,
        action: normalizedAction,
        tokenRow,
      });
    }

    const isWorkSessionAction = tokenRow.job_id === this.getWorkSessionJobId(normalized.chatId);

    if (isWorkSessionAction) {
      await this.repos.markCallbackUsed(token, nowIso());
      await this.answerCallback(normalized.callbackQueryId, USER_MESSAGES.actionCallbackAnswers[normalizedAction] || USER_MESSAGES.callbackUnknown);
      return this.handleWorkSessionCallback({
        normalized,
        action: normalizedAction,
        tokenRow,
      });
    }

    const runtime = await this.repos.getRuntime(tokenRow.job_id);
    const validation = validateCallbackToken({
      tokenRow: {
        ...tokenRow,
        jobId: tokenRow.job_id,
        expiresAt: tokenRow.expires_at,
      },
      expectedJobId: tokenRow.job_id,
      expectedRevision: runtime?.active_revision ?? tokenRow.revision,
    });

    if (!runtime || !validation.ok || runtime.active_callback_set_id !== tokenRow.token_set_id) {
      await this.answerCallback(normalized.callbackQueryId, USER_MESSAGES.callbackUseLatestPreview);
      await this.logEvent({
        event: 'callback_rejected',
        stage: 'callback',
        chatId: normalized.chatId,
        userId: normalized.userId,
        jobId: tokenRow.job_id,
        collectionId: runtime?.collection_id ?? '',
        status: validation.reason ?? 'stale',
        message: action,
      });
      return { ok: false, reason: validation.reason };
    }

    const isNavigationAction = normalizedAction === 'version_prev' || normalizedAction === 'version_next';
    if (!isNavigationAction) {
      await this.repos.markCallbackUsed(token, nowIso());
    }

    const progressByAction = {
      ...USER_MESSAGES.actionMessages,
      cancel: '',
    };
    const callbackByAction = USER_MESSAGES.actionCallbackAnswers;

    if (!callbackByAction[normalizedAction]) {
      await this.answerCallback(normalized.callbackQueryId, USER_MESSAGES.callbackUnknown);
      return { ok: false, unknownAction: true };
    }

    await this.answerCallback(normalized.callbackQueryId, callbackByAction[normalizedAction]);
    if (progressByAction[normalizedAction] && ![
      'render_mode_collage',
      'render_mode_separate',
      'regenerate_images',
      'regenerate_text',
      'regenerate_all',
    ].includes(normalizedAction)) {
      await this.sendProgress(runtime.chat_id, progressByAction[normalizedAction]);
    }

    let result;
    switch (normalizedAction) {
      case 'work_subject_hair':
      case 'work_subject_brows':
        result = await this.handleWorkSubjectChoice(runtime, normalizedAction);
        break;
      case 'render_mode_collage':
      case 'render_mode_separate':
        result = await this.startWorkGenerationFromMode(runtime, action === 'render_mode_collage' ? 'collage' : 'separate');
        break;
      case 'brow_output_before_after':
      case 'brow_output_after_only':
        result = await this.handleWorkBrowOutputChoice(runtime, normalizedAction);
        break;
      case 'background_mode_keep':
      case 'background_mode_blur':
      case 'background_mode_neutral':
        result = await this.handleWorkBackgroundChoice(runtime, normalizedAction);
        break;
      case 'cleanup_on':
      case 'cleanup_off':
        result = await this.handleWorkCleanupChoice(runtime, normalizedAction);
        break;
      case 'version_prev':
        result = await this.changeViewedRevision(runtime, -1);
        break;
      case 'version_next':
        result = await this.changeViewedRevision(runtime, 1);
        break;
      case 'regenerate_images':
      case 'regenerate_text':
      case 'regenerate_all':
        result = await this.queueRuntimeGeneration(runtime, { action });
        break;
      case 'publish_confirm':
        result = await this.markDraftPublished(runtime);
        break;
      case 'cancel':
        result = await this.cancelDraft(runtime.job_id);
        break;
      default:
        result = { ok: false, unknownAction: true };
        break;
    }

    await this.logEvent({
      event: 'callback_handled',
      stage: 'callback',
      chatId: normalized.chatId,
      userId: normalized.userId,
      jobId: runtime.job_id,
      queueId: runtime.preview_payload?.queueId ?? runtime.draft_payload?.queueId ?? '',
      collectionId: runtime.collection_id ?? '',
      status: normalizedAction,
      message: result?.ok === false ? 'not_ok' : 'ok',
    });
    return result;
  }

  async handleTopicPickerCallback({ normalized, action, tokenRow }) {
    const callbackStartedAt = Date.now();
    const pickerJobType = tokenRow.payload?.pickerJobType;
    const sessionId = this.getPickerSessionId(normalized.chatId, pickerJobType);
    const session = await this.repos.getSessionById(sessionId);
    const sessionPayload = safeJsonParse(session?.pending_payload_json, {});

    if (!session || sessionPayload.tokenSetId !== tokenRow.token_set_id) {
      await this.answerCallback(normalized.callbackQueryId, USER_MESSAGES.callbackUseLatestPreview);
      return { ok: false, stalePicker: true };
    }

    if (action === 'picker_cancel') {
      await this.repos.supersedeTokenSet(tokenRow.token_set_id, nowIso());
      await this.repos.deleteSession(sessionId);
      await this.answerCallback(normalized.callbackQueryId, USER_MESSAGES.draftCancelled);
      await this.deleteMessageSafe(normalized.chatId, sessionPayload.messageId);
      return { ok: true, cancelled: true };
    }

    if (action === 'picker_prev' || action === 'picker_next') {
      await this.answerCallback(normalized.callbackQueryId, 'Открываю другую страницу.');
      const picker = await this.presentTopicLikePicker({
        chatId: normalized.chatId,
        userId: normalized.userId,
        jobType: pickerJobType,
        page: Number(tokenRow.payload?.page ?? 0),
        existingMessageId: sessionPayload.messageId ?? normalized.messageId,
      });
      await this.repos.supersedeTokenSet(tokenRow.token_set_id, nowIso());
      if (picker.empty) {
        await this.repos.deleteSession(sessionId);
        return { ok: true, empty: true };
      }
      await this.repos.upsertSession({
        session_id: sessionId,
        chat_id: normalized.chatId,
        user_id: normalized.userId,
        mode: `${pickerJobType}_picker`,
        state: 'choosing_source',
        active_job_id: picker.jobId,
        pending_payload_json: JSON.stringify({
          page: picker.page,
          tokenSetId: picker.tokenSetId,
          messageId: picker.messageId,
          jobType: pickerJobType,
        }),
        expires_at: addMinutes(new Date(), TOPIC_LIKE_PICKER_TTL_MINUTES),
        updated_at: nowIso(),
      });
      this.logDurationBestEffort({
        event: 'picker_page_switched',
        stage: 'picker',
        chatId: normalized.chatId,
        userId: normalized.userId,
        jobId: picker.jobId,
        sourceType: pickerJobType,
        status: 'ok',
        message: `page=${picker.page + 1}`,
      }, callbackStartedAt, { page: picker.page, rowCount: picker.rowCount });
      return { ok: true, pickerPage: picker.page };
    }

    const config = this.getTopicLikeModeConfig(pickerJobType);
    await this.answerCallback(normalized.callbackQueryId, 'Беру эту тему.');
    const reserveStartedAt = Date.now();
    const sourceRow = await this.reserveSourceRow(config.sourceSheetName, tokenRow.payload?.topicId, `telegram:${normalized.chatId}`);
    if (!sourceRow) {
      await this.answerCallback(normalized.callbackQueryId, 'Эта тема уже занята. Выбери другую.');
      const picker = await this.presentTopicLikePicker({
        chatId: normalized.chatId,
        userId: normalized.userId,
        jobType: pickerJobType,
        page: Number(sessionPayload.page ?? 0),
        existingMessageId: sessionPayload.messageId ?? normalized.messageId,
      });
      await this.repos.supersedeTokenSet(tokenRow.token_set_id, nowIso());
      if (picker.empty) {
        await this.repos.deleteSession(sessionId);
        return { ok: false, alreadyReserved: true, empty: true };
      }
      await this.repos.upsertSession({
        session_id: sessionId,
        chat_id: normalized.chatId,
        user_id: normalized.userId,
        mode: `${pickerJobType}_picker`,
        state: 'choosing_source',
        active_job_id: picker.jobId,
        pending_payload_json: JSON.stringify({
          page: picker.page,
          tokenSetId: picker.tokenSetId,
          messageId: picker.messageId,
          jobType: pickerJobType,
        }),
        expires_at: addMinutes(new Date(), TOPIC_LIKE_PICKER_TTL_MINUTES),
        updated_at: nowIso(),
      });
      this.logDurationBestEffort({
        event: 'source_reserve_conflict',
        stage: 'picker',
        chatId: normalized.chatId,
        userId: normalized.userId,
        sourceType: pickerJobType,
        status: 'conflict',
        message: tokenRow.payload?.topicId ?? '',
      }, reserveStartedAt, { rowCount: picker.rowCount });
      return { ok: false, alreadyReserved: true };
    }

    this.logDurationBestEffort({
      event: 'source_reserved',
      stage: 'picker',
      chatId: normalized.chatId,
      userId: normalized.userId,
      sourceType: pickerJobType,
      status: 'ok',
      message: sourceRow.topic_id,
    }, reserveStartedAt);

    await this.repos.supersedeTokenSet(tokenRow.token_set_id, nowIso());
    await this.repos.deleteSession(sessionId);
    await this.deleteMessageSafe(normalized.chatId, sessionPayload.messageId ?? normalized.messageId);
    try {
      return await this.startTopicLikeJob(normalized, sourceRow, pickerJobType);
    } catch (error) {
      if (sourceRow?.topic_id) {
        await this.releaseSourceRow(config.sourceSheetName, sourceRow.topic_id);
      }
      throw error;
    }
  }

  async answerCallback(callbackQueryId, text) {
    if (!callbackQueryId) {
      return;
    }
    await this.callTelegram('answerCallbackQuery', callbackQueryId, { text });
  }

  async getOrCreateWorkCollection(normalized, asset) {
    const currentTime = nowIso();
    const sessionId = this.getWorkSessionId(normalized.chatId);
    const existingSession = await this.repos.getSessionById(sessionId);
    const existingSessionPayload = this.parseWorkSessionPayload(existingSession);
    const collectionKey = normalized.mediaGroupId
      ? `group:${normalized.chatId}:${normalized.mediaGroupId}`
      : null;
    let reopenedAwaitingChoice = false;

    let collection = null;
    if (collectionKey) {
      const collectionId = stableId('COL', collectionKey);
      const existingCollection = await this.repos.getCollectionById(collectionId);
      collection = await this.repos.mergeAlbumCollection({
        collectionId,
        collectionKey,
        chatId: normalized.chatId,
        userId: normalized.userId,
        messageId: normalized.messageId,
        mediaGroupId: normalized.mediaGroupId,
        asset,
        currentTime,
        debounceDeadlineAt: this.getCollectionDeadlineAt(currentTime, {
          mediaGroupId: normalized.mediaGroupId,
          assetCount: 1,
        }),
        buildDeadlineAt: (assetCount) => this.getCollectionDeadlineAt(currentTime, {
          mediaGroupId: normalized.mediaGroupId,
          assetCount,
        }),
      });
      if (
        existingCollection
        && ['awaiting_brow_output_mode', 'awaiting_render_mode', 'awaiting_background_mode', 'awaiting_cleanup_mode'].includes(String(existingCollection.status ?? ''))
        && Number(existingCollection.count ?? 0) < 3
        && Number(collection.count ?? 0) > Number(existingCollection.count ?? 0)
      ) {
        reopenedAwaitingChoice = true;
        await this.repos.updateCollection({
          collection_id: collection.collection_id,
          status: 'collecting',
          closed_by_job_id: '',
          deadline_at: this.getCollectionDeadlineAt(currentTime, {
            mediaGroupId: normalized.mediaGroupId,
            assetCount: collection.count,
          }),
          updated_at: currentTime,
        });
        collection = await this.repos.getCollectionById(collection.collection_id);
      }
    } else {
      const openCollection = await this.repos.getOpenCollectionForChat(normalized.chatId);
      if (
        openCollection
        && !openCollection.media_group_id
        && new Date(openCollection.deadline_at).getTime() > Date.now()
        && openCollection.count < 3
      ) {
        const assets = [...openCollection.assets, asset];
        collection = {
          ...openCollection,
          asset_refs_json: JSON.stringify(assets),
          count: assets.length,
          deadline_at: this.getCollectionDeadlineAt(currentTime, {
            mediaGroupId: normalized.mediaGroupId,
            assetCount: assets.length,
          }),
          last_message_at: currentTime,
          updated_at: currentTime,
        };
        await this.repos.updateCollection(collection);
      } else {
        const singleCollectionKey = `single:${normalized.chatId}:${normalized.messageId ?? currentTime}`;
        const collectionId = stableId('COL', singleCollectionKey);
        collection = this.createWorkCollectionRecord(normalized, asset, collectionId, singleCollectionKey, currentTime);
        await this.repos.createCollection(collection);
      }
    }

    await this.repos.upsertSession({
      session_id: sessionId,
      chat_id: normalized.chatId,
      user_id: normalized.userId,
      mode: 'work',
      state: 'awaiting_assets',
      active_job_id: '',
      pending_payload_json: JSON.stringify({
        ...existingSessionPayload,
        collectionId: collection.collection_id,
      }),
      expires_at: addMinutes(currentTime, WORK_SESSION_TTL_MINUTES),
      updated_at: currentTime,
    });
    return {
      collection: {
        ...collection,
        assets: safeJsonParse(collection.asset_refs_json, [asset]),
      },
      created: collection.count === 1,
      reopenedAwaitingRenderMode: reopenedAwaitingChoice,
    };
  }

  createWorkCollectionRecord(normalized, asset, collectionId, collectionKey, currentTime) {
    return {
      collection_id: collectionId,
      collection_key: collectionKey,
      chat_id: normalized.chatId,
      user_id: normalized.userId,
      first_message_id: normalized.messageId,
      media_group_id: normalized.mediaGroupId ?? '',
      status: 'collecting',
      asset_refs_json: JSON.stringify([asset]),
      count: 1,
      deadline_at: this.getCollectionDeadlineAt(currentTime, {
        mediaGroupId: normalized.mediaGroupId,
        assetCount: 1,
      }),
      last_message_at: currentTime,
      closed_by_job_id: '',
      created_at: currentTime,
      updated_at: currentTime,
    };
  }

  async promptWorkRenderMode(collection) {
    const jobId = stableId('JOB', `work:${collection.collection_id}`);
    const queueId = stableId('QUE', jobId);
    const existingRuntime = await this.repos.getRuntime(jobId);
    const session = await this.repos.getSessionById(this.getWorkSessionId(collection.chat_id));
    const sessionPayload = this.parseWorkSessionPayload(session);
    const promptMode = sessionPayload.promptMode
      || existingRuntime?.draft_payload?.promptMode
      || existingRuntime?.preview_payload?.promptMode
      || 'normal';
    const photoType = this.getWorkPhotoType(
      sessionPayload.photoType
      ?? existingRuntime?.draft_payload?.photoType
      ?? existingRuntime?.preview_payload?.photoType,
    );
    const subjectType = this.getWorkSubjectType(sessionPayload.subjectType);
    const sourceAssetCount = collection.assets.length;
    const isSinglePhoto = sourceAssetCount === 1;

    if (existingRuntime && !['awaiting_subject_type', 'awaiting_brow_output_mode', 'awaiting_render_mode', 'awaiting_background_mode', 'awaiting_cleanup_mode', 'collecting'].includes(existingRuntime.runtime_status)) {
      return { ok: true, skipped: true, jobId, queueId };
    }

    await this.repos.closeCollection({
      collection_id: collection.collection_id,
      status: 'awaiting_subject_type',
      closed_by_job_id: jobId,
      updated_at: nowIso(),
    });

    const actions = ['work_subject_hair', 'work_subject_brows', 'cancel'];
    const { tokenRows, tokensByAction, tokenSetId } = this.createCallbackSet({
      jobId,
      revision: 0,
      chatId: collection.chat_id,
      actions,
    });
    await this.repos.createCallbackTokens(tokenRows);

    const draftPayload = {
      jobId,
      queueId,
      jobType: 'work',
      revision: 0,
      viewRevision: 0,
      chatId: collection.chat_id,
      userId: collection.user_id,
      topicId: '',
      collectionId: collection.collection_id,
      captionText: '',
      photoType,
      subjectType,
      browOutputMode: '',
      promptMode,
      renderMode: isSinglePhoto ? 'separate' : '',
      finalRenderMode: '',
      backgroundMode: photoType === 'studio' ? 'neutral' : '',
      cleanupMode: 'off',
      sourceAssetCount: collection.assets.length,
      originalTelegramFileIds: collection.assets.map((asset) => asset.fileId),
      previewTelegramFileIds: [],
      revisionHistory: [],
      createdAt: nowIso(),
    };

    const promptMessage = await this.sendWorkSubjectPrompt({
      chatId: collection.chat_id,
      tokensByAction,
      existingMessageId: existingRuntime?.text_message_id ?? sessionPayload.textMessageId ?? null,
    });

    await this.repos.upsertRuntime({
      job_id: jobId,
      job_type: 'work',
      chat_id: collection.chat_id,
      user_id: collection.user_id,
      topic_id: '',
      collection_id: collection.collection_id,
      active_revision: 0,
      runtime_status: 'awaiting_subject_type',
      collage_message_id: toStoredText(existingRuntime?.collage_message_id),
      assets_message_ids_json: JSON.stringify(existingRuntime?.assets_message_ids ?? []),
      text_message_id: toStoredText(promptMessage.textMessageId),
      active_callback_set_id: toStoredText(tokenSetId),
      schedule_input_pending: 0,
      lock_flags_json: JSON.stringify({ source_type: 'work' }),
      preview_payload_json: JSON.stringify(draftPayload),
      draft_payload_json: JSON.stringify(draftPayload),
      updated_at: nowIso(),
    });
    await this.repos.deleteSession(this.getWorkSessionId(collection.chat_id));

    this.logEventBestEffort({
      event: 'work_subject_requested',
      stage: 'collection',
      chatId: collection.chat_id,
      userId: collection.user_id,
      jobId,
      queueId,
      collectionId: collection.collection_id,
      sourceType: 'work',
      status: 'awaiting_subject_type',
      message: `count=${collection.assets.length}`,
      payload: {
        mediaGroupId: collection.media_group_id ?? '',
        sourceAssetCount: collection.assets.length,
        promptMode,
        photoType,
        subjectType,
      },
    });

    return { ok: true, jobId, queueId };
  }

  async startWorkGenerationFromMode(runtime, renderMode) {
    const collection = await this.repos.getCollectionById(runtime.collection_id);
    if (!collection) {
      throw new Error(`Collection not found for ${runtime.job_id}`);
    }
    const previousPayload = runtime.draft_payload ?? runtime.preview_payload ?? {};
    const subjectType = this.getWorkSubjectType(previousPayload.subjectType);
    const preferredBackgroundMode = this.getPreferredWorkBackgroundMode(previousPayload);
    const nextPayload = {
      ...previousPayload,
      renderMode,
      browOutputMode: subjectType === 'brows' ? (previousPayload.browOutputMode || '') : '',
      backgroundMode: preferredBackgroundMode,
      cleanupMode: 'off',
    };
    await this.logEvent({
      event: 'render_mode_selected',
      stage: 'collection',
      chatId: runtime.chat_id,
      userId: runtime.user_id,
      jobId: runtime.job_id,
      queueId: runtime.preview_payload?.queueId ?? runtime.draft_payload?.queueId ?? '',
      collectionId: runtime.collection_id,
      sourceType: 'work',
      status: renderMode,
      message: renderMode,
      payload: {
        sourceAssetCount: collection.assets.length,
        mediaGroupId: collection.media_group_id ?? '',
      },
    });
    if (subjectType === 'brows') {
      return this.promptWorkBrowOutputChoice(runtime, {
        nextPayload,
        collection,
      });
    }
    if (preferredBackgroundMode === 'neutral') {
      return this.queueInitialWorkGeneration(runtime, {
        nextPayload,
        runtimeStatus: 'awaiting_background_mode',
        collection,
        collectionStatus: 'awaiting_background_mode',
      });
    }
    return this.promptWorkBackgroundChoice(runtime, {
      nextPayload,
      collection,
    });
  }

  async handleWorkSessionCallback({ normalized, action, tokenRow }) {
    const sessionId = this.getWorkSessionId(normalized.chatId);
    const session = await this.repos.getSessionById(sessionId);
    const sessionPayload = this.parseWorkSessionPayload(session);
    if (
      !session
      || !['awaiting_photo_type', 'awaiting_subject_type', 'awaiting_prompt_mode'].includes(String(session.state ?? ''))
      || sessionPayload.tokenSetId !== tokenRow.token_set_id
    ) {
      await this.answerCallback(normalized.callbackQueryId, USER_MESSAGES.callbackUseLatestPreview);
      return { ok: false, staleWizard: true };
    }
    if (action === 'cancel') {
      await this.repos.supersedeTokenSet(tokenRow.token_set_id, nowIso());
      await this.repos.deleteSession(sessionId);
      if (sessionPayload.textMessageId) {
        await this.deleteMessageSafe(normalized.chatId, sessionPayload.textMessageId);
      }
      return { ok: true, cancelled: true };
    }
    if (session.state === 'awaiting_photo_type') {
      const photoType = action === 'work_photo_type_studio' ? 'studio' : 'normal';
      await this.repos.supersedeTokenSet(tokenRow.token_set_id, nowIso());
      const photoRequest = await this.upsertControlMessage(normalized.chatId, USER_MESSAGES.workPhotoRequest, {
        existingMessageId: sessionPayload.textMessageId ?? normalized.messageId ?? null,
        replyMarkup: { inline_keyboard: [] },
      });
      await this.repos.upsertSession({
        session_id: sessionId,
        chat_id: normalized.chatId,
        user_id: normalized.userId,
        mode: 'work',
        state: 'awaiting_assets',
        active_job_id: '',
        pending_payload_json: JSON.stringify({
          ...sessionPayload,
          tokenSetId: '',
          textMessageId: photoRequest,
          photoType,
          backgroundMode: photoType === 'studio' ? 'neutral' : '',
          browOutputMode: '',
        }),
        expires_at: addMinutes(new Date(), WORK_SESSION_TTL_MINUTES),
        updated_at: nowIso(),
      });
      return { ok: true, photoType };
    }
    if (session.state === 'awaiting_subject_type') {
      const subjectType = action === 'work_subject_brows' ? 'brows' : 'hair';
      await this.repos.supersedeTokenSet(tokenRow.token_set_id, nowIso());
      const { tokenRows, tokensByAction, tokenSetId } = this.createCallbackSet({
        jobId: this.getWorkSessionJobId(normalized.chatId),
        revision: 0,
        chatId: normalized.chatId,
        actions: ['work_prompt_mode_normal', 'work_prompt_mode_test', 'cancel'],
      });
      await this.repos.createCallbackTokens(tokenRows);
      const promptMessage = await this.sendWorkPromptModePrompt({
        chatId: normalized.chatId,
        tokensByAction,
        existingMessageId: sessionPayload.textMessageId ?? normalized.messageId ?? null,
      });
      await this.repos.upsertSession({
        session_id: sessionId,
        chat_id: normalized.chatId,
        user_id: normalized.userId,
        mode: 'work',
        state: 'awaiting_prompt_mode',
        active_job_id: '',
        pending_payload_json: JSON.stringify({
          ...sessionPayload,
          tokenSetId,
          subjectType,
          browOutputMode: subjectType === 'brows' ? 'after_only' : '',
          textMessageId: promptMessage.textMessageId,
        }),
        expires_at: addMinutes(new Date(), WORK_SESSION_TTL_MINUTES),
        updated_at: nowIso(),
      });
      return { ok: true, subjectType };
    }
    const promptMode = action === 'work_prompt_mode_test' ? 'test' : 'normal';
    const photoRequest = await this.upsertControlMessage(normalized.chatId, USER_MESSAGES.workPhotoRequest, {
      existingMessageId: sessionPayload.textMessageId ?? normalized.messageId ?? null,
      replyMarkup: { inline_keyboard: [] },
    });
    await this.repos.upsertSession({
      session_id: sessionId,
      chat_id: normalized.chatId,
      user_id: normalized.userId,
      mode: 'work',
      state: 'awaiting_assets',
      active_job_id: '',
      pending_payload_json: JSON.stringify({
        ...sessionPayload,
        tokenSetId: '',
        promptMode,
        textMessageId: photoRequest,
        browOutputMode: '',
      }),
      expires_at: addMinutes(new Date(), WORK_SESSION_TTL_MINUTES),
      updated_at: nowIso(),
    });
    return { ok: true, promptMode };
  }

  async handleWorkSubjectChoice(runtime, action) {
    const previousPayload = runtime.draft_payload ?? runtime.preview_payload ?? {};
    const collection = await this.repos.getCollectionById(runtime.collection_id);
    const subjectType = action === 'work_subject_brows' ? 'brows' : 'hair';
    const sourceAssetCount = Number(collection?.assets?.length ?? previousPayload.sourceAssetCount ?? 1);
    const isSinglePhoto = sourceAssetCount <= 1;
    const preferredBackgroundMode = this.getPreferredWorkBackgroundMode(previousPayload);
    const nextPayload = {
      ...previousPayload,
      subjectType,
      promptMode: previousPayload.promptMode || 'normal',
      browOutputMode: subjectType === 'brows' ? (previousPayload.browOutputMode || 'after_only') : '',
      renderMode: isSinglePhoto ? 'separate' : (previousPayload.renderMode || ''),
      backgroundMode: preferredBackgroundMode,
      cleanupMode: 'off',
    };

    await this.logEvent({
      event: 'work_subject_selected',
      stage: 'collection',
      chatId: runtime.chat_id,
      userId: runtime.user_id,
      jobId: runtime.job_id,
      queueId: runtime.preview_payload?.queueId ?? runtime.draft_payload?.queueId ?? '',
      collectionId: runtime.collection_id,
      sourceType: 'work',
      status: subjectType,
      message: subjectType,
      payload: {
        sourceAssetCount,
      },
    });

    if (!isSinglePhoto) {
      return this.promptWorkRenderModeChoice(runtime, {
        nextPayload,
        collection,
        subjectType,
      });
    }
    if (subjectType === 'brows') {
      return this.promptWorkBrowOutputChoice(runtime, {
        nextPayload,
        collection,
      });
    }
    if (preferredBackgroundMode === 'neutral') {
      return this.queueInitialWorkGeneration(runtime, {
        nextPayload,
        runtimeStatus: 'awaiting_background_mode',
        collection,
        collectionStatus: 'awaiting_background_mode',
      });
    }
    return this.promptWorkBackgroundChoice(runtime, {
      nextPayload,
      collection,
      subjectType,
    });
  }

  async handleWorkBrowOutputChoice(runtime, action) {
    const previousPayload = runtime.draft_payload ?? runtime.preview_payload ?? {};
    const collection = await this.repos.getCollectionById(runtime.collection_id);
    const browOutputMode = action === 'brow_output_before_after' ? 'before_after' : 'after_only';
    const preferredBackgroundMode = this.getPreferredWorkBackgroundMode(previousPayload);
    const nextPayload = {
      ...previousPayload,
      subjectType: 'brows',
      browOutputMode,
      backgroundMode: preferredBackgroundMode,
      cleanupMode: previousPayload.cleanupMode ?? 'off',
    };
    const sourceAssetCount = Number(collection?.assets?.length ?? previousPayload.sourceAssetCount ?? 1);

    await this.logEvent({
      event: 'brow_output_mode_selected',
      stage: 'collection',
      chatId: runtime.chat_id,
      userId: runtime.user_id,
      jobId: runtime.job_id,
      queueId: runtime.preview_payload?.queueId ?? runtime.draft_payload?.queueId ?? '',
      collectionId: runtime.collection_id,
      sourceType: 'work',
      status: browOutputMode,
      message: browOutputMode,
      payload: {
        sourceAssetCount,
      },
    });

    if (preferredBackgroundMode === 'neutral') {
      return this.queueInitialWorkGeneration(runtime, {
        nextPayload,
        runtimeStatus: 'awaiting_background_mode',
        collection,
        collectionStatus: 'awaiting_background_mode',
      });
    }
    return this.promptWorkBackgroundChoice(runtime, {
      nextPayload,
      collection,
    });
  }

  async handleWorkBackgroundChoice(runtime, action) {
    const previousPayload = runtime.draft_payload ?? runtime.preview_payload ?? {};
    const collection = await this.repos.getCollectionById(runtime.collection_id);
    const backgroundMode = action === 'background_mode_neutral'
      ? 'neutral'
      : action === 'background_mode_keep'
        ? 'keep'
        : 'blur';
    const nextPayload = {
      ...previousPayload,
      photoType: backgroundMode === 'neutral'
        ? 'studio'
        : (previousPayload.photoType || 'normal'),
      backgroundMode,
      cleanupMode: backgroundMode === 'neutral' ? 'off' : (previousPayload.cleanupMode ?? 'off'),
    };
    if (backgroundMode === 'neutral') {
      return this.queueInitialWorkGeneration(runtime, {
        nextPayload,
        runtimeStatus: 'awaiting_background_mode',
        collection,
        collectionStatus: 'awaiting_background_mode',
      });
    }

    if (collection) {
      await this.repos.updateCollection({
        collection_id: collection.collection_id,
        status: 'awaiting_cleanup_mode',
        closed_by_job_id: runtime.job_id,
        deadline_at: collection.deadline_at,
        updated_at: nowIso(),
      });
    }
    const { tokenRows, tokensByAction, tokenSetId } = this.createCallbackSet({
      jobId: runtime.job_id,
      revision: 0,
      chatId: runtime.chat_id,
      actions: ['cleanup_on', 'cleanup_off', 'cancel'],
    });
    if (runtime.active_callback_set_id) {
      await this.repos.supersedeTokenSet(runtime.active_callback_set_id, nowIso());
    }
    await this.repos.createCallbackTokens(tokenRows);
    const promptMessage = await this.sendWorkCleanupPrompt({
      chatId: runtime.chat_id,
      tokensByAction,
      existingMessageId: runtime.text_message_id ?? null,
    });
    await this.repos.upsertRuntime({
      job_id: runtime.job_id,
      job_type: runtime.job_type,
      chat_id: runtime.chat_id,
      user_id: runtime.user_id,
      topic_id: runtime.topic_id ?? '',
      collection_id: runtime.collection_id ?? '',
      active_revision: runtime.active_revision,
      runtime_status: 'awaiting_cleanup_mode',
      collage_message_id: toStoredText(runtime.collage_message_id),
      assets_message_ids_json: JSON.stringify(runtime.assets_message_ids ?? []),
      text_message_id: toStoredText(promptMessage.textMessageId),
      active_callback_set_id: toStoredText(tokenSetId),
      schedule_input_pending: 0,
      lock_flags_json: JSON.stringify(runtime.lock_flags ?? {}),
      preview_payload_json: JSON.stringify(nextPayload),
      draft_payload_json: JSON.stringify(nextPayload),
      updated_at: nowIso(),
    });
    return { ok: true, awaiting: 'cleanup_mode' };
  }

  async handleWorkCleanupChoice(runtime, action) {
    const previousPayload = runtime.draft_payload ?? runtime.preview_payload ?? {};
    const nextPayload = {
      ...previousPayload,
      cleanupMode: action === 'cleanup_on' ? 'on' : 'off',
    };
    return this.queueInitialWorkGeneration(runtime, {
      nextPayload,
      runtimeStatus: 'awaiting_cleanup_mode',
      collection: await this.repos.getCollectionById(runtime.collection_id),
      collectionStatus: 'awaiting_cleanup_mode',
    });
  }

  async updateWorkRuntimePayload(runtime, { nextPayload, runtimeStatus = null }) {
    await this.repos.upsertRuntime({
      job_id: runtime.job_id,
      job_type: runtime.job_type,
      chat_id: runtime.chat_id,
      user_id: runtime.user_id,
      topic_id: runtime.topic_id ?? '',
      collection_id: runtime.collection_id ?? '',
      active_revision: runtime.active_revision,
      runtime_status: runtimeStatus ?? runtime.runtime_status,
      collage_message_id: toStoredText(runtime.collage_message_id),
      assets_message_ids_json: JSON.stringify(runtime.assets_message_ids ?? []),
      text_message_id: toStoredText(runtime.text_message_id),
      active_callback_set_id: toStoredText(runtime.active_callback_set_id),
      schedule_input_pending: 0,
      lock_flags_json: JSON.stringify(runtime.lock_flags ?? {}),
      preview_payload_json: JSON.stringify(nextPayload),
      draft_payload_json: JSON.stringify(nextPayload),
      updated_at: nowIso(),
    });
  }

  async promptWorkRenderModeChoice(runtime, { nextPayload, collection, subjectType = 'hair' } = {}) {
    const { tokenRows, tokensByAction, tokenSetId } = this.createCallbackSet({
      jobId: runtime.job_id,
      revision: 0,
      chatId: runtime.chat_id,
      actions: ['render_mode_collage', 'render_mode_separate', 'cancel'],
    });
    if (runtime.active_callback_set_id) {
      await this.repos.supersedeTokenSet(runtime.active_callback_set_id, nowIso());
    }
    await this.repos.createCallbackTokens(tokenRows);
    const promptMessage = await this.sendRenderModePrompt({
      chatId: runtime.chat_id,
      tokensByAction,
      existingMessageId: runtime.text_message_id ?? null,
    });
    await this.repos.upsertRuntime({
      job_id: runtime.job_id,
      job_type: runtime.job_type,
      chat_id: runtime.chat_id,
      user_id: runtime.user_id,
      topic_id: runtime.topic_id ?? '',
      collection_id: runtime.collection_id ?? '',
      active_revision: runtime.active_revision,
      runtime_status: 'awaiting_render_mode',
      collage_message_id: toStoredText(runtime.collage_message_id),
      assets_message_ids_json: JSON.stringify(runtime.assets_message_ids ?? []),
      text_message_id: toStoredText(promptMessage.textMessageId),
      active_callback_set_id: toStoredText(tokenSetId),
      schedule_input_pending: 0,
      lock_flags_json: JSON.stringify(runtime.lock_flags ?? {}),
      preview_payload_json: JSON.stringify(nextPayload),
      draft_payload_json: JSON.stringify(nextPayload),
      updated_at: nowIso(),
    });
    if (collection) {
      await this.repos.updateCollection({
        collection_id: collection.collection_id,
        status: 'awaiting_render_mode',
        closed_by_job_id: runtime.job_id,
        deadline_at: collection.deadline_at,
        updated_at: nowIso(),
      });
    }
    return { ok: true, awaiting: 'render_mode', subjectType };
  }

  async promptWorkBrowOutputChoice(runtime, { nextPayload, collection } = {}) {
    const { tokenRows, tokensByAction, tokenSetId } = this.createCallbackSet({
      jobId: runtime.job_id,
      revision: 0,
      chatId: runtime.chat_id,
      actions: ['brow_output_before_after', 'brow_output_after_only', 'cancel'],
    });
    if (runtime.active_callback_set_id) {
      await this.repos.supersedeTokenSet(runtime.active_callback_set_id, nowIso());
    }
    await this.repos.createCallbackTokens(tokenRows);
    const promptMessage = await this.sendWorkBrowOutputPrompt({
      chatId: runtime.chat_id,
      tokensByAction,
      existingMessageId: runtime.text_message_id ?? null,
    });
    await this.repos.upsertRuntime({
      job_id: runtime.job_id,
      job_type: runtime.job_type,
      chat_id: runtime.chat_id,
      user_id: runtime.user_id,
      topic_id: runtime.topic_id ?? '',
      collection_id: runtime.collection_id ?? '',
      active_revision: runtime.active_revision,
      runtime_status: 'awaiting_brow_output_mode',
      collage_message_id: toStoredText(runtime.collage_message_id),
      assets_message_ids_json: JSON.stringify(runtime.assets_message_ids ?? []),
      text_message_id: toStoredText(promptMessage.textMessageId),
      active_callback_set_id: toStoredText(tokenSetId),
      schedule_input_pending: 0,
      lock_flags_json: JSON.stringify(runtime.lock_flags ?? {}),
      preview_payload_json: JSON.stringify(nextPayload),
      draft_payload_json: JSON.stringify(nextPayload),
      updated_at: nowIso(),
    });
    if (collection) {
      await this.repos.updateCollection({
        collection_id: collection.collection_id,
        status: 'awaiting_brow_output_mode',
        closed_by_job_id: runtime.job_id,
        deadline_at: collection.deadline_at,
        updated_at: nowIso(),
      });
    }
    return { ok: true, awaiting: 'brow_output_mode' };
  }

  async promptWorkBackgroundChoice(runtime, { nextPayload, collection, subjectType = '' } = {}) {
    const actions = this.getWorkBackgroundActions(nextPayload);
    const { tokenRows, tokensByAction, tokenSetId } = this.createCallbackSet({
      jobId: runtime.job_id,
      revision: 0,
      chatId: runtime.chat_id,
      actions,
    });
    if (runtime.active_callback_set_id) {
      await this.repos.supersedeTokenSet(runtime.active_callback_set_id, nowIso());
    }
    await this.repos.createCallbackTokens(tokenRows);
    const promptMessage = await this.sendWorkBackgroundPrompt({
      chatId: runtime.chat_id,
      tokensByAction,
      existingMessageId: runtime.text_message_id ?? null,
      includeStudioOption: actions.includes('background_mode_neutral'),
    });
    await this.repos.upsertRuntime({
      job_id: runtime.job_id,
      job_type: runtime.job_type,
      chat_id: runtime.chat_id,
      user_id: runtime.user_id,
      topic_id: runtime.topic_id ?? '',
      collection_id: runtime.collection_id ?? '',
      active_revision: runtime.active_revision,
      runtime_status: 'awaiting_background_mode',
      collage_message_id: toStoredText(runtime.collage_message_id),
      assets_message_ids_json: JSON.stringify(runtime.assets_message_ids ?? []),
      text_message_id: toStoredText(promptMessage.textMessageId),
      active_callback_set_id: toStoredText(tokenSetId),
      schedule_input_pending: 0,
      lock_flags_json: JSON.stringify(runtime.lock_flags ?? {}),
      preview_payload_json: JSON.stringify(nextPayload),
      draft_payload_json: JSON.stringify(nextPayload),
      updated_at: nowIso(),
    });
    if (collection) {
      await this.repos.updateCollection({
        collection_id: collection.collection_id,
        status: 'awaiting_background_mode',
        closed_by_job_id: runtime.job_id,
        deadline_at: collection.deadline_at,
        updated_at: nowIso(),
      });
    }
    return { ok: true, awaiting: 'background_mode', subjectType };
  }

  async queueInitialWorkGeneration(runtime, {
    nextPayload,
    runtimeStatus,
    collection = null,
    collectionStatus = runtimeStatus,
  } = {}) {
    if (collection && collectionStatus) {
      await this.repos.updateCollection({
        collection_id: collection.collection_id,
        status: collectionStatus,
        closed_by_job_id: runtime.job_id,
        deadline_at: collection.deadline_at,
        updated_at: nowIso(),
      });
    }
    await this.updateWorkRuntimePayload(runtime, {
      nextPayload,
      runtimeStatus,
    });
    return this.queueRuntimeGeneration({
      ...runtime,
      draft_payload: nextPayload,
      preview_payload: nextPayload,
    }, {
      action: 'generate_initial',
      renderMode: nextPayload.renderMode || 'separate',
    });
  }

  async changeViewedRevision(runtime, direction) {
    const startedAt = Date.now();
    const payload = runtime.draft_payload ?? runtime.preview_payload;
    const history = this.getRevisionHistory(payload);
    if (history.length === 0) {
      return { ok: false, empty: true };
    }
    const currentRevision = Number(payload?.viewRevision ?? payload?.revision ?? history.at(-1).revision);
    const currentIndex = history.findIndex((entry) => entry.revision === currentRevision);
    const nextIndex = Math.max(0, Math.min(history.length - 1, currentIndex + direction));
    const nextRevision = history[nextIndex];
    if (!nextRevision || nextRevision.revision === currentRevision) {
      return { ok: true, unchanged: true };
    }

    const tokenRows = await this.repos.listCallbackTokensByTokenSet(runtime.active_callback_set_id);
    const tokensByAction = Object.fromEntries(tokenRows.map((row) => [row.action, row.token]));

    const nextPayload = {
      ...payload,
      viewRevision: nextRevision.revision,
    };
    const currentRevisionEntry = history[currentIndex] ?? null;
    const shouldSwapMedia = payload?.jobType === 'work'
      ? false
      : (
        JSON.stringify(nextRevision.previewTelegramFileIds ?? [])
        !== JSON.stringify(currentRevisionEntry?.previewTelegramFileIds ?? [])
      );
    const presentation = shouldSwapMedia
      ? await this.presentPreviewRevision({
        chatId: runtime.chat_id,
        payload: nextPayload,
        revisionEntry: nextRevision,
        tokensByAction,
        runtime,
      })
      : await this.presentRevisionTextOnly({
        chatId: runtime.chat_id,
        payload: nextPayload,
        revisionEntry: nextRevision,
        tokensByAction,
        runtime,
      });

    await this.repos.upsertRuntime({
      job_id: runtime.job_id,
      job_type: runtime.job_type,
      chat_id: runtime.chat_id,
      user_id: runtime.user_id,
      topic_id: runtime.topic_id ?? '',
      collection_id: runtime.collection_id ?? '',
      active_revision: runtime.active_revision,
      runtime_status: runtime.runtime_status,
      collage_message_id: toStoredText(presentation.collageMessageId),
      assets_message_ids_json: JSON.stringify(presentation.assetsMessageIds),
      text_message_id: toStoredText(presentation.textMessageId),
      active_callback_set_id: toStoredText(runtime.active_callback_set_id),
      schedule_input_pending: 0,
      lock_flags_json: JSON.stringify(runtime.lock_flags),
      preview_payload_json: JSON.stringify(nextPayload),
      draft_payload_json: JSON.stringify(nextPayload),
      updated_at: nowIso(),
    });
    if (runtime.job_type !== 'work' && runtime.topic_id) {
      const sourceSheet = runtime.lock_flags?.source_sheet ?? this.getTopicLikeSourceSheet(runtime.job_type);
      await this.ensureSourceRowReserved(sourceSheet, runtime.topic_id, runtime.job_id);
    }

    await this.logEvent({
      event: 'revision_changed',
      stage: 'preview',
      chatId: runtime.chat_id,
      userId: runtime.user_id,
      jobId: runtime.job_id,
      queueId: nextPayload.queueId ?? '',
      collectionId: runtime.collection_id ?? '',
      sourceType: runtime.job_type,
      status: 'ok',
      message: `view=${nextRevision.revision}/${history.length}`,
      durationMs: Date.now() - startedAt,
    });
    return { ok: true, revision: nextRevision.revision };
  }

  createCallbackSet({ jobId, revision, chatId, actions }) {
    const { tokenRows, entries, tokenSetId } = this.createCallbackRows({
      jobId,
      revision,
      chatId,
      definitions: actions.map((action) => ({ action })),
    });
    const tokensByAction = Object.fromEntries(entries.map((entry) => [entry.action, entry.token]));

    return {
      tokenRows,
      tokensByAction,
      tokenSetId,
    };
  }

  getWorkSessionId(chatId) {
    return `work:${chatId}`;
  }

  getWorkSessionJobId(chatId) {
    return stableId('JOB', `work-session:${chatId}`);
  }

  getWorkPhotoType(value) {
    return String(value ?? '') === 'studio' ? 'studio' : 'normal';
  }

  getPreferredWorkBackgroundMode(payload = {}) {
    return String(payload.backgroundMode ?? '') === 'neutral'
      || this.getWorkPhotoType(payload.photoType) === 'studio'
      ? 'neutral'
      : '';
  }

  hasExplicitWorkPhotoType(payload = {}) {
    const value = String(payload.photoType ?? '');
    return value === 'normal' || value === 'studio';
  }

  getWorkBackgroundActions(payload = {}) {
    const actions = ['background_mode_keep', 'background_mode_blur'];
    if (!this.hasExplicitWorkPhotoType(payload)) {
      actions.push('background_mode_neutral');
    }
    actions.push('cancel');
    return actions;
  }

  parseWorkSessionPayload(session) {
    return safeJsonParse(session?.pending_payload_json, {}) ?? {};
  }

  async sendWorkPhotoTypePrompt({ chatId, tokensByAction, existingMessageId = null }) {
    const text = [USER_MESSAGES.workPhotoTypeChoice, USER_MESSAGES.workPhotoTypeChoiceHint].join('\n');
    const textMessageId = await this.upsertControlMessage(chatId, text, {
      existingMessageId,
      replyMarkup: buildWorkPhotoTypeKeyboard(tokensByAction),
    });
    return { textMessageId };
  }

  async sendWorkSubjectPrompt({ chatId, tokensByAction, existingMessageId = null }) {
    const text = [USER_MESSAGES.workSubjectChoice, USER_MESSAGES.workSubjectChoiceHint].join('\n');
    const textMessageId = await this.upsertControlMessage(chatId, text, {
      existingMessageId,
      replyMarkup: buildWorkSubjectKeyboard(tokensByAction),
    });
    return { textMessageId };
  }

  async sendWorkPromptModePrompt({ chatId, tokensByAction, existingMessageId = null }) {
    const text = [USER_MESSAGES.workPromptModeChoice, USER_MESSAGES.workPromptModeHint].join('\n');
    const textMessageId = await this.upsertControlMessage(chatId, text, {
      existingMessageId,
      replyMarkup: buildWorkPromptModeKeyboard(tokensByAction),
    });
    return { textMessageId };
  }

  async sendRenderModePrompt({ chatId, tokensByAction, existingMessageId = null }) {
    const text = [USER_MESSAGES.workModeChoice, USER_MESSAGES.workModeChoiceHint].join('\n');
    const textMessageId = await this.upsertControlMessage(chatId, text, {
      existingMessageId,
      replyMarkup: buildRenderModeKeyboard(tokensByAction),
    });
    return { textMessageId };
  }

  async sendWorkBrowOutputPrompt({ chatId, tokensByAction, existingMessageId = null }) {
    const text = [USER_MESSAGES.workBrowOutputChoice, USER_MESSAGES.workBrowOutputChoiceHint].join('\n');
    const textMessageId = await this.upsertControlMessage(chatId, text, {
      existingMessageId,
      replyMarkup: buildWorkBrowOutputKeyboard(tokensByAction),
    });
    return { textMessageId };
  }

  async sendWorkBackgroundPrompt({
    chatId,
    tokensByAction,
    existingMessageId = null,
    includeStudioOption = true,
  }) {
    const text = [USER_MESSAGES.workBackgroundChoice, USER_MESSAGES.workBackgroundChoiceHint].join('\n');
    const textMessageId = await this.upsertControlMessage(chatId, text, {
      existingMessageId,
      replyMarkup: buildWorkBackgroundKeyboard(tokensByAction, { includeStudioOption }),
    });
    return { textMessageId };
  }

  async sendWorkCleanupPrompt({ chatId, tokensByAction, existingMessageId = null }) {
    const text = [USER_MESSAGES.workCleanupChoice, USER_MESSAGES.workCleanupChoiceHint].join('\n');
    const textMessageId = await this.upsertControlMessage(chatId, text, {
      existingMessageId,
      replyMarkup: buildWorkCleanupKeyboard(tokensByAction),
    });
    return { textMessageId };
  }

  async sendPreviewAlbum({ chatId, assets, jobId, revision }) {
    const files = assets.map((asset, index) => this.buildTelegramMediaAsset(asset, jobId, index));
    const sent = await this.callTelegram(
      'sendMediaGroup',
      chatId,
      files.map((file) => ({ type: 'photo', media: file })),
    );
    return {
      assetsMessageIds: sent.map((message) => message.message_id),
      previewTelegramFileIds: this.extractPreviewTelegramFileIds(sent, `preview:${jobId}:${revision}`),
    };
  }

  async upsertPreviewAlbum({
    chatId,
    assets,
    jobId,
    revision,
    existingMessageIds = [],
  }) {
    const reusableMessageIds = Array.isArray(existingMessageIds)
      ? existingMessageIds.filter(Boolean)
      : [];
    if (reusableMessageIds.length === assets.length && assets.length > 0) {
      const editedMessages = [];
      for (const [index, asset] of assets.entries()) {
        const edited = await this.callTelegram('editMessageMedia', chatId, reusableMessageIds[index], {
          type: 'photo',
          media: this.buildTelegramMediaAsset(asset, jobId, index),
        });
        editedMessages.push(edited);
      }
      return {
        assetsMessageIds: reusableMessageIds.map((messageId, index) => editedMessages[index]?.message_id ?? messageId),
        previewTelegramFileIds: this.extractPreviewTelegramFileIds(
          editedMessages,
          `preview:${jobId}:${revision}`,
        ),
      };
    }

    for (const messageId of reusableMessageIds) {
      await this.deleteMessageSafe(chatId, messageId);
    }

    return this.sendPreviewAlbum({ chatId, assets, jobId, revision });
  }

  async presentRevisionTextOnly({
    chatId,
    payload,
    revisionEntry,
    tokensByAction,
    runtime,
  }) {
    const history = this.getRevisionHistory(payload);
    const totalRevisions = history.length;
    const canPrev = history.some((entry) => entry.revision < revisionEntry.revision);
    const canNext = history.some((entry) => entry.revision > revisionEntry.revision);
    const jobType = payload.jobType ?? runtime?.job_type ?? 'work';
    const keyboard = this.buildPreviewKeyboardForRuntime(tokensByAction, { canPrev, canNext }, jobType);
    const controlText = buildControlMessageText({
      caption: revisionEntry.captionText,
      revision: revisionEntry.revision,
      totalRevisions,
      renderMode: revisionEntry.finalRenderMode,
    });

    if (jobType === 'work') {
      const controlMessageId = await this.upsertControlMessage(chatId, controlText, {
        existingMessageId: runtime?.text_message_id ?? null,
        replyMarkup: keyboard,
      });
      return {
        collageMessageId: runtime?.collage_message_id ?? null,
        textMessageId: controlMessageId,
        assetsMessageIds: runtime?.assets_message_ids ?? [],
        previewTelegramFileIds: revisionEntry.previewTelegramFileIds,
      };
    }

    if (revisionEntry.finalRenderMode === 'separate') {
      const edited = await this.callTelegram('editMessageText', chatId, runtime.text_message_id, controlText, {
        reply_markup: keyboard,
      });
      return {
        collageMessageId: runtime.collage_message_id ?? null,
        textMessageId: edited?.message_id ?? runtime.text_message_id,
        assetsMessageIds: runtime.assets_message_ids ?? [],
        previewTelegramFileIds: revisionEntry.previewTelegramFileIds,
      };
    }

    const fullCaption = buildPreviewCaption({
      caption: revisionEntry.captionText,
      revision: revisionEntry.revision,
      totalRevisions,
      renderMode: revisionEntry.finalRenderMode,
    });
    if (shouldDetachPreviewText(fullCaption, runtime)) {
      const textEdited = await this.callTelegram(
        'editMessageText',
        chatId,
        runtime.text_message_id,
        revisionEntry.captionText,
      );
      const photoEdited = await this.callTelegram(
        'editMessageCaption',
        chatId,
        runtime.collage_message_id,
        {
          caption: buildPreviewMetaCaption({
            revision: revisionEntry.revision,
            totalRevisions,
            renderMode: revisionEntry.finalRenderMode,
          }),
          reply_markup: keyboard,
        },
      );
      return {
        collageMessageId: photoEdited?.message_id ?? runtime.collage_message_id,
        textMessageId: textEdited?.message_id ?? runtime.text_message_id,
        assetsMessageIds: runtime.assets_message_ids ?? [runtime.collage_message_id],
        previewTelegramFileIds: revisionEntry.previewTelegramFileIds,
      };
    }

    const caption = buildPreviewCaption({
      caption: revisionEntry.captionText,
      revision: revisionEntry.revision,
      totalRevisions,
      renderMode: revisionEntry.finalRenderMode,
    });
    const targetMessageId = runtime.collage_message_id ?? runtime.text_message_id;
    const edited = await this.callTelegram('editMessageCaption', chatId, targetMessageId, {
      caption,
      reply_markup: keyboard,
    });
    return {
      collageMessageId: runtime.collage_message_id ?? targetMessageId,
      textMessageId: edited?.message_id ?? targetMessageId,
      assetsMessageIds: runtime.assets_message_ids ?? [targetMessageId],
      previewTelegramFileIds: revisionEntry.previewTelegramFileIds,
    };
  }

  async presentPreviewRevision({
    chatId,
    payload,
    revisionEntry,
    tokensByAction,
    runtime = null,
    assets = null,
    replaceModePrompt = false,
  }) {
    const history = this.getRevisionHistory(payload);
    const totalRevisions = history.length;
    const canPrev = history.some((entry) => entry.revision < revisionEntry.revision);
    const canNext = history.some((entry) => entry.revision > revisionEntry.revision);
    const jobType = payload.jobType ?? runtime?.job_type ?? 'work';
    const keyboard = this.buildPreviewKeyboardForRuntime(tokensByAction, { canPrev, canNext }, jobType);
    const controlText = buildControlMessageText({
      caption: revisionEntry.captionText,
      revision: revisionEntry.revision,
      totalRevisions,
      renderMode: revisionEntry.finalRenderMode,
    });

    if (jobType === 'work') {
      if (revisionEntry.finalRenderMode === 'separate') {
        const albumAssets = assets?.length
          ? assets
          : this.assertReusableTelegramFileIds(
            revisionEntry.previewTelegramFileIds,
            `present_preview_revision:${payload.jobId}:${revisionEntry.revision}`,
          ).map((telegramFileId) => ({ telegramFileId }));

        const album = await this.upsertPreviewAlbum({
          chatId,
          assets: albumAssets,
          jobId: payload.jobId,
          revision: revisionEntry.revision,
          existingMessageIds: runtime?.assets_message_ids ?? [],
        });

        if (replaceModePrompt && runtime?.text_message_id) {
          await this.deleteMessageSafe(chatId, runtime.text_message_id);
        }

        const controlMessageId = await this.upsertControlMessage(chatId, controlText, {
          existingMessageId: replaceModePrompt ? null : (runtime?.text_message_id ?? null),
          replyMarkup: keyboard,
        });

        return {
          collageMessageId: null,
          textMessageId: controlMessageId,
          assetsMessageIds: album.assetsMessageIds,
          previewTelegramFileIds: album.previewTelegramFileIds,
        };
      }

      const previewAsset = assets?.[0]
        ?? { telegramFileId: this.assertReusableTelegramFileIds(
          revisionEntry.previewTelegramFileIds,
          `present_preview_revision:${payload.jobId}:${revisionEntry.revision}`,
        )[0] };

      let mediaMessageId = runtime?.collage_message_id ?? null;
      let sentMessage = null;
      if (mediaMessageId) {
        const edited = await this.callTelegram('editMessageMedia', chatId, mediaMessageId, {
          type: 'photo',
          media: this.buildTelegramMediaAsset(previewAsset, payload.jobId, 0),
        });
        sentMessage = edited;
        mediaMessageId = edited?.message_id ?? mediaMessageId;
      } else {
        const message = await this.callTelegram('sendPhoto', chatId, this.buildTelegramMediaAsset(previewAsset, payload.jobId, 0));
        sentMessage = message;
        mediaMessageId = message.message_id;
      }

      if (replaceModePrompt && runtime?.text_message_id) {
        await this.deleteMessageSafe(chatId, runtime.text_message_id);
      }

      const controlMessageId = await this.upsertControlMessage(chatId, controlText, {
        existingMessageId: replaceModePrompt ? null : (runtime?.text_message_id ?? null),
        replyMarkup: keyboard,
      });

      return {
        collageMessageId: mediaMessageId,
        textMessageId: controlMessageId,
        assetsMessageIds: [mediaMessageId],
        previewTelegramFileIds: this.extractPreviewTelegramFileIds(
          [sentMessage],
          `present_preview_revision:${payload.jobId}:${revisionEntry.revision}`,
        ),
      };
    }

    if (revisionEntry.finalRenderMode === 'separate') {
      let controlMessageId = runtime?.text_message_id ?? null;
      if (controlMessageId) {
        const edited = await this.callTelegram('editMessageText', chatId, controlMessageId, controlText, {
          reply_markup: keyboard,
        });
        controlMessageId = edited.message_id ?? controlMessageId;
      } else {
        const message = await this.sendMessage(chatId, controlText, {
          reply_markup: keyboard,
        });
        controlMessageId = message.message_id;
      }

      const albumAssets = assets?.length
        ? assets
        : this.assertReusableTelegramFileIds(
          revisionEntry.previewTelegramFileIds,
          `present_preview_revision:${payload.jobId}:${revisionEntry.revision}`,
        ).map((telegramFileId) => ({ telegramFileId }));
      for (const messageId of runtime?.assets_message_ids ?? []) {
        await this.deleteMessageSafe(chatId, messageId);
      }
      const album = await this.sendPreviewAlbum({
        chatId,
        assets: albumAssets,
        jobId: payload.jobId,
        revision: revisionEntry.revision,
      });
      return {
        collageMessageId: null,
        textMessageId: controlMessageId,
        assetsMessageIds: album.assetsMessageIds,
        previewTelegramFileIds: album.previewTelegramFileIds,
      };
    }

    const caption = buildPreviewCaption({
      caption: revisionEntry.captionText,
      revision: revisionEntry.revision,
      totalRevisions,
      renderMode: revisionEntry.finalRenderMode,
    });
    const previewAsset = assets?.[0]
      ?? { telegramFileId: this.assertReusableTelegramFileIds(
        revisionEntry.previewTelegramFileIds,
        `present_preview_revision:${payload.jobId}:${revisionEntry.revision}`,
      )[0] };

    if (shouldDetachPreviewText(caption, runtime)) {
      let controlMessageId = runtime?.text_message_id ?? null;
      if (controlMessageId && controlMessageId !== runtime?.collage_message_id) {
        const edited = await this.callTelegram('editMessageText', chatId, controlMessageId, revisionEntry.captionText);
        controlMessageId = edited.message_id ?? controlMessageId;
      } else {
        const message = await this.sendMessage(chatId, revisionEntry.captionText);
        controlMessageId = message.message_id;
      }

      const photoCaption = buildPreviewMetaCaption({
        revision: revisionEntry.revision,
        totalRevisions,
        renderMode: revisionEntry.finalRenderMode,
      });

      let messageId = runtime?.collage_message_id ?? null;
      let sentMessage = null;
      if (messageId) {
        const edited = await this.callTelegram('editMessageMedia', chatId, messageId, {
          type: 'photo',
          media: this.buildTelegramMediaAsset(previewAsset, payload.jobId, 0),
          caption: photoCaption,
        }, {
          reply_markup: keyboard,
        });
        sentMessage = edited;
        messageId = edited.message_id ?? messageId;
      } else {
        const message = await this.callTelegram('sendPhoto', chatId, this.buildTelegramMediaAsset(previewAsset, payload.jobId, 0), {
          caption: photoCaption,
          reply_markup: keyboard,
        });
        sentMessage = message;
        messageId = message.message_id;
      }

      if (replaceModePrompt && runtime?.text_message_id && runtime.text_message_id !== messageId && runtime.text_message_id !== controlMessageId) {
        await this.deleteMessageSafe(chatId, runtime.text_message_id);
      }

      return {
        collageMessageId: messageId,
        textMessageId: controlMessageId,
        assetsMessageIds: [messageId],
        previewTelegramFileIds: this.extractPreviewTelegramFileIds(
          [sentMessage],
          `present_preview_revision:${payload.jobId}:${revisionEntry.revision}`,
        ),
      };
    }

    let messageId = runtime?.collage_message_id ?? null;
    let sentMessage = null;
    if (messageId) {
      const edited = await this.callTelegram('editMessageMedia', chatId, messageId, {
        type: 'photo',
        media: this.buildTelegramMediaAsset(previewAsset, payload.jobId, 0),
        caption,
      }, {
        reply_markup: keyboard,
      });
      sentMessage = edited;
      messageId = edited.message_id ?? messageId;
    } else {
      const message = await this.callTelegram('sendPhoto', chatId, this.buildTelegramMediaAsset(previewAsset, payload.jobId, 0), {
        caption,
        reply_markup: keyboard,
      });
      sentMessage = message;
      messageId = message.message_id;
    }

    if (replaceModePrompt && runtime?.text_message_id && runtime.text_message_id !== messageId) {
      await this.deleteMessageSafe(chatId, runtime.text_message_id);
    }

    return {
      collageMessageId: messageId,
      textMessageId: messageId,
      assetsMessageIds: [messageId],
      previewTelegramFileIds: this.extractPreviewTelegramFileIds(
        [sentMessage],
        `present_preview_revision:${payload.jobId}:${revisionEntry.revision}`,
      ),
    };
  }
  async downloadTelegramFile(fileId) {
    const file = await this.callTelegram('getFile', fileId);
    if (!file.file_path) {
      throw new Error(`Telegram file path missing for ${fileId}`);
    }
    const fileUrl = `https://api.telegram.org/file/bot${this.env.tgBotToken}/${file.file_path}`;
    const response = await withRetry(
      () => withTimeout(
        (signal) => fetch(fileUrl, { signal }),
        30_000,
        'Telegram file download timed out',
      ),
      { retries: 2, delayMs: 400, shouldRetry: isRetryableHttpError },
    );
    if (!response.ok) {
      throw new Error(`Failed to download Telegram file ${fileId}: ${response.status}`);
    }
    const buffer = Buffer.from(await response.arrayBuffer());
    return {
      buffer,
      mimeType: file.file_path.endsWith('.png') ? 'image/png' : 'image/jpeg',
      filePath: file.file_path,
    };
  }

  async resolveRemoteImage(source) {
    if (String(source).startsWith('data:')) {
      const [prefix, base64] = String(source).split(',', 2);
      const mimeType = prefix.match(/^data:([^;]+)/u)?.[1] ?? 'image/jpeg';
      return { buffer: Buffer.from(base64, 'base64'), mimeType };
    }
    const response = await fetch(source);
    if (!response.ok) {
      throw new Error(`Failed to download generated image: ${response.status}`);
    }
    const mimeType = response.headers.get('content-type') ?? 'image/jpeg';
    return {
      buffer: Buffer.from(await response.arrayBuffer()),
      mimeType,
    };
  }

  async processWorkCollection(collection, { runtime = null, renderMode = 'collage' } = {}) {
    const jobId = runtime?.job_id ?? stableId('JOB', `work:${collection.collection_id}`);
    const queueId = runtime?.draft_payload?.queueId ?? runtime?.preview_payload?.queueId ?? stableId('QUE', jobId);
    const revision = Math.max(1, Number(runtime?.active_revision ?? 0) + 1);
    const payload = runtime?.draft_payload ?? runtime?.preview_payload ?? {};
    const effectiveRenderMode = renderMode || payload.renderMode || 'collage';
    const subjectType = this.getWorkSubjectType(payload.subjectType);
    const browOutputMode = this.getBrowOutputMode(payload.browOutputMode);
    const promptMode = payload.promptMode || 'normal';
    const backgroundMode = payload.backgroundMode || (collection.assets.length === 1 ? 'keep' : '');
    const cleanupMode = payload.cleanupMode || 'off';
    const prompts = await this.resolveWorkPrompts({
      jobId,
      revision,
      sourceAssetCount: collection.assets.length,
      renderMode: effectiveRenderMode,
      subjectType,
    });
    const previousPayload = runtime?.draft_payload ?? runtime?.preview_payload ?? null;
    const previousHistory = this.getRevisionHistory(previousPayload);

    await this.repos.closeCollection({
      collection_id: collection.collection_id,
      status: 'generating',
      closed_by_job_id: jobId,
      updated_at: nowIso(),
    });
    if (runtime) {
      await this.repos.upsertRuntime({
        job_id: runtime.job_id,
        job_type: runtime.job_type,
        chat_id: runtime.chat_id,
        user_id: runtime.user_id,
        topic_id: runtime.topic_id ?? '',
        collection_id: runtime.collection_id ?? '',
        active_revision: runtime.active_revision,
        runtime_status: 'generating',
        collage_message_id: toStoredText(runtime.collage_message_id),
        assets_message_ids_json: JSON.stringify(runtime.assets_message_ids ?? []),
        text_message_id: toStoredText(runtime.text_message_id),
        active_callback_set_id: toStoredText(runtime.active_callback_set_id),
        schedule_input_pending: 0,
        lock_flags_json: JSON.stringify(runtime.lock_flags ?? {}),
        preview_payload_json: JSON.stringify(previousPayload),
        draft_payload_json: JSON.stringify(previousPayload),
        updated_at: nowIso(),
      });
    }
    await this.logEvent({
      event: 'processing_started',
      stage: 'processing',
      chatId: collection.chat_id,
      userId: collection.user_id,
      jobId,
      queueId,
      collectionId: collection.collection_id,
      sourceType: 'work',
      status: effectiveRenderMode,
      message: `assets=${collection.assets.length}`,
      payload: {
        mediaGroupId: collection.media_group_id ?? '',
        sourceAssetCount: collection.assets.length,
        renderMode: effectiveRenderMode,
        subjectType,
        browOutputMode,
        promptMode,
        backgroundMode,
        cleanupMode,
      },
    });
    let workingRuntime = runtime;
    if (workingRuntime) {
      const controlMessageId = await this.updateRuntimeStatusMessage(workingRuntime, USER_MESSAGES.workAnalyzingPhotos);
      workingRuntime = {
        ...workingRuntime,
        text_message_id: controlMessageId,
      };
    } else {
      await this.sendProgress(collection.chat_id, USER_MESSAGES.workAnalyzingPhotos);
    }

    const downloadStartedAt = Date.now();
    const imageStartedAt = Date.now();
    const consistencyInputs = await Promise.all(
      collection.assets.map(async (asset) => {
        const original = await this.downloadTelegramFile(asset.fileId);
        return { buffer: original.buffer, mimeType: original.mimeType };
      }),
    );
    const consistencyNotes = await this.extractAlbumConsistencyNotes({
      assets: consistencyInputs,
      prompts,
      jobId,
      revision,
      subjectType,
    });
    await this.logEvent({
      event: 'consistency_extracted',
      stage: 'processing',
      chatId: collection.chat_id,
      userId: collection.user_id,
      jobId,
      queueId,
      collectionId: collection.collection_id,
      sourceType: 'work',
      status: 'ok',
      message: consistencyNotes ? 'locked_facts_ready' : 'single_asset_or_empty',
        payload: {
          model: this.getWorkTextModelId(),
          sourceAssetCount: consistencyInputs.length,
          renderMode,
          subjectType,
          verdict: consistencyNotes.slice(0, 400),
        },
      });
    if (workingRuntime) {
      const controlMessageId = await this.updateRuntimeStatusMessage(workingRuntime, USER_MESSAGES.workEnhancingImages);
      workingRuntime = {
        ...workingRuntime,
        text_message_id: controlMessageId,
      };
    } else {
      await this.sendProgress(collection.chat_id, USER_MESSAGES.workEnhancingImages);
    }
    const processedAssets = [];
    for (const [index, asset] of collection.assets.entries()) {
      const processedAsset = await this.processSingleWorkAsset({
        fileId: asset.fileId,
        prompts,
        jobId,
        index,
        revision,
        consistencyNotes,
        originalAsset: consistencyInputs[index] ?? null,
          renderMode: effectiveRenderMode,
          promptMode,
          subjectType,
          browOutputMode,
          backgroundMode,
          cleanupMode,
        sourceAssetCount: collection.assets.length,
        logContext: {
          chatId: collection.chat_id,
          userId: collection.user_id,
          queueId,
          collectionId: collection.collection_id,
        },
      });
      processedAssets.push(processedAsset);
    }
    if (
      processedAssets.length !== collection.assets.length
      || processedAssets.some((item) => !item?.asset?.buffer)
    ) {
      await this.logEvent({
        level: 'ERROR',
        event: 'work_asset_missing_output',
        stage: 'processing',
        chatId: collection.chat_id,
        userId: collection.user_id,
        jobId,
        queueId,
        collectionId: collection.collection_id,
        sourceType: 'work',
        status: 'failed',
        message: `expected=${collection.assets.length} actual=${processedAssets.length}`,
        payload: {
          renderMode,
          sourceAssetCount: collection.assets.length,
        },
      });
      const error = new Error(`Processed work asset count mismatch for ${jobId}`);
      error.step = 'work_asset_missing_output';
      error.userMessage = 'Не получилось собрать все фото после обработки. Попробуй ещё раз.';
      throw error;
    }
    const originalTelegramFileIds = processedAssets.map((item) => item.originalTelegramFileId);
    const enhancedAssets = processedAssets.map((item) => item.asset);
    await this.logEvent({
      event: 'original_download_completed',
      stage: 'processing',
      chatId: collection.chat_id,
      userId: collection.user_id,
      jobId,
      queueId,
      collectionId: collection.collection_id,
      sourceType: 'work',
      status: 'ok',
      durationMs: Date.now() - downloadStartedAt,
      message: `files=${originalTelegramFileIds.length}`,
      payload: { sourceAssetCount: originalTelegramFileIds.length },
    });
    await this.logEvent({
      event: 'image_enhancement_completed',
      stage: 'processing',
      chatId: collection.chat_id,
      userId: collection.user_id,
      jobId,
      queueId,
      collectionId: collection.collection_id,
      sourceType: 'work',
      status: 'ok',
      durationMs: Date.now() - imageStartedAt,
      message: `files=${enhancedAssets.length}`,
        payload: {
          model: this.env.imageModelId,
          passes: ['edit'],
          sourceAssetCount: enhancedAssets.length,
          renderMode,
          subjectType,
          consistencyNotes,
        },
      });

    let previewAssets = enhancedAssets;
    let finalRenderMode = renderMode === 'separate' && enhancedAssets.length > 1 ? 'separate' : 'single';
    if (renderMode === 'collage' && enhancedAssets.length > 1) {
        const finalPreviewRender = await this.buildFinalWorkPreviewAsset(
          enhancedAssets,
          `${jobId}-${revision}`,
          prompts,
          consistencyNotes,
          {
            backgroundMode,
            cleanupMode,
            promptMode,
            subjectType,
            browOutputMode,
          },
        );
        previewAssets = [finalPreviewRender.asset];
        finalRenderMode = finalPreviewRender.finalRenderMode;
      await this.logEvent({
        event: 'collage_built',
        stage: 'preview',
        chatId: collection.chat_id,
        userId: collection.user_id,
        jobId,
        queueId,
        collectionId: collection.collection_id,
        sourceType: 'work',
        status: 'ok',
        message: `assets=${enhancedAssets.length}`,
        payload: {
          finalRenderMode,
          sourceAssetCount: enhancedAssets.length,
        },
      });
    }
    if (renderMode === 'separate' && previewAssets.length !== collection.assets.length) {
      await this.logEvent({
        level: 'ERROR',
        event: 'work_asset_missing_output',
        stage: 'preview',
        chatId: collection.chat_id,
        userId: collection.user_id,
        jobId,
        queueId,
        collectionId: collection.collection_id,
        sourceType: 'work',
        status: 'failed',
        message: `separate_preview_count=${previewAssets.length}`,
        payload: {
          renderMode,
          sourceAssetCount: collection.assets.length,
        },
      });
      const error = new Error(`Separate preview asset count mismatch for ${jobId}`);
      error.step = 'work_asset_missing_output';
      error.userMessage = 'Не получилось подготовить все фото для результата. Попробуй ещё раз.';
      throw error;
    }

    if (workingRuntime) {
      const controlMessageId = await this.updateRuntimeStatusMessage(workingRuntime, USER_MESSAGES.workPreparingText);
      workingRuntime = {
        ...workingRuntime,
        text_message_id: controlMessageId,
      };
    } else {
      await this.sendProgress(collection.chat_id, USER_MESSAGES.workPreparingText);
    }
    const captionStartedAt = Date.now();
    const captionImageUrls = await this.buildWorkCaptionImageUrls(enhancedAssets);
    const { text: caption, fallback: captionFallback } = await this.generateWorkCaptionText({
      prompts,
      sourceAssetCount: enhancedAssets.length,
      imageUrls: captionImageUrls,
      jobId,
      revision,
          renderMode,
          chatId: collection.chat_id,
          userId: collection.user_id,
          queueId,
          collectionId: collection.collection_id,
          subjectType,
          browOutputMode,
        });
    await this.logEvent({
      event: 'caption_generated',
      stage: 'processing',
      chatId: collection.chat_id,
      userId: collection.user_id,
      jobId,
      queueId,
      collectionId: collection.collection_id,
      sourceType: 'work',
      status: 'ok',
      durationMs: Date.now() - captionStartedAt,
      message: `chars=${caption.length}`,
      payload: {
        model: this.getWorkTextModelId(),
        sourceAssetCount: enhancedAssets.length,
        renderMode,
        fallback: captionFallback,
      },
    });
    if (workingRuntime) {
      const controlMessageId = await this.updateRuntimeStatusMessage(workingRuntime, USER_MESSAGES.assemblingPreview);
      workingRuntime = {
        ...workingRuntime,
        text_message_id: controlMessageId,
      };
    } else {
      await this.sendProgress(collection.chat_id, USER_MESSAGES.assemblingPreview);
    }

    const basePayload = {
      ...previousPayload,
      jobId,
      queueId,
      jobType: 'work',
      revision,
      viewRevision: revision,
      chatId: collection.chat_id,
      userId: collection.user_id,
      topicId: '',
      collectionId: collection.collection_id,
      captionText: caption,
      subjectType,
      browOutputMode,
      renderMode,
      finalRenderMode,
      sourceAssetCount: enhancedAssets.length,
      originalTelegramFileIds,
      previewTelegramFileIds: [],
      createdAt: previousPayload?.createdAt ?? nowIso(),
    };

    const revisionEntry = this.buildRevisionEntry({
      revision,
      captionText: caption,
      previewTelegramFileIds: [],
      finalRenderMode,
      sourceAssetCount: enhancedAssets.length,
    });
    const nextHistory = [...previousHistory.filter((entry) => entry.revision !== revision), revisionEntry];
    const draftPayload = {
      ...basePayload,
      revisionHistory: nextHistory,
    };

    const { tokenRows, tokensByAction, tokenSetId } = this.createCallbackSet({
      jobId,
      revision,
      chatId: collection.chat_id,
      actions: ['version_prev', 'version_next', 'regenerate_images', 'regenerate_text', 'regenerate_all', 'cancel'],
    });
    if (runtime?.active_callback_set_id) {
      await this.repos.supersedeTokenSet(runtime.active_callback_set_id, nowIso());
    }
    await this.repos.createCallbackTokens(tokenRows);

    const previewStartedAt = Date.now();
    const presentation = await this.presentPreviewRevision({
      chatId: collection.chat_id,
      payload: draftPayload,
      revisionEntry,
      tokensByAction,
      runtime: workingRuntime,
      assets: previewAssets,
      replaceModePrompt: true,
    });
    revisionEntry.previewTelegramFileIds = presentation.previewTelegramFileIds;

    const finalPayload = {
      ...draftPayload,
      previewTelegramFileIds: presentation.previewTelegramFileIds,
      revisionHistory: nextHistory.map((entry) => (
        entry.revision === revision
          ? { ...revisionEntry }
          : entry
      )),
    };

    await this.store.upsertRowByColumn(
      SHEET_NAMES.contentQueue,
      'queue_id',
      queueId,
      buildQueueRow({
        queueId,
        jobId,
        jobType: 'work',
        revision,
        status: 'preview_ready',
        captionText: caption,
        assetDriveFileIds: presentation.previewTelegramFileIds,
        manifestDriveFileId: '',
      }),
      SHEET_HEADERS[SHEET_NAMES.contentQueue],
    );

    await this.repos.upsertRuntime({
      job_id: jobId,
      job_type: 'work',
      chat_id: collection.chat_id,
      user_id: collection.user_id,
      topic_id: '',
      collection_id: collection.collection_id,
      active_revision: revision,
      runtime_status: 'preview_ready',
      collage_message_id: toStoredText(presentation.collageMessageId),
      assets_message_ids_json: JSON.stringify(presentation.assetsMessageIds),
      text_message_id: toStoredText(presentation.textMessageId),
      active_callback_set_id: toStoredText(tokenSetId),
      schedule_input_pending: 0,
      lock_flags_json: JSON.stringify({ source_type: 'work' }),
      preview_payload_json: JSON.stringify(finalPayload),
      draft_payload_json: JSON.stringify(finalPayload),
      updated_at: nowIso(),
    });

    await this.logEvent({
      event: 'preview_sent',
      stage: 'preview',
      chatId: collection.chat_id,
      userId: collection.user_id,
      jobId,
      queueId,
      collectionId: collection.collection_id,
      sourceType: 'work',
      status: 'sent',
      durationMs: Date.now() - previewStartedAt,
      message: `messages=${presentation.assetsMessageIds.length}`,
      payload: {
        finalRenderMode,
        renderMode,
        sourceAssetCount: enhancedAssets.length,
        revision,
      },
    });
    return { ok: true, jobId, queueId, revision };
  }
  async reserveNextTopic() {
    const rows = await this.store.getRows(SHEET_NAMES.expertTopics);
    for (const row of rows) {
      const reclaimed = reclaimExpiredTopic({
        ...row,
        reserved_until: row.reservation_expires_at,
        reserved_by_job_id: row.reserved_by,
      });
      if (reclaimed.status !== row.status) {
        await this.store.updateRowByNumber(
          SHEET_NAMES.expertTopics,
          row.__rowNumber,
          { ...row, status: 'ready', reserved_by: '', reserved_at: '', reservation_expires_at: '' },
          SHEET_HEADERS[SHEET_NAMES.expertTopics],
        );
      }
    }

    const freshRows = await this.store.getRows(SHEET_NAMES.expertTopics);
    const nextTopic = freshRows.find((row) => String(row.status).toLowerCase() === 'ready');
    if (!nextTopic) {
      return null;
    }

    const reservedAt = nowIso();
    await this.store.updateRowByNumber(
      SHEET_NAMES.expertTopics,
      nextTopic.__rowNumber,
      {
        ...nextTopic,
        status: 'reserved',
        reserved_by: 'telegram-bot',
        reserved_at: reservedAt,
        reservation_expires_at: addMinutes(reservedAt, TOPIC_RESERVATION_MINUTES),
      },
      SHEET_HEADERS[SHEET_NAMES.expertTopics],
    );
    return nextTopic;
  }

  async regenerateDraft(jobId, action) {
    const runtime = await this.repos.getRuntime(jobId);
    if (!runtime?.draft_payload) {
      throw new Error(`Runtime payload missing for ${jobId}`);
    }

    const prompts = await this.promptConfig.refresh();
    const previousPayload = runtime.draft_payload;
    const revision = Number(runtime.active_revision) + 1;
    const payload = {
      ...previousPayload,
      revision,
      viewRevision: revision,
    };
    const previousHistory = this.getRevisionHistory(previousPayload);
    let previewAssets = [];
    let regeneratedFinalRenderMode = payload.finalRenderMode ?? payload.renderMode ?? 'single';

    const shouldRegenerateImages = action === 'regenerate_images' || action === 'regenerate_all';
    const shouldRegenerateText = action === 'regenerate_text' || action === 'regenerate_all';
    const shouldRecomposeTopicLike = runtime.job_type !== 'work' && (
      shouldRegenerateImages
      || (runtime.job_type !== 'topic' && shouldRegenerateText)
    );

    if (shouldRegenerateText) {
      let workCaptionImageUrls = [];
      if (runtime.job_type === 'work') {
        const captionAssets = previewAssets.length > 0
          ? previewAssets
          : await Promise.all(
            (payload.originalTelegramFileIds ?? []).slice(0, 3).map(async (fileId) => {
              const original = await this.downloadTelegramFile(fileId);
              return { buffer: original.buffer, mimeType: original.mimeType };
            }),
          );
        workCaptionImageUrls = await this.buildWorkCaptionImageUrls(captionAssets);
      }
      if (runtime.job_type === 'work') {
        const { text: nextCaption } = await this.generateWorkCaptionText({
          prompts,
          sourceAssetCount: payload.sourceAssetCount || payload.originalTelegramFileIds?.length || payload.previewTelegramFileIds?.length || 1,
          imageUrls: workCaptionImageUrls,
          jobId,
          revision,
          renderMode: payload.renderMode ?? payload.finalRenderMode ?? 'collage',
          subjectType: this.getWorkSubjectType(payload.subjectType),
          browOutputMode: this.getBrowOutputMode(payload.browOutputMode),
          chatId: runtime.chat_id,
          userId: runtime.user_id,
          queueId: payload.queueId ?? '',
          collectionId: runtime.collection_id ?? '',
        });
        payload.captionText = nextCaption;
      } else {
        const { manifest } = await this.generateTopicLikeManifest({
          jobType: runtime.job_type,
          prompts,
          sourceRow: {
            topic_id: payload.topicId ?? runtime.topic_id,
            title: payload.title ?? '',
            brief: payload.brief ?? '',
            tags: payload.tags ?? [],
          },
          jobId,
          revision,
        });
        payload.manifest = manifest;
        if (runtime.job_type === 'topic') {
          payload.captionText = manifest.captionText;
        }
      }
    }

    if (shouldRegenerateImages && runtime.job_type === 'work') {
      const regenerationOriginals = await Promise.all(
        (payload.originalTelegramFileIds ?? []).map(async (fileId) => {
          const original = await this.downloadTelegramFile(fileId);
          return { buffer: original.buffer, mimeType: original.mimeType };
        }),
      );
      const regenerationConsistencyNotes = await this.extractAlbumConsistencyNotes({
        assets: regenerationOriginals,
        prompts,
        jobId,
        revision,
        subjectType: this.getWorkSubjectType(payload.subjectType),
      });
      const regeneratedAssets = [];
      for (const [index, fileId] of (payload.originalTelegramFileIds ?? []).entries()) {
        const regeneratedAsset = await this.processSingleWorkAsset({
          fileId,
          prompts,
          jobId,
          index,
          revision,
          consistencyNotes: regenerationConsistencyNotes,
          originalAsset: regenerationOriginals[index] ?? null,
          renderMode: payload.renderMode ?? payload.finalRenderMode ?? 'collage',
          promptMode: payload.promptMode || 'normal',
          subjectType: this.getWorkSubjectType(payload.subjectType),
          browOutputMode: this.getBrowOutputMode(payload.browOutputMode),
          backgroundMode: payload.backgroundMode || '',
          cleanupMode: payload.cleanupMode || 'off',
          sourceAssetCount: payload.originalTelegramFileIds?.length ?? regenerationOriginals.length ?? 1,
          logContext: {
            chatId: runtime.chat_id,
            userId: runtime.user_id,
            queueId: payload.queueId ?? '',
            collectionId: runtime.collection_id,
          },
        });
        regeneratedAssets.push(regeneratedAsset);
      }
      if (
        regeneratedAssets.length !== (payload.originalTelegramFileIds ?? []).length
        || regeneratedAssets.some((item) => !item?.asset?.buffer)
      ) {
        await this.logEvent({
          level: 'ERROR',
          event: 'work_asset_missing_output',
          stage: 'processing',
          chatId: runtime.chat_id,
          userId: runtime.user_id,
          jobId,
          queueId: payload.queueId ?? '',
          collectionId: runtime.collection_id,
          sourceType: 'work',
          status: 'failed',
          message: `expected=${payload.originalTelegramFileIds?.length ?? 0} actual=${regeneratedAssets.length}`,
          payload: {
            action,
            renderMode: payload.renderMode ?? payload.finalRenderMode ?? 'collage',
          },
        });
        const error = new Error(`Regenerated work asset count mismatch for ${jobId}`);
        error.step = 'work_asset_missing_output';
        error.userMessage = 'Не получилось повторно собрать все фото. Попробуй ещё раз.';
        throw error;
      }
      const regeneratedBuffers = regeneratedAssets.map((item) => item.asset);
      if ((payload.renderMode ?? payload.finalRenderMode) === 'separate' && regeneratedBuffers.length > 1) {
        regeneratedFinalRenderMode = 'separate';
        previewAssets = regeneratedBuffers;
      } else if (regeneratedBuffers.length > 1) {
        const finalPreviewRender = await this.buildFinalWorkPreviewAsset(
          regeneratedBuffers,
          `${jobId}-${revision}`,
          prompts,
          consistencyNotes,
          {
            backgroundMode: payload.backgroundMode || '',
            cleanupMode: payload.cleanupMode || 'off',
            promptMode: payload.promptMode || 'normal',
            subjectType: this.getWorkSubjectType(payload.subjectType),
            browOutputMode: this.getBrowOutputMode(payload.browOutputMode),
          },
        );
        regeneratedFinalRenderMode = finalPreviewRender.finalRenderMode;
        previewAssets = [finalPreviewRender.asset];
      } else {
        regeneratedFinalRenderMode = 'single';
        previewAssets = regeneratedBuffers;
      }
    } else if (shouldRecomposeTopicLike) {
      const topicLikeVisual = await this.generateTopicLikeVisualAssets({
        jobType: runtime.job_type,
        prompts,
        manifest: payload.manifest ?? { captionText: payload.captionText },
        sourceRow: {
          topic_id: payload.topicId ?? runtime.topic_id,
          title: payload.title ?? '',
          brief: payload.brief ?? '',
          tags: payload.tags ?? [],
        },
        revision,
        jobId,
      });
      previewAssets = topicLikeVisual.assets;
      regeneratedFinalRenderMode = topicLikeVisual.finalRenderMode;
      payload.finalRenderMode = topicLikeVisual.finalRenderMode;
      payload.renderMode = topicLikeVisual.finalRenderMode;
      payload.captionText = topicLikeVisual.captionText;
    }

    const queueRow = await this.getQueueRowByJobId(jobId);
    if (!queueRow) {
      throw new Error(`Queue row not found for ${jobId}`);
    }

    const finalRenderMode = runtime.job_type === 'work'
      ? regeneratedFinalRenderMode
      : (payload.finalRenderMode ?? 'single');
    const revisionEntry = this.buildRevisionEntry({
      revision,
      captionText: payload.captionText,
      previewTelegramFileIds: [],
      finalRenderMode,
      sourceAssetCount: runtime.job_type === 'work'
        ? (payload.originalTelegramFileIds?.length || payload.sourceAssetCount || 1)
        : (payload.sourceAssetCount || 1),
    });
    const nextPayload = {
      ...payload,
      finalRenderMode,
      sourceAssetCount: revisionEntry.sourceAssetCount,
      revisionHistory: [...previousHistory.filter((entry) => entry.revision !== revision), revisionEntry],
    };

    const { tokenRows, tokensByAction, tokenSetId } = this.createCallbackSet({
      jobId,
      revision,
      chatId: runtime.chat_id,
      actions: ['version_prev', 'version_next', 'regenerate_images', 'regenerate_text', 'regenerate_all', 'cancel'],
    });
    await this.repos.supersedeTokenSet(runtime.active_callback_set_id, nowIso());
    await this.repos.createCallbackTokens(tokenRows);

    const previewMessages = await this.presentPreviewRevision({
      chatId: runtime.chat_id,
      payload: nextPayload,
      revisionEntry,
      tokensByAction,
      runtime,
      assets: previewAssets.length > 0
        ? previewAssets
        : this.assertReusableTelegramFileIds(payload.previewTelegramFileIds ?? [], 'regenerate_draft')
          .map((telegramFileId) => ({ telegramFileId })),
    });
    revisionEntry.previewTelegramFileIds = previewMessages.previewTelegramFileIds;

    const finalPayload = {
      ...nextPayload,
      previewTelegramFileIds: previewMessages.previewTelegramFileIds,
      revisionHistory: nextPayload.revisionHistory.map((entry) => (
        entry.revision === revision
          ? { ...revisionEntry }
          : entry
      )),
    };

    await this.store.updateRowByNumber(
      SHEET_NAMES.contentQueue,
      queueRow.__rowNumber,
      buildQueueRow({
        queueId: queueRow.queue_id,
        jobId,
        jobType: runtime.job_type,
        revision,
        status: 'preview_ready',
        captionText: finalPayload.captionText,
        assetDriveFileIds: finalPayload.previewTelegramFileIds,
        manifestDriveFileId: '',
        topicId: finalPayload.topicId ?? '',
        createdAt: queueRow.created_at || nowIso(),
      }),
      SHEET_HEADERS[SHEET_NAMES.contentQueue],
    );

    await this.repos.upsertRuntime({
      job_id: runtime.job_id,
      job_type: runtime.job_type,
      chat_id: runtime.chat_id,
      user_id: runtime.user_id,
      topic_id: runtime.topic_id ?? '',
      collection_id: runtime.collection_id ?? '',
      active_revision: revision,
      runtime_status: 'preview_ready',
      collage_message_id: toStoredText(previewMessages.collageMessageId),
      assets_message_ids_json: JSON.stringify(previewMessages.assetsMessageIds),
      text_message_id: toStoredText(previewMessages.textMessageId),
      active_callback_set_id: toStoredText(tokenSetId),
      schedule_input_pending: 0,
      lock_flags_json: JSON.stringify(runtime.lock_flags),
      preview_payload_json: JSON.stringify(finalPayload),
      draft_payload_json: JSON.stringify(finalPayload),
      updated_at: nowIso(),
    });
    if (runtime.job_type !== 'work' && runtime.topic_id) {
      const sourceSheet = runtime.lock_flags?.source_sheet ?? this.getTopicLikeSourceSheet(runtime.job_type);
      await this.ensureSourceRowReserved(sourceSheet, runtime.topic_id, runtime.job_id);
    }
    await this.logEvent({
      event: 'revision_changed',
      stage: 'preview',
      chatId: runtime.chat_id,
      userId: runtime.user_id,
      jobId,
      queueId: queueRow.queue_id,
      collectionId: runtime.collection_id ?? '',
      sourceType: runtime.job_type,
      status: action,
      message: `revision=${revision}`,
    });
    return { ok: true, revision };
  }

  async markDraftPublished(runtime) {
    const startedAt = Date.now();
    const queueRow = await this.getQueueRowByJobId(runtime.job_id);
    if (queueRow) {
      await this.store.updateRowByNumber(
        SHEET_NAMES.contentQueue,
        queueRow.__rowNumber,
        {
          ...queueRow,
          status: 'published',
          updated_at: nowIso(),
        },
        SHEET_HEADERS[SHEET_NAMES.contentQueue],
      );
    }

    const sourceSheet = runtime.lock_flags?.source_sheet ?? this.getTopicLikeSourceSheet(runtime.job_type);
    if (sourceSheet && runtime.topic_id) {
      await this.markSourceRowPublished(sourceSheet, runtime.topic_id, runtime.job_id);
    }

    await this.repos.upsertRuntime({
      job_id: runtime.job_id,
      job_type: runtime.job_type,
      chat_id: runtime.chat_id,
      user_id: runtime.user_id,
      topic_id: runtime.topic_id ?? '',
      collection_id: runtime.collection_id ?? '',
      active_revision: runtime.active_revision,
      runtime_status: 'published',
      collage_message_id: toStoredText(runtime.collage_message_id),
      assets_message_ids_json: JSON.stringify(runtime.assets_message_ids ?? []),
      text_message_id: toStoredText(runtime.text_message_id),
      active_callback_set_id: toStoredText(runtime.active_callback_set_id),
      schedule_input_pending: 0,
      lock_flags_json: JSON.stringify(runtime.lock_flags ?? {}),
      preview_payload_json: JSON.stringify(runtime.preview_payload),
      draft_payload_json: JSON.stringify(runtime.draft_payload),
      updated_at: nowIso(),
    });

    this.logDurationBestEffort({
      event: 'publish_confirmed',
      stage: 'publish',
      chatId: runtime.chat_id,
      userId: runtime.user_id,
      jobId: runtime.job_id,
      queueId: queueRow?.queue_id ?? '',
      collectionId: runtime.collection_id ?? '',
      sourceType: runtime.job_type,
      status: 'ok',
      message: runtime.topic_id ?? runtime.job_id,
    }, startedAt);
    await this.sendMessage(runtime.chat_id, 'Отметила материал как опубликованный.');
    return { ok: true, published: true };
  }

  async cancelDraft(jobId) {
    const runtime = await this.repos.getRuntime(jobId);
    const queueRow = await this.getQueueRowByJobId(jobId);
    if (queueRow) {
      await this.store.updateRowByNumber(
        SHEET_NAMES.contentQueue,
        queueRow.__rowNumber,
        { ...queueRow, status: 'cancelled', updated_at: nowIso() },
        SHEET_HEADERS[SHEET_NAMES.contentQueue],
      );
    }

    if (runtime?.topic_id) {
      const sourceSheet = runtime.lock_flags?.source_sheet ?? this.getTopicLikeSourceSheet(runtime.job_type);
      if (sourceSheet) {
        await this.releaseSourceRow(sourceSheet, runtime.topic_id);
      }
    }

    if (runtime) {
      await this.repos.supersedeTokenSet(runtime.active_callback_set_id, nowIso());
      await this.repos.upsertRuntime({
        job_id: runtime.job_id,
        job_type: runtime.job_type,
        chat_id: runtime.chat_id,
        user_id: runtime.user_id,
        topic_id: runtime.topic_id ?? '',
        collection_id: runtime.collection_id ?? '',
        active_revision: runtime.active_revision,
        runtime_status: 'cancelled',
        collage_message_id: toStoredText(runtime.collage_message_id),
        assets_message_ids_json: JSON.stringify(runtime.assets_message_ids),
        text_message_id: toStoredText(runtime.text_message_id),
        active_callback_set_id: toStoredText(runtime.active_callback_set_id),
        schedule_input_pending: 0,
        lock_flags_json: JSON.stringify(runtime.lock_flags),
        preview_payload_json: JSON.stringify(runtime.preview_payload),
        draft_payload_json: JSON.stringify(runtime.draft_payload),
        updated_at: nowIso(),
      });
      await this.sendMessage(runtime.chat_id, USER_MESSAGES.actionMessages.cancel);
    }
    return { ok: true };
  }

  async handleQueuedRuntimeAction(payload = {}) {
    const jobId = String(payload.jobId ?? '').trim();
    const action = String(payload.action ?? '').trim();
    if (!jobId || !action) {
      return { ok: false, error: 'invalid_worker_payload' };
    }
    return this.runQueuedGenerationJob(jobId, action);
  }

  async handleCollectionFinalizeAction(payload = {}) {
    const collectionId = String(payload.collectionId ?? '').trim();
    if (!collectionId) {
      return { ok: false, error: 'invalid_collection_finalize_payload' };
    }
    return this.scheduleCollectionFinalize(collectionId);
  }

  async runQueuedGenerationJob(jobId, action) {
    const runtime = await this.repos.getRuntime(jobId);
    if (!runtime) {
      return { ok: false, missing: true };
    }

    const lockKey = `generation:${jobId}`;
    const acquired = await this.repos.acquirePublishLock({
      lockKey,
      jobId,
      queueId: runtime.preview_payload?.queueId ?? runtime.draft_payload?.queueId ?? '',
      createdAt: nowIso(),
      expiresAt: addMinutes(new Date(), 10),
    });
    if (!acquired) {
      return { ok: true, locked: true };
    }

    try {
      const freshRuntime = await this.repos.getRuntime(jobId);
      if (!freshRuntime) {
        return { ok: false, missing: true };
      }
      await this.logEvent({
        event: 'generation_started',
        stage: 'processing',
        chatId: freshRuntime.chat_id,
        userId: freshRuntime.user_id,
        jobId,
        queueId: freshRuntime.preview_payload?.queueId ?? freshRuntime.draft_payload?.queueId ?? '',
        collectionId: freshRuntime.collection_id ?? '',
        sourceType: freshRuntime.job_type,
        status: action,
        message: action,
      });

      if (action === 'generate_initial') {
        const collection = await this.repos.getCollectionById(freshRuntime.collection_id);
        if (!collection) {
          throw new Error(`Collection not found for ${jobId}`);
        }
        const renderMode = freshRuntime.draft_payload?.renderMode
          ?? freshRuntime.preview_payload?.renderMode
          ?? 'collage';
        return await this.processWorkCollection(collection, { runtime: freshRuntime, renderMode });
      }

      return await this.regenerateDraft(jobId, action);
    } catch (error) {
      await this.repos.upsertRuntime({
        job_id: runtime.job_id,
        job_type: runtime.job_type,
        chat_id: runtime.chat_id,
        user_id: runtime.user_id,
        topic_id: runtime.topic_id ?? '',
        collection_id: runtime.collection_id ?? '',
        active_revision: runtime.active_revision,
        runtime_status: 'generation_failed',
        collage_message_id: toStoredText(runtime.collage_message_id),
        assets_message_ids_json: JSON.stringify(runtime.assets_message_ids ?? []),
        text_message_id: toStoredText(runtime.text_message_id),
        active_callback_set_id: toStoredText(runtime.active_callback_set_id),
        schedule_input_pending: 0,
        lock_flags_json: JSON.stringify(runtime.lock_flags ?? {}),
        preview_payload_json: JSON.stringify(runtime.preview_payload),
        draft_payload_json: JSON.stringify(runtime.draft_payload),
        updated_at: nowIso(),
      });
      await this.logEvent({
        level: 'ERROR',
        event: 'generation_failed',
        stage: 'error',
        chatId: runtime.chat_id,
        userId: runtime.user_id,
        jobId,
        queueId: runtime.preview_payload?.queueId ?? runtime.draft_payload?.queueId ?? '',
        collectionId: runtime.collection_id ?? '',
        sourceType: runtime.job_type,
        status: action,
        message: error.message,
        node: error.step ?? action,
      });
      const userMessage = this.buildUserErrorMessage(error, 'Не получилось собрать результат. Попробуй ещё раз.');
      if (runtime.text_message_id) {
        try {
          await this.updateRuntimeStatusMessage(runtime, userMessage);
        } catch {
          await this.sendMessage(runtime.chat_id, userMessage);
        }
      } else {
        await this.sendMessage(runtime.chat_id, userMessage);
      }
      return { ok: false, error: error.message };
    } finally {
      await this.repos.releasePublishLock(lockKey);
    }
  }

  async runCollectionFinalizer() {
    const dueCollections = await this.repos.listDueCollections(nowIso());
    for (const collection of dueCollections) {
      try {
        await this.promptWorkRenderMode(collection);
      } catch (error) {
        await this.botLogger.log({
          level: 'ERROR',
          event: 'work_collection_failed',
          chatId: collection.chat_id,
          userId: collection.user_id,
          sourceType: 'work',
          status: 'failed',
          message: error.message,
          payload: { collectionId: collection.collection_id },
        });
      }
    }
    const queuedRuntimes = await this.repos.listRuntimesByStatus('queued_for_generation');
    for (const runtime of queuedRuntimes) {
      try {
        const action = runtime.lock_flags?.queued_action || 'generate_initial';
        await this.runQueuedGenerationJob(runtime.job_id, action);
      } catch (error) {
        await this.botLogger.log({
          level: 'ERROR',
          event: 'queued_generation_failed',
          chatId: runtime.chat_id,
          userId: runtime.user_id,
          jobId: runtime.job_id,
          queueId: runtime.preview_payload?.queueId ?? runtime.draft_payload?.queueId ?? '',
          collectionId: runtime.collection_id ?? '',
          sourceType: runtime.job_type,
          status: 'failed',
          message: error.message,
          payload: { action: runtime.lock_flags?.queued_action || 'generate_initial' },
        });
      }
    }
  }

  async runCleanup() {
    const now = nowIso();
    const sessions = await this.repos.cleanupSessions(now);
    const callbackTokens = await this.repos.cleanupCallbackTokens(now);
    const idempotency = await this.repos.cleanupIdempotency(now);
    const publishLocks = await this.repos.cleanupPublishLocks(now);
    await this.logEvent({
      event: 'cleanup_completed',
      stage: 'cleanup',
      status: 'ok',
      message: `sessions=${sessions} callback_tokens=${callbackTokens} idempotency=${idempotency} publish_locks=${publishLocks}`
    });
  }

  async scheduleCollectionFinalize(collectionId) {
    const collection = await this.repos.getCollectionById(collectionId);
    if (!collection || collection.status !== 'collecting') {
      return { ok: true, skipped: true };
    }
    const waitMs = Math.max(0, new Date(collection.deadline_at).getTime() - Date.now()) + 250;
    if (waitMs > 0) {
      await delay(waitMs);
    }
    const lockKey = `collection-finalize:${collection.collection_id}`;
    const acquired = await this.repos.acquirePublishLock({
      lockKey,
      jobId: collection.collection_id,
      queueId: '',
      createdAt: nowIso(),
      expiresAt: addMinutes(new Date(), 10),
    });
    if (!acquired) {
      return { ok: true, locked: true };
    }
    try {
      const latest = await this.repos.getCollectionById(collectionId);
      if (!latest || latest.status !== 'collecting') {
        return { ok: true, skipped: true };
      }
      if (new Date(latest.deadline_at).getTime() > Date.now()) {
        return { ok: true, waiting: true };
      }
      await this.logEvent({
        event: 'collection_stable',
        stage: 'collection',
        chatId: latest.chat_id,
        userId: latest.user_id,
        collectionId: latest.collection_id,
        sourceType: 'work',
        status: 'ready',
        message: `count=${latest.count}`,
        payload: {
          mediaGroupId: latest.media_group_id ?? '',
          count: latest.count,
        },
      });
      await this.promptWorkRenderMode(latest);
      return { ok: true };
    } finally {
      await this.repos.releasePublishLock(lockKey);
    }
  }

  getCollectionDebounceWaitMs() {
    return (WORK_COLLECTION_DEBOUNCE_SECONDS * 1000) + 250;
  }

  buildTelegramMediaAsset(asset, jobId, index) {
    if (asset?.telegramFileId) {
      return asset.telegramFileId;
    }
    return new InputFile(
      asset.buffer,
      asset.fileName ?? basenameForMime(asset.mimeType, `preview-${jobId}-${index + 1}.jpg`),
    );
  }

  assertReusableTelegramFileIds(fileIds, contextLabel) {
    const normalized = [...(fileIds ?? [])].filter(Boolean);
    if (normalized.length === 0) {
      const error = new Error(`Telegram preview file ids are missing for ${contextLabel}`);
      error.step = contextLabel;
      error.userMessage = 'Не удалось подготовить preview для повторной отправки.';
      throw error;
    }
    const invalid = normalized.find((fileId) => String(fileId).startsWith('preview:'));
    if (invalid) {
      const error = new Error(`Synthetic Telegram preview id detected for ${contextLabel}: ${invalid}`);
      error.step = contextLabel;
      error.userMessage = 'Не удалось использовать сохранённый preview. Нужна новая генерация.';
      throw error;
    }
    return normalized;
  }

  async deleteMessageSafe(chatId, messageId) {
    if (!chatId || !messageId) {
      return;
    }
    try {
      await this.callTelegram('deleteMessage', chatId, messageId);
    } catch {
      // Best effort cleanup only.
    }
  }

  extractPreviewTelegramFileIds(messages, contextLabel) {
    return messages.map((message, index) => {
      const fileId = message?.photo?.at?.(-1)?.file_id
        ?? message?.photo?.[message.photo.length - 1]?.file_id
        ?? message?.document?.file_id
        ?? null;
      if (!fileId) {
        const error = new Error(`Telegram preview file_id missing for ${contextLabel} item ${index + 1}`);
        error.step = 'extract_preview_file_ids';
        error.userMessage = 'Не удалось подготовить preview для повторной отправки.';
        throw error;
      }
      return fileId;
    });
  }

  async withLocalLock(key, action) {
    const current = this.localLocks.get(key) ?? Promise.resolve();
    let release;
    const next = new Promise((resolve) => {
      release = resolve;
    });
    const chained = current.then(() => next);
    this.localLocks.set(key, chained);
    await current;
    try {
      return await action();
    } finally {
      release();
      if (this.localLocks.get(key) === chained) {
        this.localLocks.delete(key);
      }
    }
  }

  async sendMessage(chatId, text, extra = {}) {
    return this.callTelegram('sendMessage', chatId, text, extra);
  }

  async callTelegram(method, ...args) {
    return withRetry(
      () => this.bot.api[method](...args),
      {
        retries: 2,
        delayMs: 400,
        shouldRetry: isRetryableHttpError,
      },
    );
  }
}

export default SalonBotService;

