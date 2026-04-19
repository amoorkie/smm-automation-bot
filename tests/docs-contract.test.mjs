import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { BUSINESS_SHEET_HEADERS, DEFAULT_PROMPTS } from '../src/config/defaults.mjs';
import { BOT_LOG_COLUMNS } from '../src/workflow-kit.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

function repoPath(...segments) {
  return path.join(repoRoot, ...segments);
}

async function readRepoFile(...segments) {
  return readFile(repoPath(...segments), 'utf8');
}

function parseEnvKeys(text) {
  return text
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'))
    .map((line) => line.split('=')[0]);
}

function parseCsvHeader(text) {
  return text.split(/\r?\n/u)[0].split(',');
}

function parseFirstCsvField(line) {
  const match = line.match(/^(?:"([^"]+)"|([^,]+))/u);
  return match?.[1] ?? match?.[2] ?? '';
}

test('env example stays aligned with current env contract', async () => {
  const envExample = await readRepoFile('smm_salon_docs', 'config', '.env.example');
  const keys = parseEnvKeys(envExample);

  const requiredKeys = [
    'TG_BOT_TOKEN',
    'OPENROUTER_API_KEY',
    'SUPABASE_URL',
    'SUPABASE_SERVICE_ROLE_KEY',
    'IMAGE_MODEL_ID',
    'TEXT_MODEL_ID',
  ];

  const optionalKeys = [
    'OWNER_CHAT_ID',
    'BOT_DISABLED',
    'INTERNAL_WORKER_DISPATCH_ENABLED',
    'TOPIC_SOURCE_STATUS_MUTATIONS_ENABLED',
    'APP_TIMEZONE',
    'WEBHOOK_BASE_URL',
    'PORT',
    'VK_ACCESS_TOKEN',
    'VK_COMMUNITY_ACCESS_TOKEN',
    'VK_GROUP_ID',
    'VK_PUBLISH_ENABLED',
    'VK_CLIENT_ID',
    'VK_CLIENT_SECRET',
    'VK_OAUTH_REDIRECT_URI',
    'VK_OAUTH_SCOPE',
  ];

  for (const key of [...requiredKeys, ...optionalKeys]) {
    assert.ok(keys.includes(key), `Missing env key in docs: ${key}`);
  }

  assert.ok(!keys.includes('MASTER_CONTACT_PHONE'));
  assert.match(envExample, /VERCEL_URL/u);
  assert.match(envExample, /contact_block/u);
});

test('prompt sample covers every active default prompt key', async () => {
  const sample = await readRepoFile('smm_salon_docs', 'samples', 'prompt_config_seed_sample.csv');
  const lines = sample.split(/\r?\n/u).slice(1).filter(Boolean);
  const keys = new Set(lines.map(parseFirstCsvField));
  const optionalLegacyKeys = new Set([
    'creative_manifest_generation',
    'creative_visual_generation',
  ]);

  for (const key of Object.keys(DEFAULT_PROMPTS)) {
    if (optionalLegacyKeys.has(key)) {
      continue;
    }
    assert.ok(keys.has(key), `Missing prompt key in sample: ${key}`);
  }

  assert.ok(!keys.has('schedule_prompt'));
});

test('bot logs header sample stays aligned with BOT_LOG_COLUMNS', async () => {
  const header = await readRepoFile('smm_salon_docs', 'samples', 'bot_logs_header.csv');
  assert.equal(header.trim(), BOT_LOG_COLUMNS.join(','));
});

test('sheet template headers stay aligned with current business table contract', async () => {
  const templateFiles = {
    expert_topics: 'expert_topics.csv',
    story_topics: 'story_topics.csv',
    creative_ideas: 'creative_ideas.csv',
    slider_topics: 'slider_topics.csv',
    content_queue: 'content_queue.csv',
    prompt_templates: 'prompt_config.csv',
    publish_log: 'publish_log.csv',
  };

  for (const [tableName, fileName] of Object.entries(templateFiles)) {
    const csv = await readRepoFile('smm_salon_docs', 'sheets_templates', fileName);
    assert.deepEqual(
      parseCsvHeader(csv),
      BUSINESS_SHEET_HEADERS[tableName],
      `Header mismatch for ${fileName}`,
    );
  }
});

test('core docs reflect the active command and action surface', async () => {
  const spec = await readRepoFile('smm_salon_docs', '01_system_spec.md');
  const bootstrap = await readRepoFile('smm_salon_docs', '02_bot_service_bootstrap.md');

  for (const command of ['/help', '/start', '/work', '/topic', '/stories', '/slider']) {
    assert.match(spec, new RegExp(command.replace('/', '\\/'), 'u'));
  }

  assert.match(spec, /publish_confirm/u);
  for (const action of [
    'work_photo_type_normal',
    'work_photo_type_studio',
    'work_subject_hair',
    'work_subject_brows',
    'render_mode_collage',
    'render_mode_separate',
    'brow_output_before_after',
    'brow_output_after_only',
    'background_mode_keep',
    'background_mode_blur',
    'cleanup_on',
    'cleanup_off',
  ]) {
    assert.match(spec, new RegExp(action, 'u'));
  }
  assert.doesNotMatch(spec, /^- `publish_now`$/mu);
  assert.match(spec, /не поддерживает user-facing `schedule` action/u);
  assert.doesNotMatch(bootstrap, /^- `(?:GET|POST) \/api\/cron\/deliver`$/mu);
  assert.doesNotMatch(bootstrap, /schedule_prompt/u);
  assert.match(bootstrap, /INTERNAL_WORKER_DISPATCH_ENABLED/u);
  assert.match(bootstrap, /story_topics/u);
  assert.match(bootstrap, /creative_ideas/u);
  assert.match(bootstrap, /slider_topics/u);
  assert.match(bootstrap, /runtime-action/u);
  assert.match(bootstrap, /collection-finalize/u);
  assert.match(bootstrap, /x-anita-worker-token/u);
});

test('current docs no longer describe Google SQLite or old env tails as active runtime', async () => {
  const spec = await readRepoFile('smm_salon_docs', '01_system_spec.md');
  const roadmap = await readRepoFile('smm_salon_docs', '03_roadmap_and_doc_governance.md');
  const docsReadme = await readRepoFile('smm_salon_docs', 'README.md');

  for (const text of [spec, roadmap, docsReadme]) {
    assert.doesNotMatch(text, /Google Sheets store business data/u);
    assert.doesNotMatch(text, /Google Drive stores originals/u);
    assert.doesNotMatch(text, /SQLite stores runtime state/u);
    assert.doesNotMatch(text, /better-sqlite3/u);
  }

  assert.doesNotMatch(spec, /\/api\/cron\/deliver/u);
  assert.match(roadmap, /publish/i);
  assert.match(spec, /story_topics/u);
});
