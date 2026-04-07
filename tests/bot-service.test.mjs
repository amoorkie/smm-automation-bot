import test from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';

import createRepositories from '../src/runtime/repositories.mjs';
import SalonBotService from '../src/services/bot-service.mjs';
import BotLogger from '../src/services/bot-logger.mjs';
import {
  DEFAULT_PROMPTS,
  TABLE_COLUMNS,
  TABLE_NAMES,
  USER_MESSAGES,
} from '../src/config/defaults.mjs';
import { parseTags } from '../src/domain/helpers.mjs';
import { TOPIC_SALON_REFERENCE_IMAGE_URLS } from '../src/config/topic-salon-refs.mjs';
test('expert topic fallback prompts stay separate from work prompts', () => {
  assert.match(DEFAULT_PROMPTS.topic_post_generation, /не подпись к фото работы/i);
  assert.match(DEFAULT_PROMPTS.topic_post_generation, /только от первого лица одного мастера/i);
  assert.match(DEFAULT_PROMPTS.topic_post_generation, /Добрый день, дорогие/i);
  assert.match(DEFAULT_PROMPTS.topic_post_generation, /эмодзи/i);
  assert.match(DEFAULT_PROMPTS.topic_post_generation, /Не пиши перечисления в одну строку/i);
  assert.match(DEFAULT_PROMPTS.topic_image_generation, /this exact small salon/i);
  assert.match(DEFAULT_PROMPTS.topic_image_generation, /not a portfolio image of a finished hairstyle/i);
  assert.match(DEFAULT_PROMPTS.topic_image_generation, /Hair may appear only as secondary context/i);
  assert.equal(TOPIC_SALON_REFERENCE_IMAGE_URLS.length, 3);
});

test('topic-like visual prompts forbid baked text and collage layouts', () => {
  assert.match(DEFAULT_PROMPTS.story_visual_generation, /zero readable text/i);
  assert.match(DEFAULT_PROMPTS.story_visual_generation, /Do not create an infographic, a collage, a grid/i);
  assert.match(DEFAULT_PROMPTS.story_manifest_generation, /коротких постов \/work/i);
  assert.match(DEFAULT_PROMPTS.story_manifest_generation, /Часто слышу этот вопрос/i);
  assert.match(DEFAULT_PROMPTS.slider_visual_generation, /zero readable text/i);
  assert.match(DEFAULT_PROMPTS.slider_visual_generation, /Do not generate a collage, a tiled grid/i);
  assert.match(DEFAULT_PROMPTS.slider_manifest_generation, /меньше текста, чем stories/i);
  assert.match(DEFAULT_PROMPTS.story_manifest_generation, /body должен коротко раскрывать тему/i);
  assert.match(DEFAULT_PROMPTS.story_manifest_generation, /Не выводи теги, keywords/i);
});

test('stories body normalization humanizes neutral text to master voice', () => {
  const ctx = createService();
  const body = ctx.service.normalizeStoryBody(
    'Кондиционер нужен чаще, потому что он закрывает кутикулу после каждого мытья.',
    { topic_id: 'ST-VOICE', title: 'Кондиционер и маска', brief: '', tags: 'уход;длина' },
  );

  assert.match(body, /Если коротко,|Часто слышу этот вопрос\.|Я бы сказала так:|По опыту скажу так:/u);
});

test('slider manifest normalization replaces generic cover brief and uses descriptive fallback slides', () => {
  const ctx = createService();
  const manifest = ctx.service.normalizeTopicLikeManifest('slider', {
    coverTitle: '5 привычек, которые делают длину чище на вид',
    coverSubtitle: 'Небольшая карусель о повседневных действиях, которые реально заметны.',
    slides: [],
  }, {
    topic_id: 'SL-1',
    title: '5 привычек, которые делают длину чище на вид',
    brief: 'Небольшая карусель о повседневных действиях, которые реально заметны.',
    tags: 'свежесть;корни;длина;уход',
  });

  assert.equal(manifest.eyebrow, '');
  assert.notEqual(manifest.coverSubtitle, 'Небольшая карусель о повседневных действиях, которые реально заметны.');
  assert.ok(Array.isArray(manifest.slides));
  assert.ok(manifest.slides.length >= 3);
  assert.doesNotMatch(manifest.slides[0].title, /^свежесть|корни|длина|уход$/iu);
});

test('slider normalization for base home care aligns cover and denser slides', () => {
  const ctx = createService();
  const manifest = ctx.service.normalizeTopicLikeManifest('slider', {
    coverTitle: '5 средств для базового ухода дома',
    coverSubtitle: 'Тема про базовый уход.',
    slides: [
      { title: 'Шампунь', body: 'Очищает кожу головы и длину без ощущения тяжести.', bullets: ['- Подбирайте по коже головы'] },
      { title: 'Кондиционер', body: 'Закрывает кутикулу.', bullets: ['• После каждого мытья'] },
      { title: 'Маска', body: 'Дает более глубокое питание.', bullets: ['-2 раза в неделю'] },
      { title: 'Несмываемый уход', body: 'Снимает пушение.', bullets: ['1. Крем или спрей'] },
    ],
  }, {
    topic_id: 'SL-BASE',
    title: '5 средств для базового ухода дома',
    brief: 'Короткая памятка по домашнему уходу.',
    tags: 'база;уход;дом;средства',
  });

  assert.equal(manifest.eyebrow, '');
  assert.match(manifest.coverSubtitle, /шампунь/u);
  assert.match(manifest.coverSubtitle, /кондиционер/u);
  assert.match(manifest.coverSubtitle, /маск/u);
  assert.match(manifest.coverSubtitle, /несмываем/u);
  assert.deepEqual(manifest.coverBullets, [
    'Шампунь по коже головы',
    'Кондиционер после каждого мытья',
    'Маска 1-2 раза в неделю',
    'Несмываемый уход по длине, например спрей или крем',
  ]);
  assert.equal(manifest.slides.length, 4);
  assert.ok(manifest.slides.every((slide) => slide.body.split(/\s+/u).length >= 8));
  assert.ok(manifest.slides[2].bullets.length >= 1);
  assert.ok(manifest.slides[2].bullets.every((item) => !String(item).startsWith('-')));
  assert.match(manifest.slides[2].bullets.join(' '), /недел/u);
  assert.ok(manifest.slides[3].bullets.length >= 1);
  assert.ok(manifest.slides[3].bullets.every((item) => !String(item).startsWith('-')));
  assert.match(manifest.slides[3].bullets.join(' '), /крем|спрей/u);
});

test('normalizeOverlayBullet strips list markers but keeps numeric content', () => {
  const ctx = createService();
  assert.equal(ctx.service.normalizeOverlayBullet('-2 раза в неделю'), '2 раза в неделю');
  assert.equal(ctx.service.normalizeOverlayBullet('1. После каждого мытья'), 'После каждого мытья');
  assert.equal(ctx.service.normalizeOverlayBullet('• Только по длине'), 'Только на волосы');
  assert.equal(ctx.service.normalizeOverlayBullet('начинайте с концов'), 'Начинайте с концов');
  assert.equal(ctx.service.normalizeOverlayBullet('не дёргайте сухие узлы'), 'Не дёргайте сухие узлы');
  assert.equal(ctx.service.normalizeOverlayBullet('Наносите На Влажные Волосы'), 'Наносите на влажные волосы');
  assert.equal(ctx.service.normalizeOverlayBullet('Берите Совсем Немного'), 'Берите совсем немного');
});

test('overlay text simplification expands leave-in care and removes hard jargon', () => {
  const ctx = createService();
  assert.match(
    ctx.service.normalizeSliderText('Несмываемый уход помогает закрывает кутикулу'),
    /несмываемый уход/iu,
  );
  assert.doesNotMatch(
    ctx.service.normalizeSliderText('Чистая щётка и сухая длина быстрее теряет вид'),
    /щётка|длина/iu,
  );
  assert.doesNotMatch(
    ctx.service.normalizeStoryBody('Себум быстро переносится на длину у лица.', { topic_id: 'ST-SIMPLE', title: 'Свежесть длины', brief: '', tags: '' }),
    /себум/iu,
  );
});

test('parseTags splits both commas and semicolons', () => {
  assert.deepEqual(parseTags('color;softness,care ; home'), ['color', 'softness', 'care', 'home']);
});

test('slider normalization appends glossary explanations only for terms kept in display text', () => {
  const ctx = createService();
  const manifest = ctx.service.normalizeTopicLikeManifest('slider', {
    coverTitle: 'Когда нужен детокс-шампунь',
    coverSubtitle: 'Коротко о более глубоком очищении без перегруза.',
    slides: [
      {
        title: 'Детокс-шампунь раз в неделю',
        body: 'Он помогает убрать накопившийся уход и ощущение тяжести, когда обычного шампуня уже мало.',
        bullets: ['Используйте не каждый раз', 'Смотрите по состоянию кожи головы'],
      },
    ],
  }, {
    topic_id: 'SL-GLOSSARY',
    title: 'Когда нужен детокс-шампунь',
    brief: 'Разбор по уходу.',
    tags: 'детокс-шампунь;уход',
  });

  assert.match(manifest.slides[0].footer, /Детокс-шампунь — это/u);
  assert.ok(manifest.slides[0].bullets.every((item) => /^[А-ЯЁA-Z0-9]/u.test(item)));
});

test('glossary footer is built only from final display text', () => {
  const ctx = createService();
  const footer = ctx.service.mergeOverlayFooter(
    '',
    'Шампунь',
    'Мягкое очищение без лишней сухости.',
    ['После каждого мытья']
  );

  assert.equal(footer, '');
});

test('slider body removes inline term definition and repeated lead', () => {
  const ctx = createService();
  const manifest = ctx.service.normalizeTopicLikeManifest('slider', {
    coverTitle: '4 средства для базового ухода дома',
    coverSubtitle: 'База для дома без лишней воды.',
    slides: [
      {
        title: 'Несмываемый уход, например спрей, крем или лосьон',
        body: 'Несмываемый уход, например спрей, крем или лосьон — это спрей, крем, лосьон или флюид. Он помогает убрать пушение, добавить гладкость и защитить волосы в течение дня.',
        bullets: ['Наносите На Влажные Волосы', 'Берите Совсем Немного'],
      },
    ],
  }, {
    topic_id: 'SL-DEDUP',
    title: '4 средства для базового ухода дома',
    brief: 'Короткий разбор базы дома.',
    tags: 'уход;спрей',
  });

  assert.doesNotMatch(manifest.slides[0].body, /— это/iu);
  assert.doesNotMatch(manifest.slides[0].body, /это спрей, крем, лосьон или флюид/iu);
  assert.equal(manifest.slides[0].bullets[0], 'Наносите на влажные волосы');
  assert.equal(manifest.slides[0].bullets[1], 'Берите совсем немного');
});

class FakeStore {
  constructor(initialRows = {}) {
    this.store = new Map();
    for (const [tableName, columns] of Object.entries(TABLE_COLUMNS)) {
      this.store.set(tableName, {
        columns,
        rows: (initialRows[tableName] ?? []).map((row, index) => ({ __rowNumber: index + 1, id: index + 1, ...row })),
        nextId: (initialRows[tableName] ?? []).length + 1,
      });
    }
  }

  async getRows(tableName) {
    return (this.store.get(tableName)?.rows ?? []).map((row) => ({ ...row }));
  }

  async getRowsByQuery(tableName, { columns = '*', eq = {}, inFilters = {}, orderBy = [{ column: 'id', ascending: true }], offset = null, limit = null } = {}) {
    const table = this.store.get(tableName);
    let rows = (table?.rows ?? []).map((row) => ({ ...row }));
    for (const [column, value] of Object.entries(eq ?? {})) {
      rows = rows.filter((row) => String(row[column] ?? '') === String(value));
    }
    for (const [column, values] of Object.entries(inFilters ?? {})) {
      const normalized = Array.isArray(values) ? values.map((value) => String(value)) : [];
      if (normalized.length > 0) {
        rows = rows.filter((row) => normalized.includes(String(row[column] ?? '')));
      }
    }
    for (const rule of Array.isArray(orderBy) ? orderBy : []) {
      if (!rule?.column) {
        continue;
      }
      rows.sort((left, right) => {
        const leftValue = left[rule.column];
        const rightValue = right[rule.column];
        const comparison = String(leftValue ?? '').localeCompare(String(rightValue ?? ''), 'ru', { numeric: true });
        return rule.ascending === false ? comparison * -1 : comparison;
      });
    }
    if (Number.isInteger(offset) && Number.isInteger(limit) && limit > 0) {
      rows = rows.slice(offset, offset + limit);
    } else if (Number.isInteger(limit) && limit > 0) {
      rows = rows.slice(0, limit);
    }
    if (columns !== '*' && columns) {
      const list = Array.isArray(columns) ? columns : String(columns).split(',').map((item) => item.trim()).filter(Boolean);
      rows = rows.map((row) => {
        const payload = { __rowNumber: row.__rowNumber, id: row.id };
        for (const column of list) {
          if (column in row) {
            payload[column] = row[column];
          }
        }
        return payload;
      });
    }
    return rows;
  }

  async getRowByQuery(tableName, query = {}) {
    const rows = await this.getRowsByQuery(tableName, { ...query, limit: 1 });
    return rows[0] ?? null;
  }

  async countRowsByQuery(tableName, query = {}) {
    const rows = await this.getRowsByQuery(tableName, query);
    return rows.length;
  }

  async appendRow(tableName, row) {
    const table = this.store.get(tableName);
    const next = { __rowNumber: table.nextId, id: table.nextId, ...row };
    table.rows.push(next);
    table.nextId += 1;
    return { ...next };
  }

  async updateRowByNumber(tableName, rowNumber, row) {
    const table = this.store.get(tableName);
    const index = table.rows.findIndex((item) => item.__rowNumber === rowNumber);
    assert.notEqual(index, -1, `row ${rowNumber} not found in ${tableName}`);
    table.rows[index] = { __rowNumber: rowNumber, id: rowNumber, ...row };
  }

  async upsertRowByColumn(tableName, keyColumn, keyValue, patch) {
    const table = this.store.get(tableName);
    const index = table.rows.findIndex((row) => String(row[keyColumn]) === String(keyValue));
    if (index >= 0) {
      table.rows[index] = {
        ...table.rows[index],
        ...patch,
        __rowNumber: table.rows[index].__rowNumber,
        id: table.rows[index].id,
      };
      return { mode: 'update', rowNumber: table.rows[index].__rowNumber };
    }
    const next = { __rowNumber: table.nextId, id: table.nextId, ...patch };
    table.rows.push(next);
    table.nextId += 1;
    return { mode: 'insert', rowNumber: next.__rowNumber };
  }

  async upsertRowsByColumn(tableName, keyColumn, rows) {
    const normalizedRows = Array.isArray(rows) ? rows : [];
    for (const row of normalizedRows) {
      await this.upsertRowByColumn(tableName, keyColumn, row[keyColumn], row);
    }
    return normalizedRows.map((row) => ({ keyValue: row[keyColumn] }));
  }

  async updateRowsByQuery(tableName, patch, { eq = {}, inFilters = {} } = {}) {
    const rows = await this.getRowsByQuery(tableName, { eq, inFilters });
    for (const row of rows) {
      await this.updateRowByNumber(tableName, row.__rowNumber, { ...row, ...patch });
    }
  }

  async deleteRowByNumber(tableName, rowNumber) {
    const table = this.store.get(tableName);
    const index = table.rows.findIndex((item) => item.__rowNumber === rowNumber);
    if (index >= 0) {
      table.rows.splice(index, 1);
      table.rows = table.rows.map((row, offset) => ({ ...row, __rowNumber: offset + 1, id: offset + 1 }));
      table.nextId = table.rows.length + 1;
    }
  }

  async deleteRowsByNumbers(tableName, rowNumbers) {
    const sorted = [...new Set(rowNumbers)].sort((left, right) => right - left);
    for (const rowNumber of sorted) {
      await this.deleteRowByNumber(tableName, rowNumber);
    }
  }

  async validateContract() {}
}

class FakeBotLogger {
  constructor() {
    this.entries = [];
  }

  async log(entry) {
    this.entries.push({ ts: new Date().toISOString(), level: 'INFO', ...entry });
  }
}

function createFakeBot() {
  const sent = [];
  let nextMessageId = 100;
  return {
    sent,
    api: {
      async sendMessage(chatId, text, extra = {}) {
        const message = { message_id: nextMessageId++, chat: { id: chatId }, text, extra };
        sent.push({ type: 'message', ...message });
        return message;
      },
      async sendPhoto(chatId, photo, extra = {}) {
        const message = {
          message_id: nextMessageId++,
          chat: { id: chatId },
          photo: [{ file_id: `telegram-preview-${nextMessageId}` }],
          sentPhoto: photo,
          extra,
        };
        sent.push({ type: 'photo', ...message });
        return message;
      },
      async sendMediaGroup(chatId, media) {
        const result = media.map((item, index) => ({
          message_id: nextMessageId++,
          chat: { id: chatId },
          item,
          photo: [{ file_id: `telegram-preview-group-${nextMessageId}-${index + 1}` }],
        }));
        sent.push({ type: 'media_group', chatId, media });
        return result;
      },
      async editMessageText(chatId, messageId, text, extra = {}) {
        const message = { message_id: messageId, chat: { id: chatId }, text, extra };
        sent.push({ type: 'edit_message_text', ...message });
        return message;
      },
      async editMessageMedia(chatId, messageId, media, extra = {}) {
        const message = {
          message_id: messageId,
          chat: { id: chatId },
          photo: [{ file_id: `telegram-preview-edited-${messageId}` }],
          media,
          extra,
        };
        sent.push({ type: 'edit_message_media', ...message });
        return message;
      },
      async editMessageCaption(chatId, messageId, extra = {}) {
        const message = { message_id: messageId, chat: { id: chatId }, caption: extra.caption, extra };
        sent.push({ type: 'edit_message_caption', ...message });
        return message;
      },
      async deleteMessage(chatId, messageId) {
        sent.push({ type: 'delete_message', chatId, messageId });
        return true;
      },
      async answerCallbackQuery(id, payload) {
        sent.push({ type: 'callback_answer', id, payload });
      },
      async getFile(fileId) {
        return { file_id: fileId, file_path: `${fileId}.jpg` };
      },
      async setWebhook() {},
    },
  };
}

function createPromptConfig() {
  const prompts = {
    ...DEFAULT_PROMPTS,
    contact_block: 'Запись по телефону +7 (987) 741-83-99 📞',
  };
  return {
    async refresh() {
      return { ...prompts };
    },
    async get(key, fallback = '') {
      return prompts[key] || fallback;
    },
  };
}

function createOpenRouter(options = {}) {
  const textCalls = [];
  const imageCalls = [];
  return {
    textCalls,
    imageCalls,
    async generateText(payload) {
      textCalls.push(payload);
      if (payload?.metadata?.pass === 'consistency') {
        return {
          text: 'Длина волос: средняя. Укладка: высокий собранный пучок с локонами. Украшение: на правой стороне, ближе к макушке. Серьги и одежду не менять. Форму укладки не менять.',
        };
      }
      return {
        text: payload?.metadata?.source_type === 'topic'
          ? 'Полезный текст по теме ✨\nКоротко и по делу.'
          : 'Аккуратная работа с формой и текстурой ✨\nСделала образ чище и выразительнее, чтобы волосы выглядели ухоженно и легко читались в кадре.',
      };
    },
    async generateImages(payload) {
      imageCalls.push(payload);
      const label = payload?.metadata?.source_type === 'topic'
        ? 'topic'
        : `work-${payload?.metadata?.asset_index ?? 0}-${payload?.metadata?.pass ?? 'base'}`;
      const imageBuffer = await sharp({
        create: {
          width: 900,
          height: 1200,
          channels: 3,
          background: label.includes('polish') ? '#ead8c4' : label.includes('reframe') ? '#d7c6b4' : '#b7926f',
        },
      }).jpeg().toBuffer();
      return { images: [`data:image/jpeg;base64,${imageBuffer.toString('base64')}`] };
    },
  };
}

function createService({ initialTables = {}, envOverrides = {}, openrouterOverrides = {} } = {}) {
  const store = new FakeStore(initialTables);
  const repos = createRepositories(store);
  const bot = createFakeBot();
  const botLogger = new FakeBotLogger();
  const openrouter = createOpenRouter(openrouterOverrides);
  const service = new SalonBotService({
    env: {
      appTimezone: 'Europe/Moscow',
      tgBotToken: 'token',
      ownerChatId: '99',
      imageModelId: 'google/gemini-3.1-flash-image-preview',
      textModelId: 'openai/gpt-5.4',
      webhookBaseUrl: '',
      internalWorkerDispatchEnabled: false,
      topicSourceStatusMutationsEnabled: true,
      ...envOverrides,
    },
    bot,
    repos,
    store,
    openrouter,
    promptConfig: createPromptConfig(),
    botLogger,
  });

  service.downloadTelegramFile = async (fileId) => ({
    buffer: await sharp({
      create: {
        width: 900,
        height: 1200,
        channels: 3,
        background: fileId.includes('2') ? '#8f6a55' : '#a78468',
      },
    }).jpeg().toBuffer(),
    mimeType: 'image/jpeg',
    filePath: `${fileId}.jpg`,
  });
  service.scheduleCollectionFinalize = async () => ({ ok: true, scheduled: false });

  return { service, repos, store, bot, botLogger, openrouter };
}

function buildTopicLikeSourceRow({
  topicId,
  title,
  brief,
  tags = 'care,home',
  priority = '1',
  status = 'ready',
  notes = '',
} = {}) {
  return {
    topic_id: topicId,
    title,
    brief,
    tags,
    priority,
    status,
    reserved_by: '',
    reserved_at: '',
    reservation_expires_at: '',
    last_job_id: '',
    last_published_at: '',
    notes,
  };
}

async function expireOnlyCollection(ctx) {
  const collections = await ctx.store.getRows(TABLE_NAMES.workCollections);
  assert.equal(collections.length, 1);
  await ctx.store.updateRowByNumber(TABLE_NAMES.workCollections, collections[0].__rowNumber, {
    ...collections[0],
    deadline_at: new Date(Date.now() - 1000).toISOString(),
  });
}

async function pickCallbackToken(ctx, action) {
  const callbackRows = await ctx.store.getRows(TABLE_NAMES.callbackTokens);
  const candidates = callbackRows
    .filter((row) => row.action === action && String(row.superseded ?? '0') !== '1' && String(row.used ?? '0') !== '1')
    .sort((left, right) => Number(right.__rowNumber ?? right.id ?? 0) - Number(left.__rowNumber ?? left.id ?? 0));
  return candidates[0]?.token ?? null;
}

async function pickCallbackTokenByPrefix(ctx, actionPrefix) {
  const callbackRows = await ctx.store.getRows(TABLE_NAMES.callbackTokens);
  const candidates = callbackRows
    .filter((row) => String(row.action ?? '').startsWith(actionPrefix) && String(row.superseded ?? '0') !== '1' && String(row.used ?? '0') !== '1')
    .sort((left, right) => Number(right.__rowNumber ?? right.id ?? 0) - Number(left.__rowNumber ?? left.id ?? 0));
  return candidates[0]?.token ?? null;
}

function assertTopicLikeSourceRowUntouched(row) {
  assert.equal(row.status, 'ready');
  assert.equal(row.reserved_by, '');
  assert.equal(row.reserved_at, '');
  assert.equal(row.reservation_expires_at, '');
  assert.equal(row.last_job_id, '');
  assert.equal(row.last_published_at, '');
}

async function waitFor(check, { timeoutMs = 1000, intervalMs = 10 } = {}) {
  const startedAt = Date.now();
  let lastError;
  while (Date.now() - startedAt < timeoutMs) {
    try {
      return await check();
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
  }
  throw lastError ?? new Error('waitFor timed out');
}

function allSentTexts(bot) {
  return bot.sent
    .filter((item) => ['message', 'edit_message_text', 'edit_message_caption'].includes(item.type))
    .map((item) => item.text ?? item.caption ?? '');
}

async function getWorkSessionPayload(ctx, chatId) {
  const session = await ctx.repos.getSessionByChatAndMode(chatId, 'work');
  return session ? JSON.parse(session.pending_payload_json || '{}') : null;
}

async function chooseWorkSubject(ctx, {
  chatId,
  userId,
  action = 'work_subject_hair',
  updateId = Date.now(),
  callbackId = `cb-${action}-${Date.now()}`,
} = {}) {
  const token = await pickCallbackToken(ctx, action);
  assert.ok(token, `Missing callback token for ${action}`);
  const payload = await getWorkSessionPayload(ctx, chatId);
  const runtimes = await ctx.store.getRows(TABLE_NAMES.jobRuntimeCache);
  const runtime = runtimes.length > 0
    ? await ctx.repos.getRuntime(runtimes[runtimes.length - 1].job_id)
    : null;
  await ctx.service.handleTelegramUpdate({
    update_id: updateId,
    callback_query: {
      id: callbackId,
      data: `${action}:${token}`,
      from: { id: userId },
      message: { message_id: payload?.textMessageId ?? runtime?.text_message_id ?? 0, chat: { id: chatId } },
    },
  });
}

async function chooseWorkPhotoType(ctx, {
  chatId,
  userId,
  action = 'work_photo_type_normal',
  updateId = Date.now(),
  callbackId = `cb-${action}-${Date.now()}`,
} = {}) {
  const session = await ctx.repos.getSessionByChatAndMode(chatId, 'work');
  assert.notEqual(session?.state, 'awaiting_assets', 'Photo type must be selected before uploading /work assets');
  const token = await pickCallbackToken(ctx, action);
  assert.ok(token, `Missing callback token for ${action}`);
  const payload = await getWorkSessionPayload(ctx, chatId);
  await ctx.service.handleTelegramUpdate({
    update_id: updateId,
    callback_query: {
      id: callbackId,
      data: `${action}:${token}`,
      from: { id: userId },
      message: { message_id: payload?.textMessageId ?? 0, chat: { id: chatId } },
    },
  });
}

async function chooseRuntimeAction(ctx, {
  chatId,
  userId,
  action,
  updateId = Date.now(),
  callbackId = `cb-${action}-${Date.now()}`,
} = {}) {
  const token = await pickCallbackToken(ctx, action);
  assert.ok(token, `Missing callback token for ${action}`);
  const runtimes = await ctx.store.getRows(TABLE_NAMES.jobRuntimeCache);
  assert.ok(runtimes.length > 0, 'No runtime rows found');
  const runtime = await ctx.repos.getRuntime(runtimes[runtimes.length - 1].job_id);
  await ctx.service.handleTelegramUpdate({
    update_id: updateId,
    callback_query: {
      id: callbackId,
      data: `${action}:${token}`,
      from: { id: userId },
      message: { message_id: runtime.text_message_id ?? 0, chat: { id: chatId } },
    },
  });
  return await ctx.repos.getRuntime(runtime.job_id);
}

async function chooseHairSubjectIfNeeded(ctx, {
  chatId,
  userId,
  updateId = Date.now(),
  callbackId = `cb-work-subject-hair-${Date.now()}`,
} = {}) {
  if (!(await pickCallbackToken(ctx, 'work_subject_hair'))) {
    return null;
  }
  return chooseRuntimeAction(ctx, {
    chatId,
    userId,
    action: 'work_subject_hair',
    updateId,
    callbackId,
  });
}

test('work flow builds collage preview without photo-accepted spam', async () => {
  const ctx = createService();

  await ctx.service.handleTelegramUpdate({
    update_id: 1,
    message: { message_id: 1, text: '/work', chat: { id: 42 }, from: { id: 7 } },
  });
  await chooseWorkPhotoType(ctx, {
    chatId: 42,
    userId: 7,
      action: 'work_photo_type_normal',
    updateId: 1001,
    callbackId: 'cb-work-photo-type-1',
  });
  await Promise.all([
    ctx.service.handleTelegramUpdate({
      update_id: 2,
      message: {
        message_id: 2,
        media_group_id: 'album-1',
        chat: { id: 42 },
        from: { id: 7 },
        photo: [
          { file_id: 'p1-small', file_unique_id: 'u1', width: 100, height: 100 },
          { file_id: 'p1-large', file_unique_id: 'u2', width: 1000, height: 1000 },
        ],
      },
    }),
    ctx.service.handleTelegramUpdate({
      update_id: 3,
      message: {
        message_id: 3,
        media_group_id: 'album-1',
        chat: { id: 42 },
        from: { id: 7 },
        photo: [
          { file_id: 'p2-small', file_unique_id: 'u3', width: 100, height: 100 },
          { file_id: 'p2-large', file_unique_id: 'u4', width: 900, height: 900 },
        ],
      },
    }),
  ]);

  await expireOnlyCollection(ctx);
  await ctx.service.runCollectionFinalizer();

  const runtimesAfterFinalize = await ctx.store.getRows(TABLE_NAMES.jobRuntimeCache);
  let interimRuntime = await ctx.repos.getRuntime(runtimesAfterFinalize[0].job_id);
  assert.equal(interimRuntime.runtime_status, 'awaiting_subject_type');
  interimRuntime = await chooseHairSubjectIfNeeded(ctx, {
    chatId: 42,
    userId: 7,
    updateId: 1002,
    callbackId: 'cb-work-subject-hair-1',
  });
  const renderModeToken = await pickCallbackToken(ctx, 'render_mode_collage');
  assert.ok(renderModeToken);
  assert.equal(interimRuntime.runtime_status, 'awaiting_render_mode');

  await ctx.service.handleTelegramUpdate({
    update_id: 4,
    callback_query: {
      id: 'cb-work-1',
      data: `render_mode_collage:${renderModeToken}`,
      from: { id: 7 },
      message: { message_id: interimRuntime.text_message_id, chat: { id: 42 } },
    },
  });
  await chooseRuntimeAction(ctx, {
    chatId: 42,
    userId: 7,
    action: 'background_mode_blur',
    updateId: 5,
    callbackId: 'cb-work-bg-1',
  });
  await chooseRuntimeAction(ctx, {
    chatId: 42,
    userId: 7,
    action: 'cleanup_off',
    updateId: 6,
    callbackId: 'cb-work-cleanup-1',
  });

  await waitFor(async () => {
    const runtime = await ctx.repos.getRuntime(interimRuntime.job_id);
    assert.equal(runtime.runtime_status, 'preview_ready');
  });

  const queueRows = await ctx.store.getRows(TABLE_NAMES.contentQueue);
  assert.equal(queueRows.length, 1);
  assert.equal(queueRows[0].job_type, 'work');
  assert.equal(queueRows[0].status, 'preview_ready');
  assert.match(queueRows[0].caption_text, /\+7 \(987\) 741-83-99/);

  const runtime = await ctx.repos.getRuntime(queueRows[0].job_id);
  assert.equal(runtime.active_revision, 1);
  assert.deepEqual(runtime.draft_payload.originalTelegramFileIds, ['p1-large', 'p2-large']);
  assert.equal(runtime.draft_payload.previewTelegramFileIds.length, 1);
  assert.equal(runtime.draft_payload.promptMode, 'normal');
  assert.equal(runtime.draft_payload.photoType, 'normal');
  assert.equal(runtime.draft_payload.backgroundMode, 'blur');
  assert.equal(runtime.draft_payload.cleanupMode, 'off');
  assert.equal(runtime.draft_payload.renderMode, 'collage');
  assert.equal(runtime.draft_payload.finalRenderMode, 'collage');
  assert.equal(runtime.draft_payload.revisionHistory.length, 1);
  assert.notEqual(runtime.text_message_id, runtime.collage_message_id);
  assert.equal(await ctx.repos.getSessionByChatAndMode(42, 'work'), null);
  assert.equal(ctx.openrouter.textCalls.find((call) => call.metadata?.source_type === 'work').model, 'openai/gpt-5.4');
  assert.ok(ctx.openrouter.imageCalls.every((call) => call.metadata?.model === 'google/gemini-3.1-flash-image-preview'));
  assert.equal(ctx.openrouter.imageCalls.filter((call) => call.metadata?.pass === 'compose_collage').length, 1);

  const sentTexts = allSentTexts(ctx.bot);
  assert.ok(sentTexts.includes(USER_MESSAGES.workPhotoRequest));
  assert.ok(sentTexts.some((text) => text.includes(USER_MESSAGES.workSubjectChoice)));
  assert.ok(sentTexts.some((text) => text.includes(USER_MESSAGES.workModeChoice)));
  assert.ok(sentTexts.some((text) => text.includes(USER_MESSAGES.workBackgroundChoice)));
  assert.ok(!sentTexts.some((text) => /Фото принято:/u.test(text)));
  assert.ok(sentTexts.includes(USER_MESSAGES.generationQueued.collage));
  assert.ok(sentTexts.includes(USER_MESSAGES.workAnalyzingPhotos));
  assert.ok(sentTexts.includes(USER_MESSAGES.workEnhancingImages));
  assert.ok(sentTexts.includes(USER_MESSAGES.workPreparingText));
  assert.ok(sentTexts.includes(USER_MESSAGES.assemblingPreview));
  assert.ok(ctx.bot.sent.some((item) => item.type === 'photo'));
  assert.ok(ctx.bot.sent.some((item) => item.type === 'delete_message'));
});

test('three-photo album can be rendered in separate mode and keeps all files', async () => {
  const ctx = createService();

  await ctx.service.handleTelegramUpdate({
    update_id: 30,
    message: { message_id: 30, text: '/work', chat: { id: 77 }, from: { id: 11 } },
  });
  await chooseWorkPhotoType(ctx, {
    chatId: 77,
    userId: 11,
    action: 'work_photo_type_normal',
    updateId: 1030,
    callbackId: 'cb-work-prompt-3',
  });

  for (const [offset, fileId] of ['a-large', 'b-large', 'c-large'].entries()) {
    await ctx.service.handleTelegramUpdate({
      update_id: 31 + offset,
      message: {
        message_id: 31 + offset,
        media_group_id: 'album-3',
        chat: { id: 77 },
        from: { id: 11 },
        photo: [
          { file_id: `${fileId}-small`, file_unique_id: `u-small-${offset}`, width: 100, height: 100 },
          { file_id: fileId, file_unique_id: `u-${offset}`, width: 1000, height: 1000 },
        ],
      },
    });
  }

  await expireOnlyCollection(ctx);
  await ctx.service.runCollectionFinalizer();

  const runtimesAfterFinalize = await ctx.store.getRows(TABLE_NAMES.jobRuntimeCache);
  let runtimeBefore = await ctx.repos.getRuntime(runtimesAfterFinalize[0].job_id);
  assert.equal(runtimeBefore.runtime_status, 'awaiting_subject_type');
  runtimeBefore = await chooseHairSubjectIfNeeded(ctx, {
    chatId: 77,
    userId: 11,
    updateId: 1031,
    callbackId: 'cb-work-subject-hair-3',
  });
  const separateToken = await pickCallbackToken(ctx, 'render_mode_separate');
  assert.ok(separateToken);
  await ctx.service.handleTelegramUpdate({
    update_id: 40,
    callback_query: {
      id: 'cb-work-3',
      data: `render_mode_separate:${separateToken}`,
      from: { id: 11 },
      message: { message_id: runtimeBefore.text_message_id, chat: { id: 77 } },
    },
  });

  const runtimeAfterBackground = await chooseRuntimeAction(ctx, {
    chatId: 77,
    userId: 11,
    action: 'background_mode_blur',
    updateId: 41,
    callbackId: 'cb-work-bg-3',
  });
  assert.equal(runtimeAfterBackground.runtime_status, 'awaiting_cleanup_mode');
  await chooseRuntimeAction(ctx, {
    chatId: 77,
    userId: 11,
    action: 'cleanup_off',
    updateId: 42,
    callbackId: 'cb-work-cleanup-3',
  });

  await waitFor(async () => {
    const runtime = await ctx.repos.getRuntime(runtimesAfterFinalize[0].job_id);
    assert.equal(runtime.runtime_status, 'preview_ready');
  });

  const queueRows = await ctx.store.getRows(TABLE_NAMES.contentQueue);
  const runtime = await ctx.repos.getRuntime(queueRows[0].job_id);
  assert.deepEqual(runtime.draft_payload.originalTelegramFileIds, ['a-large', 'b-large', 'c-large']);
  assert.equal(runtime.draft_payload.previewTelegramFileIds.length, 3);
  assert.equal(runtime.draft_payload.backgroundMode, 'blur');
  assert.equal(runtime.draft_payload.cleanupMode, 'off');
  assert.equal(runtime.draft_payload.renderMode, 'separate');
  assert.equal(runtime.draft_payload.finalRenderMode, 'separate');
  assert.equal(runtime.draft_payload.sourceAssetCount, 3);
  assert.equal(runtime.collage_message_id, null);
  assert.ok(ctx.bot.sent.some((item) => item.type === 'media_group'));
  assert.ok(ctx.bot.sent.some((item) => item.type === 'edit_message_text'));
});

test('separate mode regenerates images in place without sending a new album', async () => {
  const ctx = createService();

  await ctx.service.handleTelegramUpdate({
    update_id: 130,
    message: { message_id: 130, text: '/work', chat: { id: 91 }, from: { id: 17 } },
  });
  await chooseWorkPhotoType(ctx, {
    chatId: 91,
    userId: 17,
    action: 'work_photo_type_normal',
    updateId: 1130,
    callbackId: 'cb-work-prompt-separate',
  });

  for (const [offset, fileId] of ['s1-large', 's2-large', 's3-large'].entries()) {
    await ctx.service.handleTelegramUpdate({
      update_id: 131 + offset,
      message: {
        message_id: 131 + offset,
        media_group_id: 'album-separate-refresh',
        chat: { id: 91 },
        from: { id: 17 },
        photo: [
          { file_id: `${fileId}-small`, file_unique_id: `us-small-${offset}`, width: 100, height: 100 },
          { file_id: fileId, file_unique_id: `us-${offset}`, width: 1000, height: 1000 },
        ],
      },
    });
  }

  await expireOnlyCollection(ctx);
  await ctx.service.runCollectionFinalizer();

  const runtimesAfterFinalize = await ctx.store.getRows(TABLE_NAMES.jobRuntimeCache);
  let runtimeBeforeMode = await ctx.repos.getRuntime(runtimesAfterFinalize[0].job_id);
  assert.equal(runtimeBeforeMode.runtime_status, 'awaiting_subject_type');
  runtimeBeforeMode = await chooseHairSubjectIfNeeded(ctx, {
    chatId: 91,
    userId: 17,
    updateId: 1131,
    callbackId: 'cb-work-subject-hair-separate',
  });
  const separateToken = await pickCallbackToken(ctx, 'render_mode_separate');
  await ctx.service.handleTelegramUpdate({
    update_id: 140,
    callback_query: {
      id: 'cb-work-separate-1',
      data: `render_mode_separate:${separateToken}`,
      from: { id: 17 },
      message: { message_id: runtimeBeforeMode.text_message_id, chat: { id: 91 } },
    },
  });

  await chooseRuntimeAction(ctx, {
    chatId: 91,
    userId: 17,
    action: 'background_mode_blur',
    updateId: 141,
    callbackId: 'cb-work-bg-separate',
  });
  await chooseRuntimeAction(ctx, {
    chatId: 91,
    userId: 17,
    action: 'cleanup_off',
    updateId: 142,
    callbackId: 'cb-work-cleanup-separate',
  });

  await waitFor(async () => {
    const runtime = await ctx.repos.getRuntime(runtimesAfterFinalize[0].job_id);
    assert.equal(runtime.runtime_status, 'preview_ready');
  });

  const runtimeBeforeRegenerate = await ctx.repos.getRuntime(runtimesAfterFinalize[0].job_id);
  const initialMediaGroupCount = ctx.bot.sent.filter((item) => item.type === 'media_group').length;
  const initialMediaEdits = ctx.bot.sent.filter((item) => item.type === 'edit_message_media').length;
  const regenerateToken = await pickCallbackToken(ctx, 'regenerate_images');

  await ctx.service.handleTelegramUpdate({
    update_id: 143,
    callback_query: {
      id: 'cb-work-separate-2',
      data: `regenerate_images:${regenerateToken}`,
      from: { id: 17 },
      message: { message_id: runtimeBeforeRegenerate.text_message_id, chat: { id: 91 } },
    },
  });

  await waitFor(async () => {
    const runtime = await ctx.repos.getRuntime(runtimesAfterFinalize[0].job_id);
    assert.equal(runtime.runtime_status, 'preview_ready');
    assert.equal(runtime.assets_message_ids.length, 3);
  });

  const runtimeAfterRegenerate = await ctx.repos.getRuntime(runtimesAfterFinalize[0].job_id);
  assert.deepEqual(runtimeAfterRegenerate.assets_message_ids, runtimeBeforeRegenerate.assets_message_ids);
  assert.equal(ctx.bot.sent.filter((item) => item.type === 'media_group').length, initialMediaGroupCount);
  assert.equal(ctx.bot.sent.filter((item) => item.type === 'edit_message_media').length, initialMediaEdits + 3);
});

test('regenerate text creates a new revision and version_prev opens the older one', async () => {
  const ctx = createService();

  await ctx.service.handleTelegramUpdate({
    update_id: 50,
    message: { message_id: 50, text: '/work', chat: { id: 61 }, from: { id: 9 } },
  });
  await chooseWorkPhotoType(ctx, {
    chatId: 61,
    userId: 9,
    action: 'work_photo_type_normal',
    updateId: 1050,
    callbackId: 'cb-work-prompt-r',
  });
  for (const [offset, fileId] of ['r1-large', 'r2-large'].entries()) {
    await ctx.service.handleTelegramUpdate({
      update_id: 51 + offset,
      message: {
        message_id: 51 + offset,
        media_group_id: 'album-r',
        chat: { id: 61 },
        from: { id: 9 },
        photo: [
          { file_id: `${fileId}-small`, file_unique_id: `r-small-${offset}`, width: 100, height: 100 },
          { file_id: fileId, file_unique_id: `r-${offset}`, width: 1000, height: 1000 },
        ],
      },
    });
  }

  await expireOnlyCollection(ctx);
  await ctx.service.runCollectionFinalizer();
  const modeToken = await pickCallbackToken(ctx, 'render_mode_separate');
  const runtimesAfterFinalize = await ctx.store.getRows(TABLE_NAMES.jobRuntimeCache);
  let runtimeBefore = await ctx.repos.getRuntime(runtimesAfterFinalize[0].job_id);
  assert.equal(runtimeBefore.runtime_status, 'awaiting_subject_type');
  runtimeBefore = await chooseHairSubjectIfNeeded(ctx, {
    chatId: 61,
    userId: 9,
    updateId: 1051,
    callbackId: 'cb-work-subject-hair-r',
  });
  const refreshedModeToken = await pickCallbackToken(ctx, 'render_mode_separate');
  await ctx.service.handleTelegramUpdate({
    update_id: 60,
    callback_query: {
      id: 'cb-work-r1',
      data: `render_mode_separate:${refreshedModeToken}`,
      from: { id: 9 },
      message: { message_id: runtimeBefore.text_message_id, chat: { id: 61 } },
    },
  });

  await chooseRuntimeAction(ctx, {
    chatId: 61,
    userId: 9,
    action: 'background_mode_blur',
    updateId: 64,
    callbackId: 'cb-work-bg-r',
  });
  await chooseRuntimeAction(ctx, {
    chatId: 61,
    userId: 9,
    action: 'cleanup_off',
    updateId: 65,
    callbackId: 'cb-work-cleanup-r',
  });

  await waitFor(async () => {
    const runtime = await ctx.repos.getRuntime(runtimesAfterFinalize[0].job_id);
    assert.equal(runtime.active_revision, 1);
  });

  const queueRows = await ctx.store.getRows(TABLE_NAMES.contentQueue);
  const jobId = queueRows[0].job_id;
  const regenerateToken = await pickCallbackToken(ctx, 'regenerate_text');
  assert.ok(regenerateToken);
  await ctx.service.handleTelegramUpdate({
    update_id: 61,
    callback_query: {
      id: 'cb-work-r2',
      data: `regenerate_text:${regenerateToken}`,
      from: { id: 9 },
      message: { message_id: 999, chat: { id: 61 } },
    },
  });

  await waitFor(async () => {
    const runtime = await ctx.repos.getRuntime(jobId);
    assert.equal(runtime.active_revision, 2);
  });

  let runtime = await ctx.repos.getRuntime(jobId);
  assert.equal(runtime.draft_payload.revisionHistory.length, 2);
  assert.equal(runtime.draft_payload.viewRevision, 2);

  const prevToken = await pickCallbackToken(ctx, 'version_prev');
  assert.ok(prevToken);
  await ctx.service.handleTelegramUpdate({
    update_id: 62,
    callback_query: {
      id: 'cb-work-r3',
      data: `version_prev:${prevToken}`,
      from: { id: 9 },
      message: { message_id: runtime.text_message_id, chat: { id: 61 } },
    },
  });

  runtime = await ctx.repos.getRuntime(jobId);
  assert.equal(runtime.draft_payload.viewRevision, 1);
  assert.equal(ctx.bot.sent.filter((item) => item.type === 'media_group').length, 1);
  assert.ok(ctx.bot.sent.some((item) => item.type === 'edit_message_text' && String(item.text ?? '').includes('Версия 1/2')));

  const callbackCountAfterPrev = (await ctx.store.getRows(TABLE_NAMES.callbackTokens)).length;
  const nextToken = await pickCallbackToken(ctx, 'version_next');
  assert.ok(nextToken);
  await ctx.service.handleTelegramUpdate({
    update_id: 63,
    callback_query: {
      id: 'cb-work-r4',
      data: `version_next:${nextToken}`,
      from: { id: 9 },
      message: { message_id: runtime.text_message_id, chat: { id: 61 } },
    },
  });

  runtime = await ctx.repos.getRuntime(jobId);
  assert.equal(runtime.draft_payload.viewRevision, 2);
  assert.equal((await ctx.store.getRows(TABLE_NAMES.callbackTokens)).length, callbackCountAfterPrev);
});

test('album grace stays open long enough for a late third photo, then shortens once all three arrive', async () => {
  const ctx = createService();
  const finalizeCalls = [];
  ctx.service.scheduleCollectionFinalize = async (collectionId) => {
    finalizeCalls.push(collectionId);
    return { ok: true, scheduled: true };
  };

  await ctx.service.handleTelegramUpdate({
    update_id: 70,
    message: { message_id: 70, text: '/work', chat: { id: 88 }, from: { id: 12 } },
  });
  await chooseWorkPhotoType(ctx, {
    chatId: 88,
    userId: 12,
    action: 'work_photo_type_normal',
    updateId: 1070,
    callbackId: 'cb-work-prompt-grace',
  });

  await ctx.service.handleTelegramUpdate({
    update_id: 71,
    message: {
      message_id: 71,
      media_group_id: 'album-grace',
      chat: { id: 88 },
      from: { id: 12 },
      photo: [
        { file_id: 'g1-small', file_unique_id: 'g1s', width: 100, height: 100 },
        { file_id: 'g1-large', file_unique_id: 'g1l', width: 1000, height: 1000 },
      ],
    },
  });

  let rows = await ctx.store.getRows(TABLE_NAMES.workCollections);
  let collection = await ctx.repos.getCollectionById(rows[0].collection_id);
  assert.equal(collection.count, 1);
  assert.ok(new Date(collection.deadline_at).getTime() - new Date(collection.last_message_at).getTime() >= 3_000);
  assert.equal(finalizeCalls.length, 0);

  await ctx.service.handleTelegramUpdate({
    update_id: 72,
    message: {
      message_id: 72,
      media_group_id: 'album-grace',
      chat: { id: 88 },
      from: { id: 12 },
      photo: [
        { file_id: 'g2-small', file_unique_id: 'g2s', width: 100, height: 100 },
        { file_id: 'g2-large', file_unique_id: 'g2l', width: 1000, height: 1000 },
      ],
    },
  });

  rows = await ctx.store.getRows(TABLE_NAMES.workCollections);
  collection = await ctx.repos.getCollectionById(rows[0].collection_id);
  assert.equal(collection.count, 2);
  assert.ok(new Date(collection.deadline_at).getTime() - new Date(collection.last_message_at).getTime() >= 5_000);
  assert.equal(finalizeCalls.length, 1);

  await ctx.service.handleTelegramUpdate({
    update_id: 73,
    message: {
      message_id: 73,
      media_group_id: 'album-grace',
      chat: { id: 88 },
      from: { id: 12 },
      photo: [
        { file_id: 'g3-small', file_unique_id: 'g3s', width: 100, height: 100 },
        { file_id: 'g3-large', file_unique_id: 'g3l', width: 1000, height: 1000 },
      ],
    },
  });

  rows = await ctx.store.getRows(TABLE_NAMES.workCollections);
  collection = await ctx.repos.getCollectionById(rows[0].collection_id);
  assert.equal(collection.count, 3);
  assert.ok(new Date(collection.deadline_at).getTime() - new Date(collection.last_message_at).getTime() <= 5_000);
  assert.equal(finalizeCalls.length, 2);
});

test('handlePhoto dispatches collection finalize to worker and skips inline finalize when base url exists', async () => {
  const ctx = createService({
    envOverrides: { webhookBaseUrl: 'https://bot.example.com', internalWorkerDispatchEnabled: true },
  });
  const dispatchCalls = [];
  ctx.service.dispatchCollectionFinalizeAsync = (collectionId, meta) => {
    dispatchCalls.push({ collectionId, meta });
    return true;
  };
  ctx.service.scheduleCollectionFinalize = async () => {
    throw new Error('inline finalize should not run when worker dispatch succeeds');
  };

  await ctx.service.handleTelegramUpdate({
    update_id: 170,
    message: { message_id: 170, text: '/work', chat: { id: 188 }, from: { id: 12 } },
  });
  await chooseWorkPhotoType(ctx, {
    chatId: 188,
    userId: 12,
    action: 'work_photo_type_normal',
    updateId: 1170,
    callbackId: 'cb-work-prompt-dispatch',
  });

  for (const [offset, fileId] of ['dispatch-large-1', 'dispatch-large-2'].entries()) {
    await ctx.service.handleTelegramUpdate({
      update_id: 171 + offset,
      message: {
        message_id: 171 + offset,
        media_group_id: 'album-dispatch',
        chat: { id: 188 },
        from: { id: 12 },
        photo: [
          { file_id: `${fileId}-small`, file_unique_id: `dispatch-small-${offset}`, width: 100, height: 100 },
          { file_id: fileId, file_unique_id: `dispatch-${offset}`, width: 1000, height: 1000 },
        ],
      },
    });
  }

  assert.equal(dispatchCalls.length, 1);
  assert.equal(dispatchCalls[0].meta.count, 2);
});

test('handlePhoto falls back to inline finalize when worker dispatch is unavailable', async () => {
  const ctx = createService();
  const finalizeCalls = [];
  ctx.service.dispatchCollectionFinalizeAsync = () => false;
  ctx.service.scheduleCollectionFinalize = async (collectionId) => {
    finalizeCalls.push(collectionId);
    return { ok: true, scheduled: true };
  };

  await ctx.service.handleTelegramUpdate({
    update_id: 180,
    message: { message_id: 180, text: '/work', chat: { id: 199 }, from: { id: 12 } },
  });
  await chooseWorkPhotoType(ctx, {
    chatId: 199,
    userId: 12,
    action: 'work_photo_type_normal',
    updateId: 1180,
    callbackId: 'cb-work-prompt-inline',
  });

  for (const [offset, fileId] of ['inline-large-1', 'inline-large-2'].entries()) {
    await ctx.service.handleTelegramUpdate({
      update_id: 181 + offset,
      message: {
        message_id: 181 + offset,
        media_group_id: 'album-inline',
        chat: { id: 199 },
        from: { id: 12 },
        photo: [
          { file_id: `${fileId}-small`, file_unique_id: `inline-small-${offset}`, width: 100, height: 100 },
          { file_id: fileId, file_unique_id: `inline-${offset}`, width: 1000, height: 1000 },
        ],
      },
    });
  }

  assert.equal(finalizeCalls.length, 1);
});

test('dispatchCollectionFinalizeAsync skips self worker dispatch on protected vercel host', async () => {
  const ctx = createService({
    envOverrides: {
      webhookBaseUrl: 'https://smm-automation-bot-qro74qq9t-amoorkie-gmailcoms-projects.vercel.app',
      webhookBaseUrlDerivedFromDeploymentUrl: true,
      internalWorkerDispatchEnabled: true,
    },
  });
  const originalFetch = global.fetch;
  global.fetch = async () => {
    throw new Error('self worker dispatch should not hit fetch on protected vercel host');
  };

  try {
    const dispatched = await ctx.service.dispatchCollectionFinalizeAsync('COL-VERCEL', {
      chatId: 208,
      userId: 12,
      collectionIdForLog: 'COL-VERCEL',
      mediaGroupId: 'album-vercel-inline',
      count: 2,
    });
    assert.equal(dispatched, false);
  } finally {
    global.fetch = originalFetch;
  }
});

test('late third photo reopens an awaiting_render_mode album and keeps all three assets', async () => {
  const ctx = createService();

  await ctx.service.handleTelegramUpdate({
    update_id: 80,
    message: { message_id: 80, text: '/work', chat: { id: 95 }, from: { id: 14 } },
  });
  await chooseWorkPhotoType(ctx, {
    chatId: 95,
    userId: 14,
    action: 'work_photo_type_normal',
    updateId: 1080,
    callbackId: 'cb-work-prompt-late',
  });

  for (const [offset, fileId] of ['l1-large', 'l2-large'].entries()) {
    await ctx.service.handleTelegramUpdate({
      update_id: 81 + offset,
      message: {
        message_id: 81 + offset,
        media_group_id: 'album-late',
        chat: { id: 95 },
        from: { id: 14 },
        photo: [
          { file_id: `${fileId}-small`, file_unique_id: `late-small-${offset}`, width: 100, height: 100 },
          { file_id: fileId, file_unique_id: `late-${offset}`, width: 1000, height: 1000 },
        ],
      },
    });
  }

  await expireOnlyCollection(ctx);
  await ctx.service.runCollectionFinalizer();

  const rows = await ctx.store.getRows(TABLE_NAMES.jobRuntimeCache);
  let runtime = await ctx.repos.getRuntime(rows[0].job_id);
  assert.equal(runtime.runtime_status, 'awaiting_subject_type');
  runtime = await chooseHairSubjectIfNeeded(ctx, {
    chatId: 95,
    userId: 14,
    updateId: 1081,
    callbackId: 'cb-work-subject-hair-late',
  });
  assert.equal(runtime.runtime_status, 'awaiting_render_mode');

  await ctx.service.handleTelegramUpdate({
    update_id: 83,
    message: {
      message_id: 83,
      media_group_id: 'album-late',
      chat: { id: 95 },
      from: { id: 14 },
      photo: [
        { file_id: 'l3-small', file_unique_id: 'late-small-2', width: 100, height: 100 },
        { file_id: 'l3-large', file_unique_id: 'late-2', width: 1000, height: 1000 },
      ],
    },
  });

  let collection = await ctx.repos.getCollectionById(runtime.collection_id);
  assert.equal(collection.status, 'collecting');
  assert.equal(collection.count, 3);

  runtime = await ctx.repos.getRuntime(rows[0].job_id);
  assert.equal(runtime.runtime_status, 'collecting');
  assert.equal(runtime.active_callback_set_id, '');

  await expireOnlyCollection(ctx);
  await ctx.service.runCollectionFinalizer();

  runtime = await ctx.repos.getRuntime(rows[0].job_id);
  if (runtime.runtime_status === 'awaiting_subject_type') {
    runtime = await chooseHairSubjectIfNeeded(ctx, {
      chatId: 95,
      userId: 14,
      updateId: 1082,
      callbackId: 'cb-work-subject-hair-late-reopen',
    });
  }
  const separateToken = await pickCallbackToken(ctx, 'render_mode_separate');
  runtime = await ctx.repos.getRuntime(rows[0].job_id);
  await ctx.service.handleTelegramUpdate({
    update_id: 84,
    callback_query: {
      id: 'cb-work-late',
      data: `render_mode_separate:${separateToken}`,
      from: { id: 14 },
      message: { message_id: runtime.text_message_id, chat: { id: 95 } },
    },
  });

  await chooseRuntimeAction(ctx, {
    chatId: 95,
    userId: 14,
    action: 'background_mode_blur',
    updateId: 85,
    callbackId: 'cb-work-bg-late',
  });
  await chooseRuntimeAction(ctx, {
    chatId: 95,
    userId: 14,
    action: 'cleanup_off',
    updateId: 86,
    callbackId: 'cb-work-cleanup-late',
  });

  await waitFor(async () => {
    const finalRuntime = await ctx.repos.getRuntime(rows[0].job_id);
    assert.equal(finalRuntime.runtime_status, 'preview_ready');
    assert.deepEqual(finalRuntime.draft_payload.originalTelegramFileIds, ['l1-large', 'l2-large', 'l3-large']);
  });
});

test('single-photo work flow skips render mode and asks background directly', async () => {
  const ctx = createService();

  await ctx.service.handleTelegramUpdate({
    update_id: 1900,
    message: { message_id: 1900, text: '/work', chat: { id: 501 }, from: { id: 41 } },
  });
  await chooseWorkPhotoType(ctx, {
    chatId: 501,
    userId: 41,
    action: 'work_photo_type_normal',
    updateId: 1901,
    callbackId: 'cb-work-prompt-single',
  });
  await ctx.service.handleTelegramUpdate({
    update_id: 1902,
    message: {
      message_id: 1902,
      chat: { id: 501 },
      from: { id: 41 },
      photo: [
        { file_id: 'single-small', file_unique_id: 'single-small-u', width: 100, height: 100 },
        { file_id: 'single-large', file_unique_id: 'single-large-u', width: 1000, height: 1000 },
      ],
    },
  });

  await expireOnlyCollection(ctx);
  await ctx.service.runCollectionFinalizer();

  const runtimes = await ctx.store.getRows(TABLE_NAMES.jobRuntimeCache);
  let runtime = await ctx.repos.getRuntime(runtimes[0].job_id);
  assert.equal(runtime.runtime_status, 'awaiting_subject_type');
  runtime = await chooseHairSubjectIfNeeded(ctx, {
    chatId: 501,
    userId: 41,
    updateId: 1903,
    callbackId: 'cb-work-subject-hair-single',
  });
  assert.equal(runtime.runtime_status, 'awaiting_background_mode');
  assert.equal(runtime.draft_payload.renderMode, 'separate');
  assert.equal(runtime.draft_payload.promptMode, 'normal');
  assert.equal(await pickCallbackToken(ctx, 'render_mode_collage'), null);
});

test('/work starts with photo type choice and opens awaiting_assets only after selection', async () => {
  const ctx = createService();

  await ctx.service.handleTelegramUpdate({
    update_id: 1905,
    message: { message_id: 1905, text: '/work', chat: { id: 601 }, from: { id: 51 } },
  });

  let session = await ctx.repos.getSessionByChatAndMode(601, 'work');
  assert.equal(session?.state, 'awaiting_photo_type');
  assert.ok(await pickCallbackToken(ctx, 'work_photo_type_normal'));
  assert.ok(await pickCallbackToken(ctx, 'work_photo_type_studio'));
  assert.equal(await pickCallbackToken(ctx, 'work_subject_hair'), null);
  assert.equal(await pickCallbackToken(ctx, 'work_subject_brows'), null);
  assert.ok(allSentTexts(ctx.bot).some((text) => text.includes(USER_MESSAGES.workPhotoTypeChoice)));

  await chooseWorkPhotoType(ctx, {
    chatId: 601,
    userId: 51,
    updateId: 1906,
    callbackId: 'cb-work-photo-type-regular',
  });

  session = await ctx.repos.getSessionByChatAndMode(601, 'work');
  assert.equal(session?.state, 'awaiting_assets');
  assert.ok(allSentTexts(ctx.bot).includes(USER_MESSAGES.workPhotoRequest));
});

test('subject choice keeps preselected test prompt mode on the runtime payload', async () => {
  const ctx = createService();

  await ctx.service.handleTelegramUpdate({
    update_id: 1871,
    message: { message_id: 1871, text: '/work', chat: { id: 611 }, from: { id: 61 } },
  });
  await chooseWorkPhotoType(ctx, {
    chatId: 611,
    userId: 61,
    action: 'work_photo_type_normal',
    updateId: 1872,
    callbackId: 'cb-work-photo-type-test-mode',
  });
  await ctx.service.handleTelegramUpdate({
    update_id: 1873,
    message: {
      message_id: 1873,
      chat: { id: 611 },
      from: { id: 61 },
      photo: [
        { file_id: 'test-mode-photo-small', file_unique_id: 'test-mode-photo-small-u', width: 100, height: 100 },
        { file_id: 'test-mode-photo-large', file_unique_id: 'test-mode-photo-large-u', width: 1000, height: 1000 },
      ],
    },
  });

  await expireOnlyCollection(ctx);
  await ctx.service.runCollectionFinalizer();

  const runtimeRow = (await ctx.store.getRows(TABLE_NAMES.jobRuntimeCache))[0];
  await ctx.repos.upsertRuntime({
    ...runtimeRow,
    preview_payload_json: JSON.stringify({
      ...JSON.parse(runtimeRow.preview_payload_json),
      promptMode: 'test',
    }),
    draft_payload_json: JSON.stringify({
      ...JSON.parse(runtimeRow.draft_payload_json),
      promptMode: 'test',
    }),
  });

  await chooseHairSubjectIfNeeded(ctx, {
    chatId: 611,
    userId: 61,
    updateId: 1874,
    callbackId: 'cb-work-subject-hair-test-mode',
  });

  const runtime = await ctx.repos.getRuntime(runtimeRow.job_id);
  assert.equal(runtime.draft_payload.promptMode, 'test');
});

test('single-photo studio flow skips background choice and starts generation right after subject selection', async () => {
  const ctx = createService();

  await ctx.service.handleTelegramUpdate({
    update_id: 1907,
    message: { message_id: 1907, text: '/work', chat: { id: 602 }, from: { id: 52 } },
  });
  await chooseWorkPhotoType(ctx, {
    chatId: 602,
    userId: 52,
    action: 'work_photo_type_studio',
    updateId: 1908,
    callbackId: 'cb-work-photo-type-studio',
  });
  await ctx.service.handleTelegramUpdate({
    update_id: 1909,
    message: {
      message_id: 1909,
      chat: { id: 602 },
      from: { id: 52 },
      photo: [
        { file_id: 'studio-single-small', file_unique_id: 'studio-single-small-u', width: 100, height: 100 },
        { file_id: 'studio-single-large', file_unique_id: 'studio-single-large-u', width: 1000, height: 1000 },
      ],
    },
  });

  await expireOnlyCollection(ctx);
  await ctx.service.runCollectionFinalizer();

  const runtimes = await ctx.store.getRows(TABLE_NAMES.jobRuntimeCache);
  let runtime = await ctx.repos.getRuntime(runtimes[0].job_id);
  assert.equal(runtime.runtime_status, 'awaiting_subject_type');
  runtime = await chooseHairSubjectIfNeeded(ctx, {
    chatId: 602,
    userId: 52,
    updateId: 1910,
    callbackId: 'cb-work-subject-hair-studio',
  });

  await waitFor(async () => {
    const freshRuntime = await ctx.repos.getRuntime(runtime.job_id);
    assert.equal(freshRuntime.runtime_status, 'preview_ready');
  });

  const finalRuntime = await ctx.repos.getRuntime(runtime.job_id);
  assert.equal(finalRuntime.draft_payload.photoType, 'studio');
  assert.equal(finalRuntime.draft_payload.backgroundMode, 'neutral');
  assert.equal(finalRuntime.draft_payload.cleanupMode, 'off');
  assert.equal(await pickCallbackToken(ctx, 'background_mode_neutral'), null);
  assert.ok(ctx.openrouter.imageCalls.some((call) => call.metadata?.pass === 'edit_neutral'));

  const sentTexts = allSentTexts(ctx.bot);
  assert.ok(sentTexts.includes(USER_MESSAGES.generationQueued.separate));
  assert.ok(!sentTexts.some((text) => text.includes(USER_MESSAGES.workBackgroundChoice)));
});

test('single-photo brow flow asks brow output before background', async () => {
  const ctx = createService();

  await ctx.service.handleTelegramUpdate({
    update_id: 1906,
    message: { message_id: 1906, text: '/work', chat: { id: 602 }, from: { id: 52 } },
  });
  await chooseWorkPhotoType(ctx, {
    chatId: 602,
    userId: 52,
    updateId: 1907,
    callbackId: 'cb-work-photo-type-brow-single',
  });
  await ctx.service.handleTelegramUpdate({
    update_id: 1908,
    message: {
      message_id: 1908,
      chat: { id: 602 },
      from: { id: 52 },
      photo: [
        { file_id: 'brow-single-small', file_unique_id: 'brow-single-small-u', width: 100, height: 100 },
        { file_id: 'brow-single-large', file_unique_id: 'brow-single-large-u', width: 1000, height: 1000 },
      ],
    },
  });

  await expireOnlyCollection(ctx);
  await ctx.service.runCollectionFinalizer();

  const runtimes = await ctx.store.getRows(TABLE_NAMES.jobRuntimeCache);
  let runtime = await ctx.repos.getRuntime(runtimes[0].job_id);
  assert.equal(runtime.runtime_status, 'awaiting_subject_type');
  runtime = await chooseRuntimeAction(ctx, {
    chatId: 602,
    userId: 52,
    action: 'work_subject_brows',
    updateId: 1909,
    callbackId: 'cb-work-subject-brows-single',
  });
  assert.equal(runtime.runtime_status, 'awaiting_brow_output_mode');
  assert.equal(runtime.draft_payload.subjectType, 'brows');
  assert.ok(await pickCallbackToken(ctx, 'brow_output_after_only'));

  runtime = await chooseRuntimeAction(ctx, {
    chatId: 602,
    userId: 52,
    action: 'brow_output_after_only',
    updateId: 1910,
    callbackId: 'cb-brow-output-after',
  });
  assert.equal(runtime.runtime_status, 'awaiting_background_mode');
});

test('studio photo type skips background choice for single hair work and goes through neutral pipeline', async () => {
  const ctx = createService();

  await ctx.service.handleTelegramUpdate({
    update_id: 1920,
    message: { message_id: 1920, text: '/work', chat: { id: 604 }, from: { id: 54 } },
  });
  await chooseWorkPhotoType(ctx, {
    chatId: 604,
    userId: 54,
    action: 'work_photo_type_studio',
    updateId: 1921,
    callbackId: 'cb-work-photo-type-studio-hair',
  });
  await ctx.service.handleTelegramUpdate({
    update_id: 1922,
    message: {
      message_id: 1922,
      chat: { id: 604 },
      from: { id: 54 },
      photo: [
        { file_id: 'studio-hair-small', file_unique_id: 'studio-hair-small-u', width: 100, height: 100 },
        { file_id: 'studio-hair-large', file_unique_id: 'studio-hair-large-u', width: 1000, height: 1000 },
      ],
    },
  });

  await expireOnlyCollection(ctx);
  await ctx.service.runCollectionFinalizer();

  const runtimes = await ctx.store.getRows(TABLE_NAMES.jobRuntimeCache);
  let runtime = await ctx.repos.getRuntime(runtimes[0].job_id);
  assert.equal(runtime.runtime_status, 'awaiting_subject_type');
  runtime = await chooseHairSubjectIfNeeded(ctx, {
    chatId: 604,
    userId: 54,
    updateId: 1923,
    callbackId: 'cb-work-subject-studio-hair',
  });
  assert.equal(runtime.draft_payload.photoType, 'studio');
  assert.equal(runtime.draft_payload.backgroundMode, 'neutral');
  assert.equal(await pickCallbackToken(ctx, 'background_mode_neutral'), null);

  await waitFor(async () => {
    const freshRuntime = await ctx.repos.getRuntime(runtime.job_id);
    assert.equal(freshRuntime.runtime_status, 'preview_ready');
  });

  assert.ok(ctx.openrouter.imageCalls.some((call) => call.metadata?.pass === 'edit_neutral'));
});

test('studio photo type skips background choice after brow output and uses neutral brow pipeline', async () => {
  const ctx = createService();

  await ctx.service.handleTelegramUpdate({
    update_id: 1924,
    message: { message_id: 1924, text: '/work', chat: { id: 605 }, from: { id: 55 } },
  });
  await chooseWorkPhotoType(ctx, {
    chatId: 605,
    userId: 55,
    action: 'work_photo_type_studio',
    updateId: 1925,
    callbackId: 'cb-work-photo-type-studio-brow',
  });
  await ctx.service.handleTelegramUpdate({
    update_id: 1926,
    message: {
      message_id: 1926,
      chat: { id: 605 },
      from: { id: 55 },
      photo: [
        { file_id: 'studio-brow-small', file_unique_id: 'studio-brow-small-u', width: 100, height: 100 },
        { file_id: 'studio-brow-large', file_unique_id: 'studio-brow-large-u', width: 1000, height: 1000 },
      ],
    },
  });

  await expireOnlyCollection(ctx);
  await ctx.service.runCollectionFinalizer();

  const runtimes = await ctx.store.getRows(TABLE_NAMES.jobRuntimeCache);
  let runtime = await ctx.repos.getRuntime(runtimes[0].job_id);
  assert.equal(runtime.runtime_status, 'awaiting_subject_type');
  runtime = await chooseRuntimeAction(ctx, {
    chatId: 605,
    userId: 55,
    action: 'work_subject_brows',
    updateId: 1927,
    callbackId: 'cb-work-subject-studio-brow',
  });
  assert.equal(runtime.runtime_status, 'awaiting_brow_output_mode');
  runtime = await chooseRuntimeAction(ctx, {
    chatId: 605,
    userId: 55,
    action: 'brow_output_after_only',
    updateId: 1928,
    callbackId: 'cb-work-brow-output-studio',
  });
  assert.equal(runtime.draft_payload.photoType, 'studio');
  assert.equal(runtime.draft_payload.backgroundMode, 'neutral');
  assert.equal(await pickCallbackToken(ctx, 'background_mode_neutral'), null);

  await waitFor(async () => {
    const freshRuntime = await ctx.repos.getRuntime(runtime.job_id);
    assert.equal(freshRuntime.runtime_status, 'preview_ready');
  });

  assert.ok(ctx.openrouter.imageCalls.some((call) => call.metadata?.pass === 'brow_edit_neutral'));
});

test('multi-photo brow flow asks render mode then brow output then background', async () => {
  const ctx = createService();

  await ctx.service.handleTelegramUpdate({
    update_id: 1911,
    message: { message_id: 1911, text: '/work', chat: { id: 603 }, from: { id: 53 } },
  });
  await chooseWorkPhotoType(ctx, {
    chatId: 603,
    userId: 53,
    updateId: 1912,
    callbackId: 'cb-work-photo-type-brow-multi',
  });
  await Promise.all([
    ctx.service.handleTelegramUpdate({
      update_id: 1913,
      message: {
        message_id: 1913,
        media_group_id: 'album-brow-flow',
        chat: { id: 603 },
        from: { id: 53 },
        photo: [
          { file_id: 'brow-a-small', file_unique_id: 'brow-a-small-u', width: 100, height: 100 },
          { file_id: 'brow-a-large', file_unique_id: 'brow-a-large-u', width: 1000, height: 1000 },
        ],
      },
    }),
    ctx.service.handleTelegramUpdate({
      update_id: 1914,
      message: {
        message_id: 1914,
        media_group_id: 'album-brow-flow',
        chat: { id: 603 },
        from: { id: 53 },
        photo: [
          { file_id: 'brow-b-small', file_unique_id: 'brow-b-small-u', width: 100, height: 100 },
          { file_id: 'brow-b-large', file_unique_id: 'brow-b-large-u', width: 1000, height: 1000 },
        ],
      },
    }),
  ]);

  await expireOnlyCollection(ctx);
  await ctx.service.runCollectionFinalizer();

  let runtime = await ctx.repos.getRuntime((await ctx.store.getRows(TABLE_NAMES.jobRuntimeCache))[0].job_id);
  assert.equal(runtime.runtime_status, 'awaiting_subject_type');
  runtime = await chooseRuntimeAction(ctx, {
    chatId: 603,
    userId: 53,
    action: 'work_subject_brows',
    updateId: 1915,
    callbackId: 'cb-work-subject-brows-multi',
  });
  assert.equal(runtime.runtime_status, 'awaiting_render_mode');
  assert.ok(await pickCallbackToken(ctx, 'render_mode_collage'));
  assert.ok(await pickCallbackToken(ctx, 'render_mode_separate'));
  runtime = await chooseRuntimeAction(ctx, {
    chatId: 603,
    userId: 53,
    action: 'render_mode_collage',
    updateId: 1916,
    callbackId: 'cb-brow-render-mode-collage',
  });
  assert.equal(runtime.runtime_status, 'awaiting_brow_output_mode');
  assert.ok(await pickCallbackToken(ctx, 'brow_output_before_after'));
  assert.ok(await pickCallbackToken(ctx, 'brow_output_after_only'));

  runtime = await chooseRuntimeAction(ctx, {
    chatId: 603,
    userId: 53,
    action: 'brow_output_before_after',
    updateId: 1917,
    callbackId: 'cb-brow-output-before-after',
  });
  assert.equal(runtime.runtime_status, 'awaiting_background_mode');
});

test('repeated /work refreshes the photo request session instead of hanging on stale wizard state', async () => {
  const ctx = createService();

  await ctx.service.handleTelegramUpdate({
    update_id: 1910,
    message: { message_id: 1910, text: '/work', chat: { id: 502 }, from: { id: 42 } },
  });
  await ctx.service.handleTelegramUpdate({
    update_id: 1911,
    message: { message_id: 1911, text: '/work', chat: { id: 502 }, from: { id: 42 } },
  });

  const session = await ctx.repos.getSessionByChatAndMode(502, 'work');
  const payload = JSON.parse(session?.pending_payload_json ?? '{}');
  assert.equal(session?.state, 'awaiting_photo_type');
  assert.equal(payload.textMessageId, 101);
  assert.equal(ctx.bot.sent.filter((entry) => entry.type === 'message' && String(entry.text ?? '').includes(USER_MESSAGES.workPhotoTypeChoice)).length, 2);
});

test('upsertControlMessage falls back to a new control message when stored message id can no longer be edited', async () => {
  const ctx = createService();
  await ctx.bot.api.sendMessage(503, 'старое сообщение');
  const originalEditMessageText = ctx.bot.api.editMessageText;
  ctx.bot.api.editMessageText = async (chatId, messageId, text, extra = {}) => {
    if (messageId === 100 && text === USER_MESSAGES.workPhotoRequest) {
      throw new Error("Call to 'editMessageText' failed! (400: Bad Request: message to edit not found)");
    }
    return originalEditMessageText(chatId, messageId, text, extra);
  };

  const messageId = await ctx.service.upsertControlMessage(503, USER_MESSAGES.workPhotoRequest, {
    existingMessageId: 100,
    replyMarkup: { inline_keyboard: [] },
  });

  assert.equal(messageId, 101);
  assert.equal(ctx.bot.sent.filter((entry) => entry.type === 'message' && entry.text === USER_MESSAGES.workPhotoRequest).length, 1);
});

test('mergeAlbumCollection deduplicates duplicate rows and preserves all album assets', async () => {
  const store = new FakeStore({
    [TABLE_NAMES.workCollections]: [
      {
        collection_id: 'COL-ALBUM',
        collection_key: 'group:42:album-1',
        chat_id: '42',
        user_id: '7',
        first_message_id: '2',
        media_group_id: 'album-1',
        status: 'collecting',
        asset_refs_json: JSON.stringify([{ fileId: 'p1-large', uniqueFileId: 'u1', messageId: 2 }]),
        count: '1',
        deadline_at: '2026-03-20T07:03:08.000Z',
        last_message_at: '2026-03-20T07:03:05.000Z',
        closed_by_job_id: '',
        created_at: '2026-03-20T07:03:05.000Z',
        updated_at: '2026-03-20T07:03:05.000Z',
      },
      {
        collection_id: 'COL-ALBUM',
        collection_key: 'group:42:album-1',
        chat_id: '42',
        user_id: '7',
        first_message_id: '2',
        media_group_id: 'album-1',
        status: 'collecting',
        asset_refs_json: JSON.stringify([{ fileId: 'p2-large', uniqueFileId: 'u2', messageId: 3 }]),
        count: '1',
        deadline_at: '2026-03-20T07:03:09.000Z',
        last_message_at: '2026-03-20T07:03:06.000Z',
        closed_by_job_id: '',
        created_at: '2026-03-20T07:03:05.000Z',
        updated_at: '2026-03-20T07:03:06.000Z',
      },
    ],
  });
  const repos = createRepositories(store);

  const collection = await repos.getCollectionById('COL-ALBUM');
  assert.equal(collection.count, 2);
  assert.deepEqual(collection.assets.map((asset) => asset.fileId), ['p1-large', 'p2-large']);
});

test('duplicate telegram update exits cheaply after atomic idempotency claim', async () => {
  const ctx = createService();
  let claims = 0;
  ctx.repos.recordIdempotency = async () => {
    claims += 1;
    return { idemKey: 'IDEM-1', inserted: claims === 1 };
  };

  const update = {
    update_id: 9901,
    message: { message_id: 1, text: '/help', chat: { id: 42 }, from: { id: 7 } },
  };

  const first = await ctx.service.handleTelegramUpdate(update);
  const second = await ctx.service.handleTelegramUpdate(update);

  assert.equal(first.ok, true);
  assert.equal(second.duplicate, true);
  assert.equal(ctx.bot.sent.filter((item) => item.type === 'message').length, 1);
});

test('queueRuntimeGeneration dispatches worker action and skips inline generation when worker dispatch succeeds', async () => {
  const ctx = createService({
    envOverrides: { webhookBaseUrl: 'https://bot.example.com', internalWorkerDispatchEnabled: true },
  });
  const originalFetch = global.fetch;
  const fetchCalls = [];
  global.fetch = async (url, options) => {
    fetchCalls.push({ url, options });
    return {
      ok: true,
      async text() { return ''; },
    };
  };

  ctx.service.updateRuntimeStatusMessage = async () => 77;
  ctx.service.runQueuedGenerationJob = async () => {
    throw new Error('inline generation should not run when dispatch succeeds');
  };

  try {
    const result = await ctx.service.queueRuntimeGeneration({
      job_id: 'JOB-DISPATCH',
      job_type: 'work',
      chat_id: 51,
      user_id: 9,
      collection_id: 'COL-DISPATCH',
      active_revision: 1,
      collage_message_id: '',
      assets_message_ids: [],
      text_message_id: '11',
      active_callback_set_id: '',
      lock_flags: {},
      draft_payload: { queueId: 'QUE-DISPATCH', renderMode: 'separate', sourceAssetCount: 1 },
      preview_payload: { queueId: 'QUE-DISPATCH', renderMode: 'separate', sourceAssetCount: 1 },
    }, { action: 'regenerate_text' });

    assert.equal(result.dispatched, true);
    assert.equal(result.inline, false);
    assert.equal(fetchCalls.length, 1);
    assert.equal(String(fetchCalls[0].url), 'https://bot.example.com/api/worker/runtime-action');
    assert.equal(fetchCalls[0].options?.method, 'POST');
    assert.ok(fetchCalls[0].options?.headers?.['x-anita-worker-token']);
  } finally {
    global.fetch = originalFetch;
  }
});

test('queueRuntimeGeneration skips worker self-dispatch on protected vercel host and runs inline', async () => {
  const ctx = createService({
    envOverrides: {
      webhookBaseUrl: 'https://smm-automation-bot-qro74qq9t-amoorkie-gmailcoms-projects.vercel.app',
      webhookBaseUrlDerivedFromDeploymentUrl: true,
      internalWorkerDispatchEnabled: true,
    },
  });
  const originalFetch = global.fetch;
  global.fetch = async () => {
    throw new Error('worker self-dispatch should not call fetch on protected vercel host');
  };
  ctx.service.updateRuntimeStatusMessage = async () => 77;
  const inlineCalls = [];
  ctx.service.runQueuedGenerationJob = async (jobId, action) => {
    inlineCalls.push({ jobId, action });
    return { ok: true, inline: true };
  };

  try {
    const result = await ctx.service.queueRuntimeGeneration({
      job_id: 'JOB-VERCEL',
      job_type: 'work',
      chat_id: 51,
      user_id: 9,
      collection_id: 'COL-VERCEL',
      active_revision: 1,
      collage_message_id: '',
      assets_message_ids: [],
      text_message_id: '11',
      active_callback_set_id: '',
      lock_flags: {},
      draft_payload: { queueId: 'QUE-VERCEL', renderMode: 'separate', sourceAssetCount: 1 },
      preview_payload: { queueId: 'QUE-VERCEL', renderMode: 'separate', sourceAssetCount: 1 },
    }, { action: 'regenerate_text' });

    assert.equal(result.inline, true);
    assert.equal(inlineCalls.length, 1);
  } finally {
    global.fetch = originalFetch;
  }
});

test('queueRuntimeGeneration skips worker dispatch when only protected deployment url is available', async () => {
  const ctx = createService({
    envOverrides: {
      webhookBaseUrl: 'https://smm-automation-bot-qro74qq9t-amoorkie-gmailcoms-projects.vercel.app',
      webhookBaseUrlDerivedFromDeploymentUrl: true,
      internalWorkerDispatchEnabled: true,
    },
  });
  const originalFetch = global.fetch;
  const fetchCalls = [];
  global.fetch = async (url, options) => {
    fetchCalls.push({ url, options });
    return {
      ok: true,
      async text() { return ''; },
    };
  };

  const inlineCalls = [];
  ctx.service.updateRuntimeStatusMessage = async () => 77;
  ctx.service.runQueuedGenerationJob = async (jobId, options) => {
    inlineCalls.push({ jobId, options });
    return { ok: true, jobId };
  };

  try {
    const result = await ctx.service.queueRuntimeGeneration({
      job_id: 'JOB-PROTECTED',
      job_type: 'work',
      chat_id: 51,
      user_id: 9,
      collection_id: 'COL-PROTECTED',
      active_revision: 1,
      collage_message_id: '',
      assets_message_ids: [],
      text_message_id: '11',
      active_callback_set_id: '',
      lock_flags: {},
      draft_payload: { queueId: 'QUE-PROTECTED', renderMode: 'separate', sourceAssetCount: 1 },
      preview_payload: { queueId: 'QUE-PROTECTED', renderMode: 'separate', sourceAssetCount: 1 },
    }, { action: 'regenerate_text' });

    assert.equal(result.dispatched, false);
    assert.equal(result.inline, true);
    assert.equal(fetchCalls.length, 0);
    assert.equal(inlineCalls.length, 1);
  } finally {
    global.fetch = originalFetch;
  }
});

test('topic picker opens first and selected topic creates preview with revision controls', async () => {
  const ctx = createService({
    initialTables: {
      [TABLE_NAMES.expertTopics]: [{
        topic_id: 'TOP-1',
        title: 'Уход за кудрями',
        brief: 'Дай 3 практических совета',
        tags: 'curl,care',
        priority: '1',
        status: 'ready',
        reserved_by: '',
        reserved_at: '',
        reservation_expires_at: '',
        last_job_id: '',
        last_published_at: '',
        notes: '',
      }],
    },
  });

  await ctx.service.handleTelegramUpdate({
    update_id: 80,
    message: { message_id: 80, text: '/topic', chat: { id: 50 }, from: { id: 8 } },
  });

  const pickerMessage = ctx.bot.sent.find((item) => item.type === 'message' && String(item.text ?? '').includes('Доступно тем'));
  assert.ok(pickerMessage);
  const pickToken = await pickCallbackTokenByPrefix(ctx, 'pick_source_');
  assert.ok(pickToken);

  await ctx.service.handleTelegramUpdate({
    update_id: 81,
    callback_query: {
      id: 'cb-topic-pick',
      data: `pick_source_0_0:${pickToken}`,
      from: { id: 8 },
      message: { message_id: pickerMessage.message_id, chat: { id: 50 } },
    },
  });

  const sentTexts = allSentTexts(ctx.bot);
  assert.ok(sentTexts.includes(USER_MESSAGES.topicTaken));
  assert.ok(sentTexts.includes(USER_MESSAGES.topicGeneratingText));
  assert.ok(sentTexts.includes(USER_MESSAGES.topicGeneratingImages));
  assert.ok(sentTexts.includes(USER_MESSAGES.assemblingPreview));

  const queueRows = await ctx.store.getRows(TABLE_NAMES.contentQueue);
  assert.equal(queueRows.length, 1);
  assert.equal(queueRows[0].job_type, 'topic');
  assert.match(queueRows[0].caption_text, /\+7 \(987\) 741-83-99/);
  assert.equal((await ctx.store.getRows(TABLE_NAMES.expertTopics))[0].status, 'reserved');

  const callbackRows = await ctx.store.getRows(TABLE_NAMES.callbackTokens);
  assert.ok(callbackRows.find((row) => row.action === 'regenerate_images'));
  assert.ok(callbackRows.find((row) => row.action === 'regenerate_text'));
  assert.ok(callbackRows.find((row) => row.action === 'publish_confirm'));
  assert.ok(!callbackRows.find((row) => row.action === 'schedule'));

  const topicImageCall = ctx.openrouter.imageCalls.find((call) => call.metadata?.source_type === 'topic');
  assert.ok(topicImageCall);
  assert.deepEqual(topicImageCall.imageUrls, TOPIC_SALON_REFERENCE_IMAGE_URLS);
});

test('topic flow detaches long caption text from photo preview', async () => {
  const ctx = createService({
    initialTables: {
      [TABLE_NAMES.expertTopics]: [{
        topic_id: 'TOP-LONG',
        title: 'Длинный экспертный пост',
        brief: 'Проверка длинного текста',
        tags: 'care,long',
        priority: '1',
        status: 'ready',
        reserved_by: '',
        reserved_at: '',
        reservation_expires_at: '',
        last_job_id: '',
        last_published_at: '',
        notes: '',
      }],
    },
  });
  const longText = `${'Полезный совет по уходу. '.repeat(90)}Финальный абзац.`;
  ctx.openrouter.generateText = async (payload) => ({
    text: payload?.metadata?.source_type === 'topic'
      ? longText
      : 'Короткий текст',
  });

  await ctx.service.handleTelegramUpdate({
    update_id: 81,
    message: { message_id: 81, text: '/topic', chat: { id: 51 }, from: { id: 9 } },
  });

  const pickToken = await pickCallbackTokenByPrefix(ctx, 'pick_source_');
  assert.ok(pickToken);
  await ctx.service.handleTelegramUpdate({
    update_id: 82,
    callback_query: {
      id: 'cb-topic-long-pick',
      data: `pick_source_0_0:${pickToken}`,
      from: { id: 9 },
      message: { message_id: 81, chat: { id: 51 } },
    },
  });

  const previewPhoto = ctx.bot.sent.find((item) => item.type === 'photo');
  assert.ok(previewPhoto);
  assert.ok(previewPhoto.extra.caption.length < 1024);
  assert.match(previewPhoto.extra.caption, /Версия 1\/1/);

  const previewText = ctx.bot.sent.find((item) =>
    item.type === 'message'
    && item.text.includes('Полезный совет по уходу.')
    );
  assert.ok(previewText);
  assert.ok(previewText.text.length > 1024);
  assert.match(previewText.text, /\+7 \(987\) 741-83-99/);
});

test('topic regenerate_images keeps using salon reference images', async () => {
  const ctx = createService({
    initialTables: {
      [TABLE_NAMES.expertTopics]: [{
        topic_id: 'TOP-REGEN',
        title: 'РўРµРјР° РґР»СЏ РЅРѕРІРѕР№ РєР°СЂС‚РёРЅРєРё',
        brief: 'РџСЂРѕ РґРѕРјР°С€РЅРёР№ СѓС…РѕРґ',
        tags: 'care,home',
        priority: '1',
        status: 'ready',
        reserved_by: '',
        reserved_at: '',
        reservation_expires_at: '',
        last_job_id: '',
        last_published_at: '',
        notes: '',
      }],
    },
  });

  await ctx.service.handleTelegramUpdate({
    update_id: 82,
    message: { message_id: 82, text: '/topic', chat: { id: 52 }, from: { id: 10 } },
  });

  const pickToken = await pickCallbackTokenByPrefix(ctx, 'pick_source_');
  assert.ok(pickToken);
  await ctx.service.handleTelegramUpdate({
    update_id: 83,
    callback_query: {
      id: 'cb-topic-pick-regen',
      data: `pick_source_0_0:${pickToken}`,
      from: { id: 10 },
      message: { message_id: 82, chat: { id: 52 } },
    },
  });

  const queueRows = await ctx.store.getRows(TABLE_NAMES.contentQueue);
  const runtime = await ctx.repos.getRuntime(queueRows[0].job_id);
  const regenerateToken = await pickCallbackToken(ctx, 'regenerate_images');
  assert.ok(regenerateToken);

  await ctx.service.handleTelegramUpdate({
    update_id: 84,
    callback_query: {
      id: 'cb-topic-r1',
      data: `regenerate_images:${regenerateToken}`,
      from: { id: 10 },
      message: { message_id: runtime.text_message_id ?? runtime.collage_message_id, chat: { id: 52 } },
    },
  });

  const topicImageCalls = ctx.openrouter.imageCalls.filter((call) => call.metadata?.source_type === 'topic');
  assert.equal(topicImageCalls.length, 2);
  assert.deepEqual(topicImageCalls[0].imageUrls, TOPIC_SALON_REFERENCE_IMAGE_URLS);
  assert.deepEqual(topicImageCalls[1].imageUrls, TOPIC_SALON_REFERENCE_IMAGE_URLS);
});

test('topic version_prev restores previous single-image media after regenerate_images', async () => {
  const ctx = createService({
    initialTables: {
      [TABLE_NAMES.expertTopics]: [{
        topic_id: 'TOP-VERSIONS',
        title: 'Как продлить свежесть укладки',
        brief: 'Тест навигации по картинкам',
        tags: 'care,styling',
        priority: '1',
        status: 'ready',
        reserved_by: '',
        reserved_at: '',
        reservation_expires_at: '',
        last_job_id: '',
        last_published_at: '',
        notes: '',
      }],
    },
  });

  await ctx.service.handleTelegramUpdate({
    update_id: 120,
    message: { message_id: 120, text: '/topic', chat: { id: 53 }, from: { id: 12 } },
  });
  const pickToken = await pickCallbackTokenByPrefix(ctx, 'pick_source_');
  await ctx.service.handleTelegramUpdate({
    update_id: 121,
    callback_query: {
      id: 'cb-topic-version-pick',
      data: `pick_source_0_0:${pickToken}`,
      from: { id: 12 },
      message: { message_id: 120, chat: { id: 53 } },
    },
  });

  const queueRows = await ctx.store.getRows(TABLE_NAMES.contentQueue);
  const runtimeBefore = await ctx.repos.getRuntime(queueRows[0].job_id);
  const regenerateToken = await pickCallbackToken(ctx, 'regenerate_images');
  await ctx.service.handleTelegramUpdate({
    update_id: 122,
    callback_query: {
      id: 'cb-topic-version-regen',
      data: `regenerate_images:${regenerateToken}`,
      from: { id: 12 },
      message: { message_id: runtimeBefore.text_message_id ?? runtimeBefore.collage_message_id, chat: { id: 53 } },
    },
  });

  const mediaEditsBeforePrev = ctx.bot.sent.filter((item) => item.type === 'edit_message_media').length;
  const prevToken = await pickCallbackToken(ctx, 'version_prev');
  await ctx.service.handleTelegramUpdate({
    update_id: 123,
    callback_query: {
      id: 'cb-topic-version-prev',
      data: `version_prev:${prevToken}`,
      from: { id: 12 },
      message: { message_id: runtimeBefore.collage_message_id ?? runtimeBefore.text_message_id, chat: { id: 53 } },
    },
  });

  const runtimeAfter = await ctx.repos.getRuntime(queueRows[0].job_id);
  assert.equal(runtimeAfter.draft_payload.viewRevision, 1);
  assert.ok(ctx.bot.sent.filter((item) => item.type === 'edit_message_media').length > mediaEditsBeforePrev);
});

test('stories picker paginates by ten items per page', async () => {
  const storyRows = Array.from({ length: 11 }, (_, index) => ({
    topic_id: `ST-${index + 1}`,
    title: `Stories тема ${index + 1}`,
    brief: 'Короткая тема для сториз',
    tags: 'care,home',
    priority: String(index + 1),
    status: 'ready',
    reserved_by: '',
    reserved_at: '',
    reservation_expires_at: '',
    last_job_id: '',
    last_published_at: '',
    notes: '',
  }));
  const ctx = createService({
    initialTables: {
      [TABLE_NAMES.storyTopics]: storyRows,
    },
  });

  await ctx.service.handleTelegramUpdate({
    update_id: 130,
    message: { message_id: 130, text: '/stories', chat: { id: 54 }, from: { id: 13 } },
  });

  const firstPicker = ctx.bot.sent.find((item) => item.type === 'message' && String(item.text ?? '').includes('Страница 1/2'));
  assert.ok(firstPicker);
  const pickRows = await ctx.store.getRows(TABLE_NAMES.callbackTokens);
  assert.equal(pickRows.filter((row) => String(row.action).startsWith('pick_source_')).length, 10);

  const nextToken = await pickCallbackTokenByPrefix(ctx, 'picker_next_');
  await ctx.service.handleTelegramUpdate({
    update_id: 131,
    callback_query: {
      id: 'cb-stories-next',
      data: `picker_next_0:${nextToken}`,
      from: { id: 13 },
      message: { message_id: firstPicker.message_id, chat: { id: 54 } },
    },
  });

  assert.ok(ctx.bot.sent.some((item) => item.type === 'edit_message_text' && String(item.text ?? '').includes('Страница 2/2')));
});

test('stories picker page turns read a fresh slice from storage', async () => {
  const storyRows = Array.from({ length: 11 }, (_, index) => ({
    topic_id: `ST-FRESH-${index + 1}`,
    title: `Stories тема ${index + 1}`,
    brief: 'Проверка свежего page slice.',
    tags: 'care,home',
    priority: String(index + 1),
    status: 'ready',
    reserved_by: '',
    reserved_at: '',
    reservation_expires_at: '',
    last_job_id: '',
    last_published_at: '',
    notes: '',
  }));
  const ctx = createService({
    initialTables: {
      [TABLE_NAMES.storyTopics]: storyRows,
    },
  });

  await ctx.service.handleTelegramUpdate({
    update_id: 132,
    message: { message_id: 132, text: '/stories', chat: { id: 55 }, from: { id: 14 } },
  });

  const currentRows = await ctx.store.getRows(TABLE_NAMES.storyTopics);
  await ctx.store.updateRowByNumber(TABLE_NAMES.storyTopics, currentRows[10].__rowNumber, {
    ...currentRows[10],
    title: 'Stories тема после обновления',
  });

  const firstPicker = ctx.bot.sent.find((item) => item.type === 'message' && String(item.text ?? '').includes('Страница 1/2'));
  assert.ok(firstPicker);

  const nextToken = await pickCallbackTokenByPrefix(ctx, 'picker_next_');
  await ctx.service.handleTelegramUpdate({
    update_id: 133,
    callback_query: {
      id: 'cb-stories-next-fresh',
      data: `picker_next_0:${nextToken}`,
      from: { id: 14 },
      message: { message_id: firstPicker.message_id, chat: { id: 55 } },
    },
  });

  const editedPicker = [...ctx.bot.sent]
    .reverse()
    .find((item) => item.type === 'edit_message_text' && item.message_id === firstPicker.message_id);
  assert.ok(editedPicker);
  const inlineRows = editedPicker.extra?.reply_markup?.inline_keyboard ?? [];
  const labels = inlineRows.flat().map((button) => String(button?.text ?? ''));
  assert.ok(labels.some((label) => label.includes('Stories тема после обновления')));
});

test('stories and slider modes create expected preview shapes', async () => {
  const cases = [
    { command: '/stories', table: TABLE_NAMES.storyTopics, topicId: 'ST-1', jobType: 'stories', expects: 'single' },
    { command: '/slider', table: TABLE_NAMES.sliderTopics, topicId: 'SL-1', jobType: 'slider', expects: 'separate' },
  ];

  for (const [index, item] of cases.entries()) {
    const ctx = createService({
      initialTables: {
        [item.table]: [{
          topic_id: item.topicId,
          title: `${item.jobType} тема`,
          brief: 'Проверка нового режима',
          tags: 'care,home,style',
          priority: '1',
          status: 'ready',
          reserved_by: '',
          reserved_at: '',
          reservation_expires_at: '',
          last_job_id: '',
          last_published_at: '',
          notes: '',
        }],
      },
    });

    await ctx.service.handleTelegramUpdate({
      update_id: 140 + (index * 10),
      message: { message_id: 140 + index, text: item.command, chat: { id: 60 + index }, from: { id: 20 + index } },
    });
    const pickToken = await pickCallbackTokenByPrefix(ctx, 'pick_source_');
    await ctx.service.handleTelegramUpdate({
      update_id: 141 + (index * 10),
      callback_query: {
        id: `cb-mode-pick-${item.jobType}`,
        data: `pick_source_0_0:${pickToken}`,
        from: { id: 20 + index },
        message: { message_id: 140 + index, chat: { id: 60 + index } },
      },
    });

    const queueRows = await ctx.store.getRows(TABLE_NAMES.contentQueue);
    const runtime = await ctx.repos.getRuntime(queueRows[0].job_id);
    const sourceRows = await ctx.store.getRows(item.table);
    assert.equal(runtime.job_type, item.jobType);
    assert.equal(runtime.draft_payload.finalRenderMode, item.expects);
    assert.equal(sourceRows[0].status, 'reserved');
    if (item.expects === 'single') {
      assert.ok(ctx.bot.sent.some((sent) => sent.type === 'photo'));
    } else {
      assert.ok(ctx.bot.sent.some((sent) => sent.type === 'media_group'));
    }
  }
});

test('slider retries visual generation once with a compact prompt when the provider returns no images', async () => {
  const ctx = createService({
    initialTables: {
      [TABLE_NAMES.sliderTopics]: [{
        topic_id: 'SL-RETRY',
        title: 'Проверка ретрая слайдера',
        brief: 'Проверка compact prompt retry для visual generation.',
        tags: 'slider,retry',
        priority: '1',
        status: 'ready',
        reserved_by: '',
        reserved_at: '',
        reservation_expires_at: '',
        last_job_id: '',
        last_published_at: '',
        notes: '',
      }],
    },
  });

  let imageAttempts = 0;
  const fallbackImage = await sharp({
    create: {
      width: 1080,
      height: 1920,
      channels: 3,
      background: '#b7926f',
    },
  }).jpeg().toBuffer();
  ctx.openrouter.generateImages = async (payload) => {
    imageAttempts += 1;
    if (imageAttempts === 1) {
      const error = new Error('openrouter returned no images');
      error.name = 'ProviderEmptyResultError';
      throw error;
    }
    return { images: [`data:image/jpeg;base64,${fallbackImage.toString('base64')}`] };
  };

  await ctx.service.handleTelegramUpdate({
    update_id: 1450,
    message: { message_id: 1450, text: '/slider', chat: { id: 1450 }, from: { id: 45 } },
  });
  const pickToken = await pickCallbackTokenByPrefix(ctx, 'pick_source_');
  assert.ok(pickToken);

  await ctx.service.handleTelegramUpdate({
    update_id: 1451,
    callback_query: {
      id: 'cb-slider-visual-retry',
      data: `pick_source_0_0:${pickToken}`,
      from: { id: 45 },
      message: { message_id: 1450, chat: { id: 1450 } },
    },
  });

  assert.equal(imageAttempts, 2);
  assert.ok(ctx.bot.sent.some((item) => item.type === 'media_group'));
});

test('slider fallback renders dense practical slides for basic home care', async () => {
  const ctx = createService({
    initialTables: {
      [TABLE_NAMES.sliderTopics]: [{
        topic_id: 'SL-SPARSE',
        title: 'Базовый уход дома',
        brief: 'Короткая памятка без перегруза.',
        tags: '',
        priority: '1',
        status: 'ready',
        reserved_by: '',
        reserved_at: '',
        reservation_expires_at: '',
        last_job_id: '',
        last_published_at: '',
        notes: '',
      }],
    },
  });

  ctx.openrouter.generateText = async (payload) => {
    ctx.openrouter.textCalls.push(payload);
    return { text: '{}' };
  };

  await ctx.service.handleTelegramUpdate({
    update_id: 150,
    message: { message_id: 150, text: '/slider', chat: { id: 74 }, from: { id: 26 } },
  });

  const pickToken = await pickCallbackTokenByPrefix(ctx, 'pick_source_');
  assert.ok(pickToken);

  await ctx.service.handleTelegramUpdate({
    update_id: 151,
    callback_query: {
      id: 'cb-slider-sparse',
      data: `pick_source_0_0:${pickToken}`,
      from: { id: 26 },
      message: { message_id: 150, chat: { id: 74 } },
    },
  });

  const queueRows = await ctx.store.getRows(TABLE_NAMES.contentQueue);
  const runtime = await ctx.repos.getRuntime(queueRows[0].job_id);
  assert.equal(runtime.job_type, 'slider');
  assert.equal(runtime.draft_payload.finalRenderMode, 'separate');
  assert.ok(runtime.draft_payload.previewTelegramFileIds.length >= 3);
  assert.ok(runtime.draft_payload.previewTelegramFileIds.length <= 5);
  assert.ok(ctx.bot.sent.filter((item) => item.type === 'media_group').at(-1)?.media?.length >= 3);
  assert.ok(ctx.bot.sent.filter((item) => item.type === 'media_group').at(-1)?.media?.length <= 5);
  assert.match(runtime.preview_payload.manifest.coverSubtitle, /маск/u);
  assert.match(runtime.preview_payload.manifest.coverSubtitle, /несмываем/u);
  assert.deepEqual(runtime.preview_payload.manifest.coverBullets, [
    'Шампунь по коже головы',
    'Кондиционер после каждого мытья',
    'Маска 1-2 раза в неделю',
    'Несмываемый уход по длине, например спрей или крем',
  ]);
  assert.equal(runtime.preview_payload.manifest.slides.length, 4);
  assert.ok(runtime.preview_payload.manifest.slides.every((slide) => slide.body.split(/\s+/u).length >= 10));
  assert.ok(runtime.preview_payload.manifest.slides.every((slide) => slide.bullets.length >= 2));
  assert.ok(runtime.preview_payload.manifest.slides.every((slide) => slide.bullets.every((item) => /^[А-ЯЁA-Z0-9]/u.test(item))));
  assert.equal((await ctx.store.getRows(TABLE_NAMES.sliderTopics))[0].status, 'reserved');
});

test('stories fallback answers the topic and never leaks raw tag strings', async () => {
  const ctx = createService({
    initialTables: {
      [TABLE_NAMES.storyTopics]: [{
        topic_id: 'ST-FALLBACK',
        title: 'Как сохранить мягкость после окрашивания',
        brief: 'Тема про домашний уход, который помогает цвету и длине выглядеть аккуратно.',
        tags: 'окрашивание;мягкость;цвет;уход',
        priority: '1',
        status: 'ready',
        reserved_by: '',
        reserved_at: '',
        reservation_expires_at: '',
        last_job_id: '',
        last_published_at: '',
        notes: '',
      }],
    },
  });

  ctx.openrouter.generateText = async (payload) => {
    ctx.openrouter.textCalls.push(payload);
    return { text: '{}' };
  };

  await ctx.service.handleTelegramUpdate({
    update_id: 180,
    message: { message_id: 180, text: '/stories', chat: { id: 80 }, from: { id: 31 } },
  });
  const pickToken = await pickCallbackTokenByPrefix(ctx, 'pick_source_');
  assert.ok(pickToken);

  await ctx.service.handleTelegramUpdate({
    update_id: 181,
    callback_query: {
      id: 'cb-stories-fallback',
      data: `pick_source_0_0:${pickToken}`,
      from: { id: 31 },
      message: { message_id: 180, chat: { id: 80 } },
    },
  });

  const queueRows = await ctx.store.getRows(TABLE_NAMES.contentQueue);
  assert.equal(queueRows.length, 1);
  const runtime = await ctx.repos.getRuntime(queueRows[0].job_id);
  const payload = runtime.preview_payload;

  assert.equal(payload.manifest.title, 'Как сохранить мягкость после окрашивания');
  assert.match(payload.manifest.body, /мягк|увлажн|цвет/u);
  assert.ok(payload.manifest.bullets.length >= 2);
  assert.ok(payload.manifest.bullets.every((item) => !String(item).includes(';')));
  assert.ok(!String(payload.captionText).includes('окрашивание;мягкость;цвет;уход'));
});

test('slider normalization keeps dense home-care copy aligned across cover and slides', () => {
  const ctx = createService();
  const manifest = ctx.service.normalizeTopicLikeManifest('slider', {
    coverTitle: '5 средств для базового ухода дома',
    coverSubtitle: 'Шампунь, кондиционер, маска и несмываемый уход — база, которая закрывает очищение, мягкость, питание и защиту.',
    coverBullets: ['Шампунь', 'Кондиционер', 'Маска', 'Несмываемый уход'],
    slides: [
      {
        eyebrow: 'Шаг 1',
        title: '1. Шампунь',
        body: 'Очищает кожу головы и длину без ощущения тяжести.',
        bullets: ['Подбирайте по коже головы', '1-2 раза в неделю'],
      },
      {
        eyebrow: 'Шаг 2',
        title: '2. Кондиционер',
        body: 'Закрывает кутикулу и делает длину мягче после каждого мытья.',
        bullets: ['Только по длине', 'Не перегружает корни'],
      },
      {
        eyebrow: 'Шаг 3',
        title: '3. Маска',
        body: 'Даёт более глубокое питание и помогает сухой длине.',
        bullets: ['1-2 раза в неделю', 'Лучше не вместо кондиционера каждый раз'],
      },
      {
        eyebrow: 'Шаг 4',
        title: '4. Несмываемый уход',
        body: 'Снимает пушение, облегчает расчёсывание и сохраняет гладкость.',
        bullets: ['Крем или спрей', 'Перед сушкой феном'],
      },
    ],
    footer: '',
  }, {
    topic_id: 'SL-DENSE',
    title: '5 средств для базового ухода дома',
    brief: 'База домашнего ухода без перегруза.',
    tags: 'шампунь,кондиционер,маска,несмываемый уход',
  });

  assert.equal(manifest.eyebrow, '');
  assert.match(manifest.coverSubtitle, /шампунь/i);
  assert.match(manifest.coverSubtitle, /кондиционер/i);
  assert.match(manifest.coverSubtitle, /маска/i);
  assert.match(manifest.coverSubtitle, /несмываемый уход/i);
  assert.deepEqual(manifest.coverBullets, [
    'Шампунь по коже головы',
    'Кондиционер после каждого мытья',
    'Маска 1-2 раза в неделю',
    'Несмываемый уход по длине, например спрей или крем',
  ]);
  assert.equal(manifest.slides.length, 4);
  assert.equal(manifest.slides[0].title, '1. Шампунь');
  assert.match(manifest.slides[0].body, /кожу головы/i);
  assert.match(manifest.slides[1].body, /после каждого мытья/i);
  assert.match(manifest.slides[2].body, /питание/i);
  assert.match(manifest.slides[3].body, /пушение/i);
  assert.ok(manifest.slides.every((slide) => slide.body.length > 35));
  assert.ok(manifest.slides.every((slide) => slide.bullets.length >= 2));
  assert.ok(manifest.slides.flatMap((slide) => slide.bullets).every((item) => !String(item).startsWith('-')));
  assert.ok(manifest.slides.flatMap((slide) => slide.bullets).every((item) => /^[А-ЯЁA-Z0-9]/u.test(item)));
});

test('slider cover title count stays aligned with the actual number of rendered slides', () => {
  const ctx = createService();
  const manifest = ctx.service.normalizeTopicLikeManifest('slider', {
    coverTitle: '6 ошибок, которые портят результат после салона',
    coverSubtitle: 'Что не стоит делать в первые дни после визита.',
    slides: [
      { title: 'Не мойте голову сразу', body: 'Дайте цвету и укладке спокойно закрепиться в первые сутки.', bullets: ['Подождите хотя бы до следующего дня', 'Мягкое мытьё всегда лучше спешки'] },
      { title: 'Не берите первый попавшийся шампунь', body: 'Слишком жёсткое очищение быстрее смывает ощущение свежести после салона.', bullets: ['Выбирайте мягкий вариант', 'Без агрессивного скрипа'] },
      { title: 'Не стягивайте волосы', body: 'Тугие хвосты и пучки могут заламывать волосы и убирать аккуратный вид.', bullets: ['Лучше оставить волосы свободнее', 'Особенно в первые дни'] },
      { title: 'Меньше горячих приборов', body: 'Лишний перегрев быстрее сушит волосы и убирает гладкость.', bullets: ['Если сушите, добавляйте защиту', 'Температуру держите спокойнее'] },
    ],
  }, {
    topic_id: 'SL-COUNT',
    title: '6 ошибок, которые портят результат после салона',
    brief: 'Короткая памятка после визита.',
    tags: 'ошибки;после салона',
  });

  assert.equal(manifest.slides.length, 5);
  assert.equal(manifest.coverTitle, '5 ошибок, которые портят результат после салона');
});

test('bullet normalization strips list markers before rendering', () => {
  const ctx = createService();

  assert.equal(ctx.service.normalizeOverlayBullet('-2 раза в неделю'), '2 раза в неделю');
  assert.deepEqual(
    ctx.service.normalizeCreativeBullets(['- Шампунь', '1. Кондиционер']),
    ['Шампунь', 'Кондиционер'],
  );
  assert.deepEqual(
    ctx.service.normalizeStoryBullets(['- Подбирайте по коже головы', '1. После каждого мытья', '• Без лишней тяжести']),
    ['Подбирайте по коже головы', 'После каждого мытья', 'Без лишней тяжести'],
  );
});

test('topic-like source rows stay reserved after preview generation and regeneration', async () => {
  const ctx = createService({
    initialTables: {
      [TABLE_NAMES.storyTopics]: [{
        topic_id: 'ST-RESERVED',
        title: 'Как сохранить мягкость после окрашивания',
        brief: 'Проверка статуса после preview и regenerate.',
        tags: 'care,color',
        priority: '1',
        status: 'ready',
        reserved_by: '',
        reserved_at: '',
        reservation_expires_at: '',
        last_job_id: '',
        last_published_at: '',
        notes: '',
      }],
    },
  });

  await ctx.service.handleTelegramUpdate({
    update_id: 190,
    message: { message_id: 190, text: '/stories', chat: { id: 81 }, from: { id: 32 } },
  });
  const pickToken = await pickCallbackTokenByPrefix(ctx, 'pick_source_');
  assert.ok(pickToken);

  await ctx.service.handleTelegramUpdate({
    update_id: 191,
    callback_query: {
      id: 'cb-stories-reserved',
      data: `pick_source_0_0:${pickToken}`,
      from: { id: 32 },
      message: { message_id: 190, chat: { id: 81 } },
    },
  });

  const sourceRowsAfterPreview = await ctx.store.getRows(TABLE_NAMES.storyTopics);
  assert.equal(sourceRowsAfterPreview[0].status, 'reserved');
  assert.ok(sourceRowsAfterPreview[0].reserved_by);

  const queueRows = await ctx.store.getRows(TABLE_NAMES.contentQueue);
  assert.equal(queueRows[0].status, 'preview_ready');
  const runtime = await ctx.repos.getRuntime(queueRows[0].job_id);

  const regenerateToken = await pickCallbackToken(ctx, 'regenerate_text');
  assert.ok(regenerateToken);
  await ctx.service.handleTelegramUpdate({
    update_id: 192,
    callback_query: {
      id: 'cb-stories-reserved-regenerate',
      data: `regenerate_text:${regenerateToken}`,
      from: { id: 32 },
      message: { message_id: runtime.text_message_id ?? runtime.collage_message_id, chat: { id: 81 } },
    },
  });

  const sourceRowsAfterRegenerate = await ctx.store.getRows(TABLE_NAMES.storyTopics);
  assert.equal(sourceRowsAfterRegenerate[0].status, 'reserved');
  assert.ok(sourceRowsAfterRegenerate[0].reserved_by);
  assert.equal((await ctx.store.getRows(TABLE_NAMES.contentQueue))[0].status, 'preview_ready');
});

test('cancel returns topic-like source row to ready without publishing it', async () => {
  const ctx = createService({
    initialTables: {
      [TABLE_NAMES.sliderTopics]: [{
        topic_id: 'SL-CANCEL',
        title: 'Базовый уход дома',
        brief: 'Проверка возврата темы после cancel.',
        tags: 'care,home',
        priority: '1',
        status: 'ready',
        reserved_by: '',
        reserved_at: '',
        reservation_expires_at: '',
        last_job_id: '',
        last_published_at: '',
        notes: '',
      }],
    },
  });

  await ctx.service.handleTelegramUpdate({
    update_id: 193,
    message: { message_id: 193, text: '/slider', chat: { id: 82 }, from: { id: 33 } },
  });
  const pickToken = await pickCallbackTokenByPrefix(ctx, 'pick_source_');
  assert.ok(pickToken);

  await ctx.service.handleTelegramUpdate({
    update_id: 194,
    callback_query: {
      id: 'cb-slider-cancel-pick',
      data: `pick_source_0_0:${pickToken}`,
      from: { id: 33 },
      message: { message_id: 193, chat: { id: 82 } },
    },
  });

  const runtime = await ctx.repos.getRuntime((await ctx.store.getRows(TABLE_NAMES.contentQueue))[0].job_id);
  const cancelToken = await pickCallbackToken(ctx, 'cancel');
  assert.ok(cancelToken);

  await ctx.service.handleTelegramUpdate({
    update_id: 195,
    callback_query: {
      id: 'cb-slider-cancel',
      data: `cancel:${cancelToken}`,
      from: { id: 33 },
      message: { message_id: runtime.text_message_id ?? runtime.collage_message_id, chat: { id: 82 } },
    },
  });

  const sourceRows = await ctx.store.getRows(TABLE_NAMES.sliderTopics);
  assert.equal(sourceRows[0].status, 'ready');
  assert.equal(sourceRows[0].reserved_by, '');
  assert.equal((await ctx.store.getRows(TABLE_NAMES.contentQueue))[0].status, 'cancelled');
});

test('publish_confirm marks source row as published', async () => {
  const ctx = createService({
    initialTables: {
      [TABLE_NAMES.storyTopics]: [{
        topic_id: 'ST-PUB',
        title: 'Stories для публикации',
        brief: 'Проверка публикации',
        tags: 'care,home',
        priority: '1',
        status: 'ready',
        reserved_by: '',
        reserved_at: '',
        reservation_expires_at: '',
        last_job_id: '',
        last_published_at: '',
        notes: '',
      }],
    },
  });

  await ctx.service.handleTelegramUpdate({
    update_id: 170,
    message: { message_id: 170, text: '/stories', chat: { id: 70 }, from: { id: 30 } },
  });
  const pickToken = await pickCallbackTokenByPrefix(ctx, 'pick_source_');
  await ctx.service.handleTelegramUpdate({
    update_id: 171,
    callback_query: {
      id: 'cb-publish-pick',
      data: `pick_source_0_0:${pickToken}`,
      from: { id: 30 },
      message: { message_id: 170, chat: { id: 70 } },
    },
  });

  const queueRows = await ctx.store.getRows(TABLE_NAMES.contentQueue);
  const runtime = await ctx.repos.getRuntime(queueRows[0].job_id);
  const sourceRowsBeforePublish = await ctx.store.getRows(TABLE_NAMES.storyTopics);
  assert.equal(sourceRowsBeforePublish[0].status, 'reserved');

  const publishToken = await pickCallbackToken(ctx, 'publish_confirm');
  await ctx.service.handleTelegramUpdate({
    update_id: 172,
    callback_query: {
      id: 'cb-publish-confirm',
      data: `publish_confirm:${publishToken}`,
      from: { id: 30 },
      message: { message_id: runtime.text_message_id ?? runtime.collage_message_id, chat: { id: 70 } },
    },
  });

  const rows = await ctx.store.getRows(TABLE_NAMES.storyTopics);
  assert.equal(rows[0].status, 'published');
  assert.equal((await ctx.store.getRows(TABLE_NAMES.contentQueue))[0].status, 'published');
});

test('published topic is excluded from the picker on the next open for every topic-like mode', async () => {
  const modes = [
    { command: '/topic', table: TABLE_NAMES.expertTopics, prefix: 'TP' },
    { command: '/stories', table: TABLE_NAMES.storyTopics, prefix: 'ST' },
    { command: '/creative', table: TABLE_NAMES.creativeIdeas, prefix: 'CR' },
    { command: '/slider', table: TABLE_NAMES.sliderTopics, prefix: 'SL' },
  ];

  for (const [index, mode] of modes.entries()) {
    const chatId = 610 + index;
    const publishedTitle = `Тема ${mode.prefix}, которую подтвердили`;
    const readyTitle = `Тема ${mode.prefix}, которая должна остаться`;
    const ctx = createService({
      initialTables: {
        [mode.table]: [
          {
            topic_id: `${mode.prefix}-PUBLISHED`,
            title: publishedTitle,
            brief: 'Проверка исключения опубликованной темы из picker.',
            tags: `${mode.prefix.toLowerCase()},published`,
            priority: '1',
            status: 'ready',
            reserved_by: '',
            reserved_at: '',
            reservation_expires_at: '',
            last_job_id: '',
            last_published_at: '',
            notes: '',
          },
          {
            topic_id: `${mode.prefix}-READY`,
            title: readyTitle,
            brief: 'Проверка следующего открытия picker.',
            tags: `${mode.prefix.toLowerCase()},ready`,
            priority: '2',
            status: 'ready',
            reserved_by: '',
            reserved_at: '',
            reservation_expires_at: '',
            last_job_id: '',
            last_published_at: '',
            notes: '',
          },
        ],
      },
    });

    await ctx.service.handleTelegramUpdate({
      update_id: 6100 + index,
      message: { message_id: 6100 + index, text: mode.command, chat: { id: chatId }, from: { id: chatId } },
    });
    const pickToken = await pickCallbackTokenByPrefix(ctx, 'pick_source_');
    assert.ok(pickToken, `Expected pick token for ${mode.command}`);

    await ctx.service.handleTelegramUpdate({
      update_id: 6200 + index,
      callback_query: {
        id: `cb-${mode.prefix}-published-pick`,
        data: `pick_source_0_0:${pickToken}`,
        from: { id: chatId },
        message: { message_id: 6100 + index, chat: { id: chatId } },
      },
    });

    const runtime = await ctx.repos.getRuntime((await ctx.store.getRows(TABLE_NAMES.contentQueue))[0].job_id);
    const publishToken = await pickCallbackToken(ctx, 'publish_confirm');
    assert.ok(publishToken, `Expected publish token for ${mode.command}`);

    await ctx.service.handleTelegramUpdate({
      update_id: 6300 + index,
      callback_query: {
        id: `cb-${mode.prefix}-published-confirm`,
        data: `publish_confirm:${publishToken}`,
        from: { id: chatId },
        message: { message_id: runtime.text_message_id ?? runtime.collage_message_id, chat: { id: chatId } },
      },
    });

    const rows = await ctx.store.getRows(mode.table);
    assert.equal(rows.find((row) => row.topic_id === `${mode.prefix}-PUBLISHED`)?.status, 'published');
    assert.equal(rows.find((row) => row.topic_id === `${mode.prefix}-READY`)?.status, 'ready');

    await ctx.service.handleTelegramUpdate({
      update_id: 6400 + index,
      message: { message_id: 6400 + index, text: mode.command, chat: { id: chatId }, from: { id: chatId } },
    });

    const latestPicker = [...ctx.bot.sent]
      .reverse()
      .find((item) => (item.type === 'message' || item.type === 'edit_message_text')
        && item.chat?.id === chatId);
    assert.ok(latestPicker, `Expected picker update for ${mode.command}`);
    const pickerLabels = (latestPicker.extra?.reply_markup?.inline_keyboard ?? [])
      .flat()
      .map((button) => String(button?.text ?? ''));
    assert.ok(
      pickerLabels.some((label) => label.includes(readyTitle)),
      `Expected remaining ready topic for ${mode.command}`,
    );
    assert.ok(
      !pickerLabels.some((label) => label.includes(publishedTitle)),
      `Expected published topic to disappear for ${mode.command}`,
    );
  }
});

test('topic-like modes do not mutate source rows in QA mode after pick, regenerate, cancel, and publish', async () => {
  const modes = [
    { command: '/topic', table: TABLE_NAMES.expertTopics, topicId: 'TP-QA', title: 'Проверка /topic' },
    { command: '/stories', table: TABLE_NAMES.storyTopics, topicId: 'ST-QA', title: 'Проверка /stories' },
    { command: '/slider', table: TABLE_NAMES.sliderTopics, topicId: 'SL-QA', title: 'Проверка /slider' },
  ];

  for (const [index, mode] of modes.entries()) {
    const chatIdBase = 310 + (index * 10);
    const userId = 710 + index;
    const initialRow = {
      topic_id: mode.topicId,
      title: mode.title,
      brief: 'Проверка QA-режима без мутаций source rows.',
      tags: 'qa,topic-like',
      priority: '1',
      status: 'ready',
      reserved_by: '',
      reserved_at: '',
      reservation_expires_at: '',
      last_job_id: '',
      last_published_at: '',
      notes: '',
    };

    const ctxCancel = createService({
      envOverrides: { topicSourceStatusMutationsEnabled: false },
      initialTables: { [mode.table]: [initialRow] },
    });

    await ctxCancel.service.handleTelegramUpdate({
      update_id: chatIdBase,
      message: { message_id: chatIdBase, text: mode.command, chat: { id: chatIdBase }, from: { id: userId } },
    });
    const pickToken = await pickCallbackTokenByPrefix(ctxCancel, 'pick_source_');
    assert.ok(pickToken, `Expected pick token for ${mode.command}`);
    await ctxCancel.service.handleTelegramUpdate({
      update_id: chatIdBase + 1,
      callback_query: {
        id: `cb-qa-pick-${mode.topicId}`,
        data: `pick_source_0_0:${pickToken}`,
        from: { id: userId },
        message: { message_id: chatIdBase, chat: { id: chatIdBase } },
      },
    });

    const queueRows = await ctxCancel.store.getRows(TABLE_NAMES.contentQueue);
    const runtime = await ctxCancel.repos.getRuntime(queueRows[0].job_id);
    const regenerateToken = await pickCallbackToken(ctxCancel, 'regenerate_text')
      ?? await pickCallbackToken(ctxCancel, 'regenerate_images');
    if (regenerateToken) {
      const regenerateAction = (await ctxCancel.store.getRows(TABLE_NAMES.callbackTokens))
        .find((row) => row.token === regenerateToken)?.action;
      await ctxCancel.service.handleTelegramUpdate({
        update_id: chatIdBase + 2,
        callback_query: {
          id: `cb-qa-regen-${mode.topicId}`,
          data: `${regenerateAction}:${regenerateToken}`,
          from: { id: userId },
          message: { message_id: runtime.text_message_id ?? runtime.collage_message_id, chat: { id: chatIdBase } },
        },
      });
    }

    const cancelToken = await pickCallbackToken(ctxCancel, 'cancel');
    assert.ok(cancelToken, `Expected cancel token for ${mode.command}`);
    await ctxCancel.service.handleTelegramUpdate({
      update_id: chatIdBase + 3,
      callback_query: {
        id: `cb-qa-cancel-${mode.topicId}`,
        data: `cancel:${cancelToken}`,
        from: { id: userId },
        message: { message_id: runtime.text_message_id ?? runtime.collage_message_id, chat: { id: chatIdBase } },
      },
    });

    const sourceAfterCancel = (await ctxCancel.store.getRows(mode.table))[0];
    assert.equal(sourceAfterCancel.status, 'ready');
    assert.equal(sourceAfterCancel.reserved_by, '');
    assert.equal(sourceAfterCancel.reserved_at, '');
    assert.equal(sourceAfterCancel.reservation_expires_at, '');
    assert.equal(sourceAfterCancel.last_job_id, '');
    assert.equal(sourceAfterCancel.last_published_at, '');

    const ctxPublish = createService({
      envOverrides: { topicSourceStatusMutationsEnabled: false },
      initialTables: { [mode.table]: [initialRow] },
    });
    await ctxPublish.service.handleTelegramUpdate({
      update_id: chatIdBase + 4,
      message: { message_id: chatIdBase + 4, text: mode.command, chat: { id: chatIdBase + 4 }, from: { id: userId } },
    });
    const pickTokenPublish = await pickCallbackTokenByPrefix(ctxPublish, 'pick_source_');
    await ctxPublish.service.handleTelegramUpdate({
      update_id: chatIdBase + 5,
      callback_query: {
        id: `cb-qa-pick-publish-${mode.topicId}`,
        data: `pick_source_0_0:${pickTokenPublish}`,
        from: { id: userId },
        message: { message_id: chatIdBase + 4, chat: { id: chatIdBase + 4 } },
      },
    });
    const runtimePublish = await ctxPublish.repos.getRuntime((await ctxPublish.store.getRows(TABLE_NAMES.contentQueue))[0].job_id);
    const publishToken = await pickCallbackToken(ctxPublish, 'publish_confirm');
    assert.ok(publishToken, `Expected publish token for ${mode.command}`);
    await ctxPublish.service.handleTelegramUpdate({
      update_id: chatIdBase + 6,
      callback_query: {
        id: `cb-qa-publish-${mode.topicId}`,
        data: `publish_confirm:${publishToken}`,
        from: { id: userId },
        message: { message_id: runtimePublish.text_message_id ?? runtimePublish.collage_message_id, chat: { id: chatIdBase + 4 } },
      },
    });

    const sourceAfterPublish = (await ctxPublish.store.getRows(mode.table))[0];
    assert.equal(sourceAfterPublish.status, 'ready');
    assert.equal(sourceAfterPublish.reserved_by, '');
    assert.equal(sourceAfterPublish.reserved_at, '');
    assert.equal(sourceAfterPublish.reservation_expires_at, '');
    assert.equal(sourceAfterPublish.last_job_id, '');
    assert.equal(sourceAfterPublish.last_published_at, '');
  }
});

test('error after source reservation rolls topic-like source row back to ready when mutations are enabled', async () => {
  const ctx = createService({
    envOverrides: { topicSourceStatusMutationsEnabled: true },
    initialTables: {
      [TABLE_NAMES.storyTopics]: [{
        topic_id: 'ST-ROLLBACK',
        title: 'Rollback на ошибке генерации',
        brief: 'Проверка releaseSourceRow в catch после reserve.',
        tags: 'rollback,error',
        priority: '1',
        status: 'ready',
        reserved_by: '',
        reserved_at: '',
        reservation_expires_at: '',
        last_job_id: '',
        last_published_at: '',
        notes: '',
      }],
    },
  });

  await ctx.service.handleTelegramUpdate({
    update_id: 402,
    message: { message_id: 402, text: '/stories', chat: { id: 402 }, from: { id: 92 } },
  });
  const pickToken = await pickCallbackTokenByPrefix(ctx, 'pick_source_');
  assert.ok(pickToken);

  const originalStartTopicLikeJob = ctx.service.startTopicLikeJob.bind(ctx.service);
  ctx.service.startTopicLikeJob = async () => {
    throw new Error('forced generation failure');
  };

  const result = await ctx.service.handleTelegramUpdate({
    update_id: 403,
    callback_query: {
      id: 'cb-rollback',
      data: `pick_source_0_0:${pickToken}`,
      from: { id: 92 },
      message: { message_id: 402, chat: { id: 402 } },
    },
  });
  ctx.service.startTopicLikeJob = originalStartTopicLikeJob;

  assert.equal(result.ok, false);
  assert.match(String(result.error ?? ''), /forced generation failure/u);
  const row = (await ctx.store.getRows(TABLE_NAMES.storyTopics))[0];
  assert.equal(row.status, 'ready');
  assert.equal(row.reserved_by, '');
  assert.equal(row.reserved_at, '');
  assert.equal(row.reservation_expires_at, '');
});

test('picker page switch uses fresh DB slice instead of stale session snapshot', async () => {
  const storyRows = Array.from({ length: 11 }, (_, index) => ({
    topic_id: `ST-PAGE-${index + 1}`,
    title: `Тема ${String(index + 1).padStart(2, '0')}`,
    brief: 'Проверка page freshness.',
    tags: 'picker,freshness',
    priority: '1',
    status: 'ready',
    reserved_by: '',
    reserved_at: '',
    reservation_expires_at: '',
    last_job_id: '',
    last_published_at: '',
    notes: '',
  }));

  const ctx = createService({
    initialTables: {
      [TABLE_NAMES.storyTopics]: storyRows,
    },
  });

  await ctx.service.handleTelegramUpdate({
    update_id: 501,
    message: { message_id: 501, text: '/stories', chat: { id: 501 }, from: { id: 95 } },
  });
  const pickerSession = await ctx.repos.getSessionById('picker:stories:501');
  const pickerPayload = JSON.parse(pickerSession.pending_payload_json);
  assert.equal('readyRows' in pickerPayload, false);
  const firstPicker = ctx.bot.sent.find((item) => item.type === 'message' && String(item.text ?? '').includes('Страница 1/2'));
  assert.ok(firstPicker);
  const nextToken = await pickCallbackTokenByPrefix(ctx, 'picker_next_');
  assert.ok(nextToken);

  const rowToDemote = (await ctx.store.getRows(TABLE_NAMES.storyTopics)).find((row) => row.topic_id === 'ST-PAGE-11');
  await ctx.store.updateRowByNumber(TABLE_NAMES.storyTopics, rowToDemote.__rowNumber, {
    ...rowToDemote,
    status: 'published',
  });

  await ctx.service.handleTelegramUpdate({
    update_id: 502,
    callback_query: {
      id: 'cb-picker-freshness',
      data: `picker_next_0:${nextToken}`,
      from: { id: 95 },
      message: { message_id: firstPicker.message_id, chat: { id: 501 } },
    },
  });

  const lastEdit = ctx.bot.sent.filter((item) => item.type === 'edit_message_text').at(-1);
  assert.ok(lastEdit);
  assert.match(String(lastEdit.text ?? ''), /Страница 1\/1/u);
  assert.match(String(lastEdit.text ?? ''), /Доступно тем: 10/u);
});

test('/start and /help share the command menu and removed commands are treated as unknown', async () => {
  const ctx = createService();

  await ctx.service.handleTelegramUpdate({
    update_id: 89,
    message: { message_id: 89, text: '/start', chat: { id: 99 }, from: { id: 5 } },
  });
  await ctx.service.handleTelegramUpdate({
    update_id: 90,
    message: { message_id: 90, text: '/help', chat: { id: 99 }, from: { id: 5 } },
  });
  await ctx.service.handleTelegramUpdate({
    update_id: 91,
    message: { message_id: 91, text: '/logs', chat: { id: 99 }, from: { id: 5 } },
  });
  await ctx.service.handleTelegramUpdate({
    update_id: 92,
    message: { message_id: 92, text: '/creative', chat: { id: 99 }, from: { id: 5 } },
  });

  const sentTexts = ctx.bot.sent.filter((item) => item.type === 'message').map((item) => item.text);
  assert.match(sentTexts[0], /Выберите задачу/u);
  assert.ok(sentTexts[0].includes('/start'));
  assert.ok(sentTexts[0].includes('/work'));
  assert.ok(sentTexts[0].includes('/creative'));
  assert.equal(sentTexts[1], sentTexts[0].split('\n\n').slice(1).join('\n\n'));
  assert.equal(sentTexts.at(-2), USER_MESSAGES.unknownCommand);
  assert.equal(sentTexts.at(-1), 'Сейчас нет готовых идей для креативов.');
});

test('preview extraction fails fast when Telegram does not return reusable file ids', async () => {
  const ctx = createService();

  await assert.rejects(
    () => ctx.service.presentPreviewRevision({
      chatId: 10,
      payload: {
        jobId: 'JOB-X',
        revision: 1,
        viewRevision: 1,
        revisionHistory: [{
          revision: 1,
          captionText: 'Тест',
          previewTelegramFileIds: [],
          finalRenderMode: 'single',
          sourceAssetCount: 1,
        }],
      },
      revisionEntry: {
        revision: 1,
        captionText: 'Тест',
        previewTelegramFileIds: [],
        finalRenderMode: 'single',
        sourceAssetCount: 1,
      },
      tokensByAction: {},
      runtime: { collage_message_id: 1, text_message_id: 1 },
    }),
    /Telegram preview file ids are missing/u,
  );
});

test('work image pipeline uses one unified edit pass without quality gate', async () => {
  const ctx = createService();
  const prompts = await ctx.service.promptConfig.refresh();

  const result = await ctx.service.processSingleWorkAsset({
    fileId: 'qa-large',
    prompts,
    jobId: 'JOB-QA',
    index: 0,
    revision: 1,
    renderMode: 'separate',
    sourceAssetCount: 1,
    logContext: {
      chatId: 10,
      userId: 20,
      queueId: 'QUE-QA',
      collectionId: 'COL-QA',
    },
  });

  assert.ok(result.asset?.buffer);
  assert.deepEqual(
    ctx.openrouter.imageCalls.map((call) => call.metadata?.pass),
    ['edit_blur'],
  );
  assert.equal(ctx.openrouter.textCalls.filter((call) => call.metadata?.pass === 'quality_gate').length, 0);
  assert.ok(ctx.botLogger.entries.some((entry) => entry.event === 'image_edit_completed'));
});

test('work image pipeline switches to neutral background variant from locked facts', async () => {
  const ctx = createService();
  const prompts = await ctx.service.promptConfig.refresh();

  const result = await ctx.service.processSingleWorkAsset({
    fileId: 'neutral-bg-large',
    prompts,
    jobId: 'JOB-NEUTRAL-BG',
    index: 0,
    revision: 1,
    renderMode: 'separate',
    sourceAssetCount: 1,
    consistencyNotes: 'BACKGROUND_POLICY\nNEUTRAL_LIGHT_BACKGROUND\nCAMERA_LEVEL = TRUE\nSUBJECT_PRIORITY = HAIRCUT_DOMINANT',
    logContext: {
      chatId: 11,
      userId: 21,
      queueId: 'QUE-NEUTRAL-BG',
      collectionId: 'COL-NEUTRAL-BG',
    },
  });

  assert.ok(result.asset?.buffer);
  assert.deepEqual(
    ctx.openrouter.imageCalls.map((call) => call.metadata?.pass),
    ['edit_neutral'],
  );
  assert.match(String(ctx.openrouter.imageCalls[0]?.prompt ?? ''), /neutral light background/u);
  assert.match(String(ctx.openrouter.imageCalls[0]?.prompt ?? ''), /75-85% of the frame|about 80% of the frame/u);
});

test('single-photo first-pass provider failure degrades to local emergency enhancement', async () => {
  const ctx = createService();
  const prompts = await ctx.service.promptConfig.refresh();
  ctx.openrouter.generateImages = async () => {
    const error = new Error('openrouter returned no images');
    error.name = 'ProviderEmptyResultError';
    throw error;
  };

  const result = await ctx.service.processSingleWorkAsset({
      fileId: 'provider-empty-large',
      prompts,
      jobId: 'JOB-FIRST-PASS-DEGRADE',
      index: 0,
      revision: 1,
      renderMode: 'separate',
      promptMode: 'normal',
      backgroundMode: 'keep',
      cleanupMode: 'off',
      sourceAssetCount: 1,
      logContext: {
        chatId: 16,
      userId: 26,
      queueId: 'QUE-FIRST-PASS-DEGRADE',
      collectionId: 'COL-FIRST-PASS-DEGRADE',
    },
  });

  assert.ok(result.asset?.buffer);
  assert.equal(result.asset.mimeType, 'image/jpeg');
  assert.ok(ctx.botLogger.entries.some((entry) => entry.event === 'image_provider_first_pass_failed' && entry.status === 'degraded_accept'));
  assert.ok(ctx.botLogger.entries.some((entry) => entry.event === 'image_provider_degraded_fallback_applied'));
});

test('single-photo provider failure does not hide neutral background request behind local fallback', async () => {
  const ctx = createService();
  const prompts = await ctx.service.promptConfig.refresh();
  ctx.openrouter.generateImages = async () => {
    const error = new Error('openrouter returned no images');
    error.name = 'ProviderEmptyResultError';
    throw error;
  };

  await assert.rejects(
    () => ctx.service.processSingleWorkAsset({
      fileId: 'provider-empty-neutral-large',
      prompts,
      jobId: 'JOB-FIRST-PASS-NEUTRAL-FAIL',
      index: 0,
      revision: 1,
      renderMode: 'separate',
      promptMode: 'normal',
      backgroundMode: 'neutral',
      cleanupMode: 'off',
      sourceAssetCount: 1,
      logContext: {
        chatId: 17,
        userId: 27,
        queueId: 'QUE-FIRST-PASS-NEUTRAL-FAIL',
        collectionId: 'COL-FIRST-PASS-NEUTRAL-FAIL',
      },
    }),
    /returned no images/u,
  );

  assert.ok(ctx.botLogger.entries.some((entry) => entry.event === 'image_provider_first_pass_failed' && entry.status === 'failed'));
  assert.ok(!ctx.botLogger.entries.some((entry) => entry.event === 'image_provider_degraded_fallback_applied'));
});

test('neutral background retries once with compact prompt when provider returns no images', async () => {
  const ctx = createService();
  const prompts = await ctx.service.promptConfig.refresh();
  let callCount = 0;
  ctx.openrouter.generateImages = async (payload) => {
    callCount += 1;
    if (callCount === 1) {
      const error = new Error('openrouter returned no images');
      error.name = 'ProviderEmptyResultError';
      throw error;
    }
    return {
      images: ['data:image/jpeg;base64,aGVsbG8='],
      durationMs: 123,
      prompt: payload?.prompt ?? '',
    };
  };

  const result = await ctx.service.processSingleWorkAsset({
    fileId: 'provider-empty-neutral-retry-large',
    prompts,
    jobId: 'JOB-NEUTRAL-RETRY',
    index: 0,
    revision: 1,
    renderMode: 'separate',
    promptMode: 'normal',
    backgroundMode: 'neutral',
    cleanupMode: 'off',
    sourceAssetCount: 1,
    logContext: {
      chatId: 18,
      userId: 28,
      queueId: 'QUE-NEUTRAL-RETRY',
      collectionId: 'COL-NEUTRAL-RETRY',
    },
  });

  assert.ok(result.asset?.buffer);
  assert.equal(callCount, 2);
  assert.ok(ctx.botLogger.entries.some((entry) => entry.event === 'image_provider_retry_started'));
  assert.ok(ctx.botLogger.entries.some((entry) => entry.event === 'image_provider_retry_succeeded'));
});

test('blur cleanup and test mode are combined into one final work prompt', async () => {
  const ctx = createService();
  const prompts = await ctx.service.promptConfig.refresh();

  const result = await ctx.service.processSingleWorkAsset({
    fileId: 'blur-cleanup-large',
    prompts,
    jobId: 'JOB-BLUR-CLEANUP',
    index: 0,
    revision: 1,
    renderMode: 'separate',
    promptMode: 'test',
    backgroundMode: 'blur',
    cleanupMode: 'on',
    sourceAssetCount: 1,
    logContext: {
      chatId: 19,
      userId: 29,
      queueId: 'QUE-BLUR-CLEANUP',
      collectionId: 'COL-BLUR-CLEANUP',
    },
  });

  assert.ok(result.asset?.buffer);
  assert.deepEqual(
    ctx.openrouter.imageCalls.map((call) => call.metadata?.pass),
    ['edit_blur'],
  );
  const prompt = String(ctx.openrouter.imageCalls[0]?.prompt ?? '');
  assert.match(prompt, /extremely strong creamy blur|extremely strong soft blur/u);
  assert.match(prompt, /Cleanup rule:/u);
  assert.match(prompt, /Combined blur plus cleanup rule:|When blur and cleanup are both selected/u);
  assert.match(prompt, /Test mode:|subtle professional contour relight/u);
});

test('brow before-after mode uses two brow passes and preserves brows subject prompt branch', async () => {
  const ctx = createService();
  const prompts = await ctx.service.promptConfig.refresh();

  const result = await ctx.service.processSingleWorkAsset({
    fileId: 'brow-before-after-large',
    prompts,
    jobId: 'JOB-BROW-BEFORE-AFTER',
    index: 0,
    revision: 1,
    renderMode: 'separate',
    promptMode: 'normal',
    subjectType: 'brows',
    browOutputMode: 'before_after',
    backgroundMode: 'neutral',
    cleanupMode: 'off',
    sourceAssetCount: 1,
    logContext: {
      chatId: 20,
      userId: 30,
      queueId: 'QUE-BROW-BEFORE-AFTER',
      collectionId: 'COL-BROW-BEFORE-AFTER',
    },
  });

  assert.ok(result.asset?.buffer);
  assert.deepEqual(
    ctx.openrouter.imageCalls.map((call) => call.metadata?.pass),
    ['brow_edit_neutral', 'brow_edit_neutral_before'],
  );
  assert.match(String(ctx.openrouter.imageCalls[0]?.prompt ?? ''), /AFTER state|permanent makeup|перманент/u);
  assert.match(String(ctx.openrouter.imageCalls[1]?.prompt ?? ''), /BEFORE state|sparser|less tidy/u);
});

test('single-photo completed preview shows one-photo mode label instead of collage', async () => {
  const ctx = createService();

  await ctx.service.handleTelegramUpdate({
    update_id: 1950,
    message: { message_id: 1950, text: '/work', chat: { id: 511 }, from: { id: 42 } },
  });
  await chooseWorkPhotoType(ctx, {
    chatId: 511,
    userId: 42,
    action: 'work_photo_type_normal',
    updateId: 1951,
    callbackId: 'cb-work-photo-type-single-preview',
  });
  await ctx.service.handleTelegramUpdate({
    update_id: 1952,
    message: {
      message_id: 1952,
      chat: { id: 511 },
      from: { id: 42 },
      photo: [
        { file_id: 'single-preview-small', file_unique_id: 'single-preview-small-u', width: 100, height: 100 },
        { file_id: 'single-preview-large', file_unique_id: 'single-preview-large-u', width: 1000, height: 1000 },
      ],
    },
  });

  await expireOnlyCollection(ctx);
  await ctx.service.runCollectionFinalizer();

  await chooseHairSubjectIfNeeded(ctx, {
    chatId: 511,
    userId: 42,
    updateId: 1953,
    callbackId: 'cb-single-preview-subject',
  });
  await chooseRuntimeAction(ctx, {
    chatId: 511,
    userId: 42,
    action: 'background_mode_blur',
    updateId: 1954,
    callbackId: 'cb-single-preview-background',
  });
  await chooseRuntimeAction(ctx, {
    chatId: 511,
    userId: 42,
    action: 'cleanup_off',
    updateId: 1955,
    callbackId: 'cb-single-preview-cleanup',
  });
  const sentTexts = allSentTexts(ctx.bot);
  assert.ok(sentTexts.some((text) => text.includes('Режим: одно фото')));
  assert.ok(!sentTexts.some((text) => text.includes('Режим: коллаж')));
});

test('collage compose pass receives selected background and cleanup rules without test-mode branch', async () => {
  const ctx = createService();

  await ctx.service.handleTelegramUpdate({
    update_id: 1960,
    message: { message_id: 1960, text: '/work', chat: { id: 512 }, from: { id: 43 } },
  });
  await chooseWorkPhotoType(ctx, {
    chatId: 512,
    userId: 43,
    action: 'work_photo_type_normal',
    updateId: 1961,
    callbackId: 'cb-work-prompt-collage-rules',
  });
  await Promise.all([
    ctx.service.handleTelegramUpdate({
      update_id: 1962,
      message: {
        message_id: 1962,
        media_group_id: 'album-collage-rules',
        chat: { id: 512 },
        from: { id: 43 },
        photo: [
          { file_id: 'cr1-small', file_unique_id: 'cr1s', width: 100, height: 100 },
          { file_id: 'cr1-large', file_unique_id: 'cr1l', width: 1000, height: 1000 },
        ],
      },
    }),
    ctx.service.handleTelegramUpdate({
      update_id: 1963,
      message: {
        message_id: 1963,
        media_group_id: 'album-collage-rules',
        chat: { id: 512 },
        from: { id: 43 },
        photo: [
          { file_id: 'cr2-small', file_unique_id: 'cr2s', width: 100, height: 100 },
          { file_id: 'cr2-large', file_unique_id: 'cr2l', width: 1000, height: 1000 },
        ],
      },
    }),
  ]);

  await expireOnlyCollection(ctx);
  await ctx.service.runCollectionFinalizer();

  await chooseHairSubjectIfNeeded(ctx, {
    chatId: 512,
    userId: 43,
    updateId: 1964,
    callbackId: 'cb-collage-rules-subject',
  });
  await chooseRuntimeAction(ctx, {
    chatId: 512,
    userId: 43,
    jobId: 'JOB-CF44542C',
    action: 'render_mode_collage',
    updateId: 1965,
    callbackId: 'cb-collage-rules-mode',
  });
  await chooseRuntimeAction(ctx, {
    chatId: 512,
    userId: 43,
    jobId: 'JOB-CF44542C',
    action: 'background_mode_keep',
    updateId: 1966,
    callbackId: 'cb-collage-rules-bg',
  });
  await chooseRuntimeAction(ctx, {
    chatId: 512,
    userId: 43,
    jobId: 'JOB-CF44542C',
    action: 'cleanup_on',
    updateId: 1967,
    callbackId: 'cb-collage-rules-cleanup',
  });

  const collageCall = ctx.openrouter.imageCalls.find((call) => call.metadata?.pass === 'compose_collage');
  assert.ok(collageCall);
  assert.match(collageCall.prompt, /Final collage background rule:/u);
  assert.match(collageCall.prompt, /Final collage cleanup rule:/u);
  assert.doesNotMatch(collageCall.prompt, /Test mode collage rule:/u);
});

test('empty work caption provider result falls back to deterministic caption', async () => {
  const ctx = createService();
  const prompts = await ctx.service.promptConfig.refresh();
  const originalGenerateText = ctx.openrouter.generateText;
  ctx.openrouter.generateText = async (payload) => {
    if (payload?.metadata?.pass === 'work_caption') {
      const error = new Error('openrouter returned no text');
      error.name = 'ProviderEmptyResultError';
      throw error;
    }
    return originalGenerateText(payload);
  };

  const result = await ctx.service.generateWorkCaptionText({
    prompts,
    sourceAssetCount: 1,
    imageUrls: ['https://example.com/image.jpg'],
    jobId: 'JOB-CAPTION-FALLBACK',
    revision: 1,
    renderMode: 'separate',
    chatId: 15,
    userId: 25,
    queueId: 'QUE-CAPTION-FALLBACK',
    collectionId: 'COL-CAPTION-FALLBACK',
  });

  assert.equal(result.fallback, true);
  assert.match(result.text, /Запись по телефону/i);
  assert.ok(ctx.botLogger.entries.some((entry) => entry.event === 'work_caption_provider_empty'));
});

test('work caption prompt keeps focus on client result and avoids repetitive master-love phrasing', () => {
  const ctx = createService();

  const hairPrompt = ctx.service.buildWorkCaptionUserPrompt(1, { subjectType: 'hair' });
  const browPrompt = ctx.service.buildWorkCaptionUserPrompt(1, { subjectType: 'brows', browOutputMode: 'after_only' });

  assert.match(hairPrompt, /результате для клиента/u);
  assert.match(browPrompt, /результате для клиента/u);
  assert.match(hairPrompt, /Не повторяй формулировки вроде "люблю"/u);
  assert.match(browPrompt, /Не повторяй формулировки вроде "люблю"/u);
  assert.match(hairPrompt, /иногда достаточно 2 коротких строк/u);
});

test('bot logger writes structured rows into bot_logs', async () => {
  const store = new FakeStore();
  const logger = new BotLogger({ store });

  await logger.log({
    event: 'preview_sent',
    stage: 'preview',
    chatId: 1,
    userId: 2,
    jobId: 'JOB-1',
    queueId: 'QUE-1',
    status: 'ok',
    message: 'done',
    payload: { safe: true },
  });

  const rows = await store.getRows(TABLE_NAMES.botLogs);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].event, 'preview_sent');
  assert.equal(rows[0].stage, 'preview');
  assert.match(rows[0].payload_json, /safe/);
});
