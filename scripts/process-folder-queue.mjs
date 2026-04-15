import fs from 'node:fs/promises';
import path from 'node:path';

import { createRuntimeContext } from '../src/app.mjs';
import {
  buildFolderQueueGeneratedName,
  buildFolderQueueTestName,
  detectFolderQueueSubjectType,
  FOLDER_QUEUE_STATE_DIRS,
  isSupportedFolderQueueImage,
} from '../src/folder-queue.mjs';

const MIME_TYPES_BY_EXTENSION = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
};

function parseArgs(argv = []) {
  const options = {
    rootDir: '',
    chatId: '',
    mode: 'test',
    marker: 'TEST',
    backgroundMode: 'keep',
    rollbackDelaySeconds: 120,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    const value = argv[index + 1];
    if (token === '--root' && value) {
      options.rootDir = value;
      index += 1;
      continue;
    }
    if (token === '--chat-id' && value) {
      options.chatId = value;
      index += 1;
      continue;
    }
    if (token === '--mode' && value) {
      options.mode = value;
      index += 1;
      continue;
    }
    if (token === '--marker' && value) {
      options.marker = value;
      index += 1;
      continue;
    }
    if (token === '--background' && value) {
      options.backgroundMode = value;
      index += 1;
      continue;
    }
    if (token === '--rollback-delay-sec' && value) {
      options.rollbackDelaySeconds = Number.parseInt(value, 10);
      index += 1;
    }
  }

  if (!options.rootDir) {
    throw new Error('Missing required argument: --root');
  }
  if (!['test', 'live'].includes(String(options.mode))) {
    throw new Error(`Unsupported --mode value: ${options.mode}`);
  }
  if (!['keep', 'neutral', 'blur'].includes(String(options.backgroundMode))) {
    throw new Error(`Unsupported --background value: ${options.backgroundMode}`);
  }
  if (!Number.isInteger(options.rollbackDelaySeconds) || options.rollbackDelaySeconds < 0) {
    throw new Error(`Invalid --rollback-delay-sec value: ${options.rollbackDelaySeconds}`);
  }

  return options;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function mimeTypeFromFileName(fileName = '') {
  return MIME_TYPES_BY_EXTENSION[path.extname(String(fileName || '')).toLowerCase()] ?? 'image/jpeg';
}

async function fileExists(targetPath) {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function ensureDirectory(targetPath) {
  await fs.mkdir(targetPath, { recursive: true });
}

async function listFolderCandidates(rootDir) {
  const incomingRoot = path.join(rootDir, FOLDER_QUEUE_STATE_DIRS.incoming);
  const topEntries = await fs.readdir(incomingRoot, { withFileTypes: true });
  const candidates = [];

  for (const entry of topEntries) {
    if (entry.isFile() && isSupportedFolderQueueImage(entry.name)) {
      const fullPath = path.join(incomingRoot, entry.name);
      const stat = await fs.stat(fullPath);
      candidates.push({
        categoryPath: '',
        sourcePath: fullPath,
        fileName: entry.name,
        mtimeMs: stat.mtimeMs,
      });
      continue;
    }

    if (!entry.isDirectory()) {
      continue;
    }

    const categoryPath = entry.name;
    const categoryRoot = path.join(incomingRoot, categoryPath);
    const categoryEntries = await fs.readdir(categoryRoot, { withFileTypes: true });
    for (const categoryEntry of categoryEntries) {
      if (!categoryEntry.isFile() || !isSupportedFolderQueueImage(categoryEntry.name)) {
        continue;
      }
      const fullPath = path.join(categoryRoot, categoryEntry.name);
      const stat = await fs.stat(fullPath);
      candidates.push({
        categoryPath,
        sourcePath: fullPath,
        fileName: categoryEntry.name,
        mtimeMs: stat.mtimeMs,
      });
    }
  }

  return candidates.sort((left, right) => left.mtimeMs - right.mtimeMs);
}

function buildStatePath(rootDir, stateDirName, categoryPath, fileName = '') {
  return categoryPath
    ? path.join(rootDir, stateDirName, categoryPath, fileName)
    : path.join(rootDir, stateDirName, fileName);
}

async function writeRunReport(report) {
  const reportPath = path.join(process.cwd(), 'output', 'folder-queue-last-run.json');
  await ensureDirectory(path.dirname(reportPath));
  await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  return reportPath;
}

async function rollbackTestArtifacts({
  context,
  chatId,
  marker,
  rollbackDelaySeconds,
  originalIncomingPath,
  processedOriginalPath,
  generatedReadyPath,
  originalFileName,
}) {
  if (rollbackDelaySeconds > 0) {
    await context.service.sendMessage(
      chatId,
      `${marker} rollback через ${rollbackDelaySeconds} сек. Можно проверить папки до отката.`,
    );
    await sleep(rollbackDelaySeconds * 1000);
  }

  let sourceRestored = false;
  let generatedRemoved = false;

  if (generatedReadyPath && await fileExists(generatedReadyPath)) {
    await fs.unlink(generatedReadyPath);
    generatedRemoved = true;
  }

  if (processedOriginalPath && await fileExists(processedOriginalPath)) {
    await fs.rename(processedOriginalPath, originalIncomingPath);
    sourceRestored = true;
  }

  await context.service.sendMessage(
    chatId,
    [
      `${marker} rollback завершён.`,
      `Исходник возвращён в "В обработку": ${sourceRestored ? 'да' : 'нет'}`,
      `Тестовый результат удалён из "Новое": ${generatedRemoved ? 'да' : 'нет'}`,
      `Файл восстановлен как: ${originalFileName}`,
    ].join('\n'),
  );

  return {
    sourceRestored,
    generatedRemoved,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const context = await createRuntimeContext();
  const chatId = args.chatId || context.env.ownerChatId;
  if (!chatId) {
    throw new Error('Chat ID is not configured. Pass --chat-id or set OWNER_CHAT_ID.');
  }

  const candidates = await listFolderCandidates(args.rootDir);
  if (candidates.length === 0) {
    const reportPath = await writeRunReport({
      startedAt: new Date().toISOString(),
      status: 'empty',
      rootDir: args.rootDir,
      mode: args.mode,
    });
    await context.service.sendMessage(chatId, `Folder queue пуста.\nОтчёт: ${reportPath}`);
    return;
  }

  const candidate = candidates[0];
  const subjectType = detectFolderQueueSubjectType(candidate.categoryPath);
  const inProgressName = args.mode === 'test'
    ? buildFolderQueueTestName(candidate.fileName, args.marker)
    : candidate.fileName;
  const generatedName = args.mode === 'test'
    ? buildFolderQueueGeneratedName(candidate.fileName, args.marker)
    : candidate.fileName;

  const inProgressRoot = buildStatePath(args.rootDir, FOLDER_QUEUE_STATE_DIRS.inProgress, candidate.categoryPath);
  const readyRoot = buildStatePath(args.rootDir, FOLDER_QUEUE_STATE_DIRS.ready, candidate.categoryPath);
  const processedRoot = buildStatePath(args.rootDir, FOLDER_QUEUE_STATE_DIRS.processed, candidate.categoryPath);

  await Promise.all([
    ensureDirectory(inProgressRoot),
    ensureDirectory(readyRoot),
    ensureDirectory(processedRoot),
  ]);

  const originalIncomingPath = buildStatePath(
    args.rootDir,
    FOLDER_QUEUE_STATE_DIRS.incoming,
    candidate.categoryPath,
    candidate.fileName,
  );
  const inProgressPath = path.join(inProgressRoot, inProgressName);
  const processedOriginalPath = path.join(processedRoot, inProgressName);
  const generatedReadyPath = path.join(readyRoot, generatedName);
  const report = {
    startedAt: new Date().toISOString(),
    status: 'running',
    rootDir: args.rootDir,
    mode: args.mode,
    marker: args.marker,
    category: candidate.categoryPath,
    subjectType,
    sourceFileName: candidate.fileName,
    sourcePath: originalIncomingPath,
    inProgressPath,
    processedOriginalPath,
    generatedReadyPath,
  };

  await fs.rename(candidate.sourcePath, inProgressPath);

  try {
    await context.service.sendMessage(
      chatId,
      [
        `${args.marker} folder queue started.`,
        `Файл: ${candidate.fileName}`,
        `Категория: ${candidate.categoryPath || 'без категории'}`,
        `Режим: ${args.mode}`,
        `Маршрут: "В обработку" -> "В работе"`,
      ].join('\n'),
    );

    const originalBuffer = await fs.readFile(inProgressPath);
    const originalAsset = {
      buffer: originalBuffer,
      mimeType: mimeTypeFromFileName(inProgressPath),
      fileName: path.basename(inProgressPath),
    };

    const jobId = `FOLDER-${Date.now()}`;
    const queueId = `FOLDER-QUEUE-${Date.now()}`;
    const revision = 1;
    const prompts = await context.service.resolveWorkPrompts({
      jobId,
      revision,
      sourceAssetCount: 1,
      renderMode: 'separate',
      subjectType,
    });
    const consistencyNotes = await context.service.extractAlbumConsistencyNotes({
      assets: [originalAsset],
      prompts,
      jobId,
      revision,
      subjectType,
    });
    const processed = await context.service.processSingleWorkAsset({
      fileId: `local:${candidate.fileName}`,
      prompts,
      jobId,
      index: 0,
      revision,
      consistencyNotes,
      originalAsset,
      renderMode: 'separate',
      promptMode: 'normal',
      subjectType,
      browOutputMode: subjectType === 'brows' ? 'after_only' : '',
      backgroundMode: args.backgroundMode,
      cleanupMode: 'off',
      sourceAssetCount: 1,
      logContext: {
        chatId,
        userId: '',
        queueId,
        collectionId: `folder:${candidate.categoryPath || 'root'}`,
      },
    });

    await fs.writeFile(generatedReadyPath, processed.asset.buffer);
    await fs.rename(inProgressPath, processedOriginalPath);

    const captionImageUrls = await context.service.buildWorkCaptionImageUrls([processed.asset]);
    const captionResult = await context.service.generateWorkCaptionText({
      prompts,
      sourceAssetCount: 1,
      imageUrls: captionImageUrls,
      jobId,
      revision,
      renderMode: 'separate',
      chatId,
      userId: '',
      queueId,
      collectionId: `folder:${candidate.categoryPath || 'root'}`,
      subjectType,
      browOutputMode: subjectType === 'brows' ? 'after_only' : '',
    });

    await context.service.sendMessage(
      chatId,
      [
        `${args.marker} готовый результат.`,
        `Категория: ${candidate.categoryPath || 'без категории'}`,
        `Файл: ${generatedName}`,
        `Маршрут: "В работе" -> "Обработано", результат -> "Новое"`,
      ].join('\n'),
    );

    await context.service.callTelegram(
      'sendPhoto',
      chatId,
      context.service.buildTelegramMediaAsset(
        {
          buffer: processed.asset.buffer,
          mimeType: processed.asset.mimeType,
          fileName: generatedName,
        },
        jobId,
        0,
      ),
      {
        caption: captionResult.text,
      },
    );

    if (args.mode === 'test') {
      report.rollback = await rollbackTestArtifacts({
        context,
        chatId,
        marker: args.marker,
        rollbackDelaySeconds: args.rollbackDelaySeconds,
        originalIncomingPath,
        processedOriginalPath,
        generatedReadyPath,
        originalFileName: candidate.fileName,
      });
    }

    report.status = 'ok';
    report.completedAt = new Date().toISOString();
    report.reportPath = await writeRunReport(report);
  } catch (error) {
    if (await fileExists(inProgressPath)) {
      await fs.rename(inProgressPath, originalIncomingPath);
    } else if (await fileExists(processedOriginalPath)) {
      await fs.rename(processedOriginalPath, originalIncomingPath);
    }
    if (await fileExists(generatedReadyPath)) {
      await fs.unlink(generatedReadyPath);
    }

    report.status = 'failed';
    report.failedAt = new Date().toISOString();
    report.error = error?.message || 'Unknown error';
    report.reportPath = await writeRunReport(report);

    await context.service.sendMessage(
      chatId,
      [
        `${args.marker} folder queue failed.`,
        error?.message || 'Unknown error',
        `Отчёт: ${report.reportPath}`,
      ].join('\n'),
    );
    throw error;
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
