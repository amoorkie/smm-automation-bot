import { InlineKeyboard } from 'grammy';

import { DEFAULT_PROMPTS } from '../config/defaults.mjs';

export function nowIso() {
  return new Date().toISOString();
}

export function escapeTelegramText(value) {
  return String(value ?? '').trim();
}

export function buildHelpMessage(promptText = null) {
  return escapeTelegramText(promptText || DEFAULT_PROMPTS.help_message);
}

export function buildStartMessage(promptText = null) {
  const helpMessage = buildHelpMessage(promptText);
  return [
    'Выберите задачу.',
    'Отправьте нужную команду в любой момент.',
    '',
    helpMessage,
  ].join('\n');
}

export function buildRenderModeKeyboard(tokensByAction = {}) {
  const keyboard = new InlineKeyboard();
  if (tokensByAction.render_mode_collage) {
    keyboard.text('Коллаж', `render_mode_collage:${tokensByAction.render_mode_collage}`);
  }
  if (tokensByAction.render_mode_separate) {
    keyboard.text('По отдельности', `render_mode_separate:${tokensByAction.render_mode_separate}`);
  }
  if (tokensByAction.cancel) {
    keyboard.row().text('Отмена', `cancel:${tokensByAction.cancel}`);
  }
  return keyboard;
}

function buildChoiceKeyboard(rows = [], { cancelToken = '' } = {}) {
  const keyboard = new InlineKeyboard();
  for (const row of rows) {
    let hasButtons = false;
    for (const button of row) {
      if (!button?.token || !button?.action || !button?.label) {
        continue;
      }
      keyboard.text(button.label, `${button.action}:${button.token}`);
      hasButtons = true;
    }
    if (hasButtons) {
      keyboard.row();
    }
  }
  if (cancelToken) {
    keyboard.text('Отмена', `cancel:${cancelToken}`);
  }
  return keyboard;
}

export function buildWorkPromptModeKeyboard(tokensByAction = {}) {
  return buildChoiceKeyboard([
    [
      { label: 'Обычный', action: 'work_prompt_mode_normal', token: tokensByAction.work_prompt_mode_normal },
      { label: 'Тестовый', action: 'work_prompt_mode_test', token: tokensByAction.work_prompt_mode_test },
    ],
  ], { cancelToken: tokensByAction.cancel });
}

export function buildWorkPhotoTypeKeyboard(tokensByAction = {}) {
  return buildChoiceKeyboard([
    [
      { label: 'Обычное фото', action: 'work_photo_type_normal', token: tokensByAction.work_photo_type_normal },
      { label: 'Студийное', action: 'work_photo_type_studio', token: tokensByAction.work_photo_type_studio },
    ],
  ], { cancelToken: tokensByAction.cancel });
}

export function buildWorkSubjectKeyboard(tokensByAction = {}) {
  return buildChoiceKeyboard([
    [
      { label: 'Прически / стрижки', action: 'work_subject_hair', token: tokensByAction.work_subject_hair },
      { label: 'Брови', action: 'work_subject_brows', token: tokensByAction.work_subject_brows },
    ],
  ], { cancelToken: tokensByAction.cancel });
}

export function buildWorkBrowOutputKeyboard(tokensByAction = {}) {
  return buildChoiceKeyboard([
    [
      { label: 'До / после', action: 'brow_output_before_after', token: tokensByAction.brow_output_before_after },
      { label: 'Только после', action: 'brow_output_after_only', token: tokensByAction.brow_output_after_only },
    ],
  ], { cancelToken: tokensByAction.cancel });
}

export function buildWorkBackgroundKeyboard(tokensByAction = {}, { includeStudioOption = true } = {}) {
  const rows = [[
    { label: 'Как есть', action: 'background_mode_keep', token: tokensByAction.background_mode_keep },
    { label: 'Сильный блюр', action: 'background_mode_blur', token: tokensByAction.background_mode_blur },
  ]];
  if (includeStudioOption) {
    rows.push([
      { label: 'Светлый студийный', action: 'background_mode_neutral', token: tokensByAction.background_mode_neutral },
    ]);
  }
  return buildChoiceKeyboard(rows, { cancelToken: tokensByAction.cancel });
}

export function buildWorkCleanupKeyboard(tokensByAction = {}) {
  return buildChoiceKeyboard([
    [
      { label: 'Да', action: 'cleanup_on', token: tokensByAction.cleanup_on },
      { label: 'Нет', action: 'cleanup_off', token: tokensByAction.cleanup_off },
    ],
  ], { cancelToken: tokensByAction.cancel });
}

export function buildPreviewKeyboard(tokensByAction = {}, { canPrev = false, canNext = false } = {}) {
  const keyboard = new InlineKeyboard();

  if (canPrev && tokensByAction.version_prev) {
    keyboard.text('←', `version_prev:${tokensByAction.version_prev}`);
  }
  if (canNext && tokensByAction.version_next) {
    keyboard.text('→', `version_next:${tokensByAction.version_next}`);
  }
  if (canPrev || canNext) {
    keyboard.row();
  }

  if (tokensByAction.regenerate_images) {
    keyboard.text('Поменять картинки', `regenerate_images:${tokensByAction.regenerate_images}`);
  }
  if (tokensByAction.regenerate_text) {
    keyboard.text('Поменять текст', `regenerate_text:${tokensByAction.regenerate_text}`);
  }
  keyboard.row();

  if (tokensByAction.regenerate_all) {
    keyboard.text('Поменять всё', `regenerate_all:${tokensByAction.regenerate_all}`);
  }
  if (tokensByAction.cancel) {
    keyboard.text('Отмена', `cancel:${tokensByAction.cancel}`);
  }

  return keyboard;
}

export function buildControlMessageText({
  caption,
  revision,
  totalRevisions,
  renderMode,
}) {
  const modeLabel = renderMode === 'separate'
    ? 'по отдельности'
    : renderMode === 'single'
      ? 'одно фото'
      : 'коллаж';
  return [
    `Версия ${revision}/${totalRevisions}`,
    `Режим: ${modeLabel}`,
    '',
    escapeTelegramText(caption),
  ].join('\n');
}

export function buildPreviewCaption({
  caption,
  revision,
  totalRevisions,
  renderMode,
}) {
  const modeLabel = renderMode === 'separate'
    ? 'по отдельности'
    : renderMode === 'single'
      ? 'одно фото'
      : 'коллаж';
  return [
    escapeTelegramText(caption),
    '',
    `Версия ${revision}/${totalRevisions} · ${modeLabel}`,
  ].join('\n');
}

export function parseTags(value) {
  return String(value ?? '')
    .split(/[;,]/u)
    .map((item) => item.trim())
    .filter(Boolean);
}

export function toDataUrl(buffer, mimeType = 'image/jpeg') {
  return `data:${mimeType};base64,${buffer.toString('base64')}`;
}

export function parseDataUrl(dataUrl) {
  const match = String(dataUrl ?? '').match(/^data:([^;]+);base64,(.+)$/u);
  if (!match) {
    return null;
  }
  return {
    mimeType: match[1],
    buffer: Buffer.from(match[2], 'base64'),
  };
}

export function bufferFromUnknownImageSource(source, fallbackMimeType = 'image/jpeg') {
  const parsed = parseDataUrl(source);
  if (parsed) {
    return parsed;
  }
  return {
    mimeType: fallbackMimeType,
    buffer: Buffer.from(String(source ?? ''), 'utf8'),
  };
}

export function buildQueueRow({
  queueId,
  jobId,
  jobType,
  revision,
  status,
  captionText,
  scheduledAt = '',
  assetDriveFileIds = [],
  manifestDriveFileId = '',
  topicId = '',
  updatedAt = nowIso(),
  createdAt = updatedAt,
}) {
  return {
    queue_id: queueId,
    job_id: jobId,
    job_type: jobType,
    revision: String(revision),
    status,
    scheduled_at: scheduledAt,
    publish_channel: 'telegram',
    caption_text: captionText,
    collage_drive_file_id: manifestDriveFileId,
    asset_drive_file_ids: JSON.stringify(assetDriveFileIds),
    topic_id: topicId,
    vk_post_id: '',
    publish_attempt_count: '0',
    last_publish_attempt_at: '',
    last_error_code: '',
    last_error_message: '',
    created_at: createdAt,
    updated_at: updatedAt,
  };
}
