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

export function isSupportedFolderQueueImage(fileName = '') {
  const extension = extname(String(fileName || '')).toLowerCase();
  return FOLDER_QUEUE_IMAGE_EXTENSIONS.has(extension);
}

export function detectFolderQueueSubjectType(categoryPath = '') {
  const normalized = String(categoryPath || '').trim().toLowerCase();
  return normalized.includes('бров') ? 'brows' : 'hair';
}

export function buildFolderQueueTestName(fileName, marker = 'TEST') {
  const normalizedMarker = String(marker || 'TEST').trim().toUpperCase();
  const extension = extname(String(fileName || ''));
  const stem = basename(String(fileName || ''), extension);
  const prefixedStem = stem.startsWith(`${normalizedMarker}__`)
    ? stem
    : `${normalizedMarker}__${stem}`;
  return `${prefixedStem}${extension}`;
}

export function buildFolderQueueGeneratedName(fileName, marker = 'TEST') {
  const normalizedMarker = String(marker || 'TEST').trim().toUpperCase();
  const extension = extname(String(fileName || '')).toLowerCase() || '.jpg';
  const stem = basename(String(fileName || ''), extname(String(fileName || '')));
  return `${normalizedMarker}__GENERATED__${stem}${extension}`;
}
