import test from 'node:test';
import assert from 'node:assert/strict';

import sharp from 'sharp';

import {
  composeCreativeSlide,
  composeSliderSlides,
  composeStorySlide,
} from '../src/services/slide-composer.mjs';

async function readDimensions(buffer) {
  const metadata = await sharp(buffer).metadata();
  return {
    width: metadata.width,
    height: metadata.height,
  };
}

test('story slide renderer produces a readable 1080x1920 png for Cyrillic content', async () => {
  const slide = await composeStorySlide({
    manifest: {
      eyebrow: 'Stories',
      title: 'Как не испортить результат после салона',
      body: 'Добрый день, дорогие. Сегодня делюсь простой памяткой, которая реально помогает сохранить результат дольше.',
      bullets: [
        'Не трогайте длину руками слишком часто',
        'Используйте термозащиту перед сушкой',
        'Наносите уход только от середины длины',
      ],
      footer: 'Такие мелочи правда сильно меняют итог.',
    },
  });

  assert.equal(slide.mimeType, 'image/png');
  assert.ok(slide.buffer.length > 20_000);
  const { width, height } = await readDimensions(slide.buffer);
  assert.equal(width, 1080);
  assert.equal(height, 1920);
});

test('slide renderer output changes when text changes', async () => {
  const first = await composeCreativeSlide({
    manifest: {
      headline: 'Когда клиент говорит только кончики',
      subhead: 'А потом показывает фото на минус десять сантиметров',
      bullets: ['Классика', 'Каждый мастер поймёт'],
    },
  });
  const second = await composeCreativeSlide({
    manifest: {
      headline: 'Когда клиент просит сохранить длину',
      subhead: 'И внезапно приносит совсем другой референс',
      bullets: ['Тоже классика', 'Но уже другая сцена'],
    },
  });

  assert.notDeepEqual(first.buffer, second.buffer);
});

test('slider renderer keeps the 3-5 slide contract and page rendering works', async () => {
  const slides = await composeSliderSlides({
    manifest: {
      title: 'Как сохранить холодный оттенок',
      coverSubtitle: 'Короткая инструкция без лишней воды',
      slides: [
        {
          eyebrow: 'Шаг 1',
          title: 'Мойте мягким шампунем',
          body: 'Слишком агрессивное очищение быстрее смывает красивый оттенок.',
          bullets: ['Без сильного скрипа', 'Тёплая, не горячая вода'],
        },
        {
          eyebrow: 'Шаг 2',
          title: 'Добавьте маску или бальзам',
          body: 'Длина должна оставаться напитанной, иначе цвет выглядит тусклее.',
          bullets: ['Наносить по длине', 'Не перегружать корни'],
        },
        {
          eyebrow: 'Шаг 3',
          title: 'Не забывайте про термозащиту',
          body: 'Даже фен без утюжка постепенно сушит волосы, если сушить без защиты.',
          bullets: ['Перед каждой сушкой'],
        },
        {
          eyebrow: 'Шаг 4',
          title: 'Приходите на обновление вовремя',
          body: 'Лучше поддерживать оттенок заранее, чем потом долго выводить нежелательный фон.',
          bullets: ['Не ждать полного вымывания'],
        },
        {
          eyebrow: 'Шаг 5',
          title: 'Этот слайд должен обрезаться',
          body: 'Потому что контракт у режима максимум пять слайдов вместе с обложкой.',
        },
      ],
    },
  });

  assert.equal(slides.length, 5);
  for (const slide of slides) {
    const { width, height } = await readDimensions(slide.buffer);
    assert.equal(width, 1080);
    assert.equal(height, 1920);
  }
});

test('slider renderer supports multi-line glossary footer notes', async () => {
  const slides = await composeSliderSlides({
    manifest: {
      coverTitle: 'Почему длина может быстрее терять свежесть',
      coverSubtitle: 'Коротко о привычках, которые чаще всего это усиливают.',
      footer: 'Себум — это кожный жир, который вырабатывает кожа головы.\nКутикула — это внешний слой волоса, который отвечает за гладкость и блеск.',
      slides: [
        {
          eyebrow: 'Шаг 1',
          title: 'Меньше трогать руками',
          body: 'Когда часто поправляете волосы у лица, длина быстрее собирает лишнее.',
          bullets: ['Начинайте с концов', 'Не дёргайте сухие узлы'],
          footer: 'Себум — это кожный жир, который вырабатывает кожа головы.',
        },
      ],
    },
  });

  assert.equal(slides.length, 2);
  for (const slide of slides) {
    const { width, height } = await readDimensions(slide.buffer);
    assert.equal(width, 1080);
    assert.equal(height, 1920);
  }
});
