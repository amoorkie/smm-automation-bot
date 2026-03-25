import { readFileSync } from 'node:fs';

const TOPIC_SALON_REF_FILES = [
  new URL('../assets/topic-salon-refs/interior-1.png', import.meta.url),
  new URL('../assets/topic-salon-refs/interior-2.png', import.meta.url),
  new URL('../assets/topic-salon-refs/interior-3.png', import.meta.url),
];

function toPngDataUrl(fileUrl) {
  const image = readFileSync(fileUrl);
  return `data:image/png;base64,${image.toString('base64')}`;
}

export const TOPIC_SALON_REFERENCE_IMAGE_URLS = TOPIC_SALON_REF_FILES.map(toPngDataUrl);

export const TOPIC_SALON_INTERIOR_GUIDANCE = [
  'Use the attached salon reference images as the exact room anchor, not just loose inspiration.',
  'Keep the same small real salon with light textured walls, black-and-white checkered floor, black salon chairs, mirrors, simple work surfaces, shelves, and lived-in but tidy beauty interior.',
  'Do not redesign the architecture, do not invent a different room, and do not switch to another salon style.',
  'The safest change is only camera angle, crop, distance, or focus on one object inside the same room.',
  'Treat seasonal decor, certificates, posters, tinsel, and random small objects as incidental details of the references, not mandatory scene elements.',
  'The result should feel like a real salon snapshot on an iPhone, not a perfect studio render.',
].join(' ');
