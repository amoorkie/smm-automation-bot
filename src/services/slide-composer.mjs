import { readFileSync } from 'node:fs';

import { Resvg } from '@resvg/resvg-js';
import React from 'react';
import sharp from 'sharp';
import satori from 'satori';

const CANVAS_WIDTH = 1080;
const CANVAS_HEIGHT = 1920;
const REGULAR_FONT = readFileSync(new URL('../assets/fonts/NotoSans-Regular.ttf', import.meta.url));
const BOLD_FONT = readFileSync(new URL('../assets/fonts/NotoSans-Bold.ttf', import.meta.url));
const h = React.createElement;

function toLines(value, maxChars = 28, maxLines = 4, { ellipsis = true } = {}) {
  const words = String(value ?? '').trim().split(/\s+/u).filter(Boolean);
  if (words.length === 0) {
    return [];
  }

  const lines = [];
  let current = '';
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (candidate.length <= maxChars) {
      current = candidate;
      continue;
    }
    if (current) {
      lines.push(current);
    }
    current = word;
    if (lines.length >= maxLines) {
      break;
    }
  }

  if (current && lines.length < maxLines) {
    lines.push(current);
  }

  if (ellipsis && lines.length === maxLines && words.join(' ').length > lines.join(' ').length) {
    lines[maxLines - 1] = `${lines[maxLines - 1].slice(0, Math.max(0, maxChars - 3)).trim()}...`;
  }

  return lines;
}

function normalizeBullets(items = [], { maxItems = 5, maxChars = 38, maxLines = 2, ellipsis = true } = {}) {
  return [...(items ?? [])]
    .map((item) => String(item ?? '').trim())
    .filter(Boolean)
    .slice(0, maxItems)
    .map((item) => toLines(item, maxChars, maxLines, { ellipsis }));
}

function getModeStyle(mode) {
  const map = {
    story: {
      fallback: '#8a715f',
      brightness: 0.34,
      saturation: 0.62,
      blurVariants: { clear: 0, light_blur: 6, soft_blur: 12 },
      overlay: 'rgba(7, 6, 6, 0.18)',
      shell: 'rgba(255,255,255,0.02)',
      panel: 'rgba(20, 16, 14, 0.00)',
      footerPanel: 'rgba(16, 13, 12, 0.00)',
      text: '#fffaf5',
      muted: '#f0e6db',
      accent: '#f3c890',
      titleSize: 68,
      bodySize: 36,
      bulletSize: 38,
      eyebrowSize: 26,
      footerSize: 28,
      titleMaxChars: 20,
      titleMaxLines: 4,
      bodyMaxChars: 30,
      bodyMaxLines: 5,
      panelMinHeight: 720,
      bulletMaxLines: 3,
    },
    creative: {
      fallback: '#2f2431',
      brightness: 0.86,
      saturation: 0.82,
      blurVariants: { clear: 0, light_blur: 3, soft_blur: 6 },
      overlay: 'rgba(0, 0, 0, 0.00)',
      shell: 'rgba(255,255,255,0.01)',
      panel: 'rgba(25, 18, 27, 0.00)',
      footerPanel: 'rgba(18, 13, 21, 0.00)',
      text: '#fff7fc',
      muted: '#f4ddea',
      accent: '#ff8cc2',
      titleSize: 78,
      bodySize: 34,
      bulletSize: 38,
      eyebrowSize: 26,
      footerSize: 28,
      titleMaxChars: 16,
      titleMaxLines: 5,
      bodyMaxChars: 24,
      bodyMaxLines: 5,
      panelMinHeight: 700,
      bulletMaxLines: 3,
    },
    slider: {
      fallback: '#624f43',
      brightness: 0.34,
      saturation: 0.58,
      blurVariants: { clear: 0, light_blur: 7, soft_blur: 13 },
      overlay: 'rgba(8, 7, 7, 0.18)',
      shell: 'rgba(255,255,255,0.02)',
      panel: 'rgba(20, 16, 14, 0.00)',
      footerPanel: 'rgba(16, 13, 12, 0.00)',
      text: '#fffaf5',
      muted: '#f1e5d7',
      accent: '#f5ca91',
      titleSize: 64,
      bodySize: 36,
      bulletSize: 38,
      eyebrowSize: 26,
      footerSize: 28,
      titleMaxChars: 20,
      titleMaxLines: 4,
      bodyMaxChars: 30,
      bodyMaxLines: 5,
      panelMinHeight: 860,
      bulletMaxLines: 3,
    },
  };
  return map[mode];
}

function resolveBlur(style, backgroundStyle = 'light_blur') {
  return style.blurVariants?.[backgroundStyle] ?? style.blurVariants?.light_blur ?? 0;
}

async function buildBackground(backgroundAsset, mode, backgroundStyle = 'light_blur') {
  const style = getModeStyle(mode);
  const blurAmount = resolveBlur(style, backgroundStyle);
  const base = backgroundAsset?.buffer
    ? sharp(backgroundAsset.buffer)
    : sharp({
      create: {
        width: CANVAS_WIDTH,
        height: CANVAS_HEIGHT,
        channels: 3,
        background: style.fallback,
      },
    });

  let pipeline = base
    .resize(CANVAS_WIDTH, CANVAS_HEIGHT, { fit: 'cover', position: 'centre' })
    .modulate({ brightness: style.brightness, saturation: style.saturation });

  if (blurAmount > 0) {
    pipeline = pipeline.blur(blurAmount);
  }

  return pipeline.png().toBuffer();
}

function textLineNodes(lines, style, keyPrefix) {
  return lines.map((line, index) => h('div', {
    key: `${keyPrefix}-${index}`,
    style: {
      display: 'flex',
      ...style,
    },
  }, line));
}

function textBlockNode(text, style, key) {
  if (!String(text ?? '').trim()) {
    return null;
  }

  return h('div', {
    key,
    style: {
      display: 'flex',
      width: '100%',
      whiteSpace: 'pre-wrap',
      wordBreak: 'normal',
      ...style,
    },
  }, String(text));
}

function bulletNodes(groups, style) {
  return groups.map((group, groupIndex) => h('div', {
    key: `bullet-${groupIndex}`,
    style: {
      display: 'flex',
      gap: 18,
      width: '100%',
      alignItems: 'flex-start',
    },
  }, [
    h('div', {
      key: `bullet-dot-${groupIndex}`,
      style: {
        display: 'flex',
        width: 14,
        height: 14,
        borderRadius: 999,
        background: style.accent,
        marginTop: 14,
        flexShrink: 0,
      },
    }),
    h('div', {
      key: `bullet-body-${groupIndex}`,
      style: {
        display: 'flex',
        flexDirection: 'column',
        gap: 0,
        flex: 1,
      },
    }, h('div', {
      key: `bullet-line-${groupIndex}`,
      style: {
        display: 'flex',
        width: '100%',
        whiteSpace: 'pre-wrap',
        wordBreak: 'normal',
        fontSize: style.bulletSize,
        lineHeight: 1.28,
        fontWeight: 700,
        color: style.text,
        letterSpacing: 0.1,
        textShadow: '0 2px 12px rgba(0,0,0,0.42)',
      },
    }, Array.isArray(group) ? group.join(' ') : String(group))),
  ]));
}

function spacer(key, size) {
  return h('div', {
    key,
    style: {
      display: 'flex',
      width: '100%',
      height: size,
      flexShrink: 0,
    },
  });
}

function buildSlideTree({ mode, backgroundUrl, eyebrow = '', title = '', bodyParagraphs = [], bulletGroups = [], footer = '', page = null }) {
  const style = getModeStyle(mode);
  const eyebrowLines = toLines(eyebrow, 28, 2, { ellipsis: false });
  const footerText = String(footer ?? '').trim();
  const footerLogicalLines = footerText
    ? footerText.split(/\n+/u).map((line) => line.trim()).filter(Boolean).length
    : 0;
  const footerFontSize = footerLogicalLines > 1 ? Math.max(22, style.footerSize - 4) : style.footerSize;
  const footerHeight = footerText ? Math.min(340, 128 + (footerLogicalLines * 44)) : 0;
  const shellTop = 64;
  const shellLeft = 48;
  const shellWidth = CANVAS_WIDTH - 96;
  const shellHeight = CANVAS_HEIGHT - 128;
  const panelTop = 78;
  const panelLeft = 60;
  const panelWidth = CANVAS_WIDTH - 120;
  const panelHeight = style.panelMinHeight;
  const footerTop = footerText ? CANVAS_HEIGHT - footerHeight - 88 : null;
  const bodyGap = mode === 'slider' ? 56 : 32;
  const titleGap = mode === 'slider' ? 56 : 48;
  const bulletsStartGap = mode === 'slider' ? 56 : 48;
  const bulletGap = mode === 'slider' ? 36 : 30;

  return h('div', {
    style: {
      width: CANVAS_WIDTH,
      height: CANVAS_HEIGHT,
      display: 'flex',
      position: 'relative',
      background: style.fallback,
      fontFamily: 'Noto Sans',
    },
  }, [
    h('img', {
      key: 'background-image',
      src: backgroundUrl,
      width: CANVAS_WIDTH,
      height: CANVAS_HEIGHT,
      style: {
        position: 'absolute',
        top: 0,
        left: 0,
        width: CANVAS_WIDTH,
        height: CANVAS_HEIGHT,
        objectFit: 'cover',
      },
    }),
    h('div', {
      key: 'background-overlay',
      style: {
        display: 'flex',
        position: 'absolute',
        inset: 0,
        background: style.overlay,
      },
    }),
    h('div', {
      key: 'shell',
      style: {
        display: 'flex',
        position: 'absolute',
        left: shellLeft,
        top: shellTop,
        width: shellWidth,
        height: shellHeight,
        borderRadius: 42,
        background: style.shell,
        border: '1px solid rgba(255,255,255,0.16)',
      },
    }),
    h('div', {
      key: 'panel',
      style: {
        display: 'flex',
        flexDirection: 'column',
        position: 'absolute',
        left: panelLeft,
        top: panelTop,
        width: panelWidth,
        height: panelHeight,
        borderRadius: 34,
        background: style.panel,
        paddingTop: 48,
        paddingRight: 52,
        paddingBottom: 52,
        paddingLeft: 52,
      },
    }, [
      h('div', {
        key: 'panel-header',
        style: {
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'flex-start',
          width: '100%',
        },
      }, [
        h('div', {
          key: 'eyebrow-wrap',
          style: {
            display: 'flex',
            flexDirection: 'column',
            gap: 10,
            maxWidth: 760,
          },
        }, textLineNodes(eyebrowLines, {
          fontSize: style.eyebrowSize,
          lineHeight: 1.2,
          fontWeight: 700,
          color: style.accent,
          letterSpacing: 0.4,
          textShadow: '0 2px 8px rgba(0,0,0,0.35)',
        }, 'eyebrow')),
        page
          ? h('div', {
            key: 'page',
            style: {
              display: 'flex',
              fontSize: 28,
              lineHeight: 1,
              fontWeight: 700,
              color: style.muted,
            },
          }, page)
          : null,
      ]),
      spacer('eyebrow-gap', eyebrowLines.length > 0 ? 20 : 8),
      h('div', {
        key: 'title-wrap',
        style: {
          display: 'flex',
          flexDirection: 'column',
          gap: 14,
          width: '100%',
        },
      }, textBlockNode(title, {
        fontSize: style.titleSize,
        lineHeight: 1.08,
        fontWeight: 700,
        color: style.text,
        letterSpacing: 0.2,
        textShadow: '0 2px 14px rgba(0,0,0,0.45)',
      }, 'title')),
      bodyParagraphs.length > 0 ? spacer('title-gap', titleGap) : null,
      h('div', {
        key: 'body-wrap',
        style: {
          display: 'flex',
          flexDirection: 'column',
          gap: bodyParagraphs.length > 0 ? bodyGap : 0,
          width: '100%',
        },
      }, bodyParagraphs.map((paragraph, index) => textBlockNode(paragraph, {
        fontSize: style.bodySize,
        lineHeight: 1.25,
        fontWeight: 500,
        color: style.muted,
        letterSpacing: 0.1,
        textShadow: '0 2px 10px rgba(0,0,0,0.40)',
      }, `body-${index}`)).filter(Boolean)),
      bulletGroups.length > 0 ? spacer('body-gap', bulletsStartGap) : null,
      h('div', {
        key: 'bullet-wrap',
        style: {
          display: 'flex',
          flexDirection: 'column',
          gap: bulletGroups.length > 0 ? bulletGap : 0,
          width: '100%',
        },
      }, bulletNodes(bulletGroups, style)),
    ].filter(Boolean)),
    footerTop !== null
      ? h('div', {
        key: 'footer-panel',
        style: {
          display: 'flex',
          flexDirection: 'column',
          position: 'absolute',
          left: panelLeft,
          top: footerTop,
          width: panelWidth,
          height: footerHeight,
          borderRadius: 28,
          background: style.footerPanel,
          paddingTop: 44,
          paddingRight: 44,
          paddingBottom: 44,
          paddingLeft: 44,
        },
      }, textBlockNode(footerText, {
        fontSize: footerFontSize,
        lineHeight: 1.24,
        fontWeight: 500,
        color: style.muted,
        letterSpacing: 0.1,
        textShadow: '0 2px 10px rgba(0,0,0,0.40)',
      }, 'footer'))
      : null,
  ].filter(Boolean));
}

async function renderSlide({ mode, backgroundAsset, preparedBackground = null, backgroundStyle = 'light_blur', eyebrow, title, body = '', bullets = [], footer = '', page = null }) {
  const style = getModeStyle(mode);
  const background = preparedBackground ?? await buildBackground(backgroundAsset, mode, backgroundStyle);
  const bodyParagraphs = String(body ?? '')
    .split(/\n{2,}|\r\n\r\n/gu)
    .map((item) => item.trim())
    .filter(Boolean);
  const tree = buildSlideTree({
    mode,
    backgroundUrl: `data:image/png;base64,${background.toString('base64')}`,
    eyebrow,
    title,
    bodyParagraphs: bodyParagraphs.length > 0 ? bodyParagraphs : (String(body ?? '').trim() ? [String(body).trim()] : []),
    bulletGroups: normalizeBullets(bullets, {
      maxItems: mode === 'slider' ? (String(page ?? '') === '1' ? 4 : 2) : 4,
      maxChars: mode === 'creative' ? 40 : 120,
      maxLines: style.bulletMaxLines ?? 2,
      ellipsis: false,
    }),
    footer,
    page,
  });

  const svg = await satori(tree, {
    width: CANVAS_WIDTH,
    height: CANVAS_HEIGHT,
    fonts: [
      { name: 'Noto Sans', data: REGULAR_FONT, weight: 400, style: 'normal' },
      { name: 'Noto Sans', data: BOLD_FONT, weight: 700, style: 'normal' },
    ],
  });
  const png = new Resvg(svg, {
    fitTo: { mode: 'width', value: CANVAS_WIDTH },
    background: 'rgba(0,0,0,0)',
  }).render().asPng();

  return {
    buffer: Buffer.from(png),
    mimeType: 'image/png',
  };
}

export async function composeStorySlide({ backgroundAsset = null, manifest = {}, backgroundStyle = 'light_blur' } = {}) {
  return renderSlide({
    mode: 'story',
    backgroundAsset,
    backgroundStyle,
    eyebrow: manifest.eyebrow ?? '',
    title: manifest.title ?? '',
    body: manifest.body ?? manifest.intro ?? '',
    bullets: manifest.bullets ?? [],
    footer: manifest.footer ?? '',
  });
}

export async function composeCreativeSlide({ backgroundAsset = null, manifest = {}, backgroundStyle = 'light_blur' } = {}) {
  return renderSlide({
    mode: 'creative',
    backgroundAsset,
    backgroundStyle,
    eyebrow: manifest.eyebrow ?? '',
    title: manifest.headline ?? manifest.title ?? '',
    body: manifest.subhead ?? manifest.body ?? '',
    bullets: manifest.bullets ?? [],
    footer: manifest.footer ?? '',
  });
}

export async function composeSliderSlides({ backgroundAsset = null, manifest = {}, backgroundStyle = 'light_blur' } = {}) {
  const slides = [];
  const coverTitle = manifest.coverTitle ?? manifest.title ?? '';
  const preparedBackground = await buildBackground(backgroundAsset, 'slider', backgroundStyle);
  slides.push(await renderSlide({
    mode: 'slider',
    backgroundAsset,
    preparedBackground,
    backgroundStyle,
    eyebrow: manifest.eyebrow ?? '',
    title: coverTitle,
    body: manifest.coverSubtitle ?? '',
    bullets: manifest.coverBullets ?? [],
    footer: manifest.footer ?? '',
    page: '1',
  }));

  const contentSlides = [...(manifest.slides ?? [])].slice(0, 4);
  for (const [index, slide] of contentSlides.entries()) {
    slides.push(await renderSlide({
      mode: 'slider',
      backgroundAsset,
      preparedBackground,
      backgroundStyle,
      eyebrow: slide.eyebrow ?? `Шаг ${index + 1}`,
      title: slide.title ?? '',
      body: slide.body ?? '',
      bullets: slide.bullets ?? [],
      footer: slide.footer ?? '',
      page: String(index + 2),
    }));
  }

  return slides.slice(0, 5);
}

export default {
  composeStorySlide,
  composeCreativeSlide,
  composeSliderSlides,
};
