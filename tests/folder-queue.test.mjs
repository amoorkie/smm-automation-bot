import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildFolderQueueGeneratedName,
  buildFolderQueueTestName,
  detectFolderQueueSubjectType,
  FOLDER_QUEUE_CATEGORIES,
  FOLDER_QUEUE_STATE_DIRS,
  isSupportedFolderQueueImage,
  sanitizeFolderQueueStem,
} from '../src/folder-queue.mjs';

test('folder queue detects supported image files', () => {
  assert.equal(isSupportedFolderQueueImage('photo.jpg'), true);
  assert.equal(isSupportedFolderQueueImage('photo.PNG'), true);
  assert.equal(isSupportedFolderQueueImage('clip.mp4'), false);
});

test('folder queue exports the expected canonical state directories and categories', () => {
  assert.deepEqual(Object.keys(FOLDER_QUEUE_STATE_DIRS), ['incoming', 'inProgress', 'ready', 'processed']);
  assert.deepEqual(FOLDER_QUEUE_CATEGORIES, [
    'Окрашивание',
    'Женские стрижки',
    'Прически',
    'Мужские стрижки',
    'Брови',
  ]);
});

test('folder queue maps brows category to brows subject type', () => {
  assert.equal(detectFolderQueueSubjectType('Брови'), 'brows');
  assert.equal(detectFolderQueueSubjectType('Окрашивание'), 'hair');
  assert.equal(detectFolderQueueSubjectType(''), 'hair');
});

test('folder queue builds visible studio test names for source and generated files', () => {
  assert.equal(buildFolderQueueTestName('look.jpg'), 'TEST__STUDIO__look.jpg');
  assert.equal(
    buildFolderQueueGeneratedName('look.jpg'),
    'AUTO__STUDIO__look.jpg',
  );
  assert.equal(
    buildFolderQueueGeneratedName('TEST__STUDIO__messy name!!.jpg', { photoType: 'studio' }),
    'AUTO__STUDIO__messy_name.jpg',
  );
});

test('folder queue sanitizes noisy stems before file naming', () => {
  assert.equal(sanitizeFolderQueueStem('TEST__STUDIO__messy name!!.jpg'), 'messy_name');
  assert.equal(sanitizeFolderQueueStem('AUTO__NORMAL__demo file.png'), 'demo_file');
});
