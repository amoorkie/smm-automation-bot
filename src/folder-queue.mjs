import { basename, extname } from 'node:path';

export const FOLDER_QUEUE_IMAGE_EXTENSIONS = new Set([
  '.jpg',
  '.jpeg',
  '.png',
  '.webp',
]);

export const FOLDER_QUEUE_STATE_DIRS = {
  incoming: 'В обработку',
  inProgress: 'В работе',
  ready: 'Новое',
  processed: 'Обработано',
};

export const FOLDER_QUEUE_CATEGORIES = [
  'Окрашивание',
  'Женские стрижки',
  'Прически',
  'Мужские стрижки',
  'Брови',
];

export function isSupportedFolderQueueImage(fileName = '') {
  const extension = extname(String(fileName || '')).toLowerCase();
  return FOLDER_QUEUE_IMAGE_EXTENSIONS.has(extension);
}

export function detectFolderQueueSubjectType(categoryPath = '') {
  const normalized = String(categoryPath || '').trim().toLowerCase();
  return normalized.includes('бров') ? 'brows' : 'hair';
}

export function sanitizeFolderQueueStem(fileName = '') {
  return basename(String(fileName || ''), extname(String(fileName || '')))
    .replace(/^TEST__[^_]*__?/iu, '')
    .replace(/^TEST__/iu, '')
    .replace(/^AUTO__[^_]*__?/iu, '')
    .replace(/^AUTO__/iu, '')
    .replace(/[^\p{L}\p{N}\-_]+/gu, '_')
    .replace(/_+/gu, '_')
    .replace(/^_+|_+$/gu, '') || 'photo';
}

export function buildFolderQueueTestName(fileName, options = {}) {
  const extension = extname(String(fileName || '')).toLowerCase() || '.jpg';
  const stem = sanitizeFolderQueueStem(fileName);
  const mode = String(options.photoType || 'studio').trim().toUpperCase();
  return `TEST__${mode}__${stem}${extension}`;
}

export function buildFolderQueueGeneratedName(fileName, options = {}) {
  const extension = extname(String(fileName || '')).toLowerCase() || '.jpg';
  const stem = sanitizeFolderQueueStem(fileName);
  const mode = String(options.photoType || 'studio').trim().toUpperCase();
  return `AUTO__${mode}__${stem}${extension}`;
}
