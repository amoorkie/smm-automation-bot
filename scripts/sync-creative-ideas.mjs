import 'dotenv/config';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  BUSINESS_SHEET_HEADERS,
  SHEET_NAMES,
} from '../src/config/defaults.mjs';
import SupabaseStoreService from '../src/services/supabase-store.mjs';

const EXPECTED_ROW_COUNT = 20;

function required(name, value) {
  const normalized = typeof value === 'string' ? value.trim() : value;
  if (!normalized) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return normalized;
}

function parseCsvLine(line) {
  const values = [];
  let current = '';
  let inQuotes = false;

  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    const next = line[index + 1];

    if (char === '"' && inQuotes && next === '"') {
      current += '"';
      index += 1;
      continue;
    }

    if (char === '"') {
      inQuotes = !inQuotes;
      continue;
    }

    if (char === ',' && !inQuotes) {
      values.push(current);
      current = '';
      continue;
    }

    current += char;
  }

  values.push(current);
  return values.map((value) => value.trim());
}

function parseCsv(text) {
  const normalized = String(text ?? '').replace(/^\uFEFF/u, '').trim();
  if (!normalized) {
    return { header: [], rows: [] };
  }

  const lines = normalized
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean);

  const [headerLine, ...rowLines] = lines;
  const header = parseCsvLine(headerLine);
  const rows = rowLines.map((line) => {
    const values = parseCsvLine(line);
    return Object.fromEntries(header.map((column, index) => [column, values[index] ?? '']));
  });

  return { header, rows };
}

async function main() {
  const scriptDir = path.dirname(fileURLToPath(import.meta.url));
  const csvPath = path.resolve(scriptDir, '../smm_salon_docs/sheets_templates/creative_ideas.csv');
  const csvText = await fs.readFile(csvPath, 'utf8');
  const { header, rows } = parseCsv(csvText);

  const expectedHeader = BUSINESS_SHEET_HEADERS[SHEET_NAMES.creativeIdeas];
  if (header.join('|') !== expectedHeader.join('|')) {
    throw new Error(`Unexpected CSV header. Expected ${expectedHeader.join(', ')}, got ${header.join(', ')}`);
  }

  if (rows.length !== EXPECTED_ROW_COUNT) {
    throw new Error(`Expected exactly ${EXPECTED_ROW_COUNT} creative ideas, got ${rows.length}`);
  }

  const duplicatedTopicIds = rows
    .map((row) => row.topic_id)
    .filter((topicId, index, list) => topicId && list.indexOf(topicId) !== index);
  if (duplicatedTopicIds.length > 0) {
    throw new Error(`Duplicate topic_id values: ${duplicatedTopicIds.join(', ')}`);
  }

  const store = new SupabaseStoreService({
    url: required('SUPABASE_URL', process.env.SUPABASE_URL),
    serviceRoleKey: required('SUPABASE_SERVICE_ROLE_KEY', process.env.SUPABASE_SERVICE_ROLE_KEY),
  });

  const currentRows = await store.getRows(SHEET_NAMES.creativeIdeas);
  const currentTopicIds = new Set(currentRows.map((row) => row.topic_id));
  const nextTopicIds = new Set(rows.map((row) => row.topic_id));

  await store.upsertRowsByColumn(
    SHEET_NAMES.creativeIdeas,
    'topic_id',
    rows,
    BUSINESS_SHEET_HEADERS[SHEET_NAMES.creativeIdeas],
  );

  const rowNumbersToDelete = currentRows
    .filter((row) => !nextTopicIds.has(row.topic_id))
    .map((row) => row.__rowNumber);

  if (rowNumbersToDelete.length > 0) {
    await store.deleteRowsByNumbers(SHEET_NAMES.creativeIdeas, rowNumbersToDelete);
  }

  const insertedCount = rows.filter((row) => !currentTopicIds.has(row.topic_id)).length;
  const updatedCount = rows.length - insertedCount;

  console.log([
    `creative_ideas sync complete`,
    `csv_path=${csvPath}`,
    `upserted=${rows.length}`,
    `inserted=${insertedCount}`,
    `updated=${updatedCount}`,
    `deleted=${rowNumbersToDelete.length}`,
  ].join(' | '));
}

await main();
