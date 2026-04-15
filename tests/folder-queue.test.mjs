import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildFolderQueueGeneratedName,
  buildFolderQueueTestName,
  detectFolderQueueSubjectType,
  isSupportedFolderQueueImage,
} from '../src/folder-queue.mjs';

test('folder queue detects supported image files', () => {
  assert.equal(isSupportedFolderQueueImage('photo.jpg'), true);
  assert.equal(isSupportedFolderQueueImage('photo.PNG'), true);
  assert.equal(isSupportedFolderQueueImage('clip.mp4'), false);
});

test('folder queue maps brows category to brows subject type', () => {
  assert.equal(detectFolderQueueSubjectType('Брови'), 'brows');
  assert.equal(detectFolderQueueSubjectType('Окрашивание'), 'hair');
  assert.equal(detectFolderQueueSubjectType(''), 'hair');
});

test('folder queue builds visible test names for source and generated files', () => {
  assert.equal(buildFolderQueueTestName('look.jpg'), 'TEST__look.jpg');
  assert.equal(buildFolderQueueTestName('TEST__look.jpg'), 'TEST__look.jpg');
  assert.equal(buildFolderQueueGeneratedName('look.jpg'), 'TEST__GENERATED__look.jpg');
});

