import { DEFAULT_PROMPTS, TABLE_NAMES } from '../config/defaults.mjs';

export const REQUIRED_HAIR_WORK_PROMPT_KEYS = [
  'contact_block',
  'work_album_consistency_extraction',
  'work_image_edit_keep',
  'work_image_edit_blur',
  'work_image_edit_neutral',
  'work_collage_generation',
  'work_caption_generation',
];

export const REQUIRED_BROW_WORK_PROMPT_KEYS = [
  'contact_block',
  'work_brow_consistency_extraction',
  'work_brow_edit_keep',
  'work_brow_edit_blur',
  'work_brow_edit_neutral',
  'work_brow_collage_generation',
  'work_brow_caption_generation',
];

export const REQUIRED_WORK_PROMPT_KEYS = [
  ...new Set([
    ...REQUIRED_HAIR_WORK_PROMPT_KEYS,
    ...REQUIRED_BROW_WORK_PROMPT_KEYS,
  ]),
];

export function getRequiredWorkPromptKeys(subjectType = 'hair') {
  return String(subjectType || '') === 'brows'
    ? [...REQUIRED_BROW_WORK_PROMPT_KEYS]
    : [...REQUIRED_HAIR_WORK_PROMPT_KEYS];
}

function isPlaceholderPromptValue(key, value) {
  const text = String(value ?? '').trim();
  if (!text) {
    return true;
  }
  if (key !== 'contact_block') {
    return false;
  }
  return /\[.*номер.*\]/iu.test(text) || /укажите номер/iu.test(text);
}

export class PromptConfigService {
  constructor({ store, cacheTtlMs = 300_000 }) {
    this.store = store;
    this.cacheTtlMs = cacheTtlMs;
    this.cache = null;
  }

  async refresh(force = false) {
    if (!force && this.cache && this.cache.expiresAt > Date.now()) {
      return this.cache.value;
    }

    const prompts = { ...DEFAULT_PROMPTS };
    const supabaseKeys = new Set();
    try {
      const rows = await this.store.getRows(TABLE_NAMES.promptConfig);
      for (const row of rows) {
        if (
          row.prompt_key
          && String(row.status ?? '').toLowerCase() === 'active'
          && !isPlaceholderPromptValue(row.prompt_key, row.content)
        ) {
          prompts[row.prompt_key] = row.content || prompts[row.prompt_key] || '';
          supabaseKeys.add(String(row.prompt_key));
        }
      }
    } catch {
      // Embedded defaults keep the bot alive during transient storage issues.
    }

    const required = [...REQUIRED_WORK_PROMPT_KEYS];
    const fallbackKeys = required.filter((key) => !supabaseKeys.has(key));

    this.cache = {
      value: prompts,
      meta: {
        requiredWorkKeys: required,
        supabaseWorkKeys: required.filter((key) => supabaseKeys.has(key)),
        fallbackWorkKeys: fallbackKeys,
        missingRequiredWorkKeys: fallbackKeys,
      },
      expiresAt: Date.now() + this.cacheTtlMs,
    };
    return prompts;
  }

  async get(key, fallback = '') {
    const prompts = await this.refresh();
    return prompts[key] || fallback;
  }

  async getWorkPromptCoverage(subjectType = 'hair', force = false) {
    await this.refresh(force);
    const meta = this.cache?.meta ?? {};
    const requiredKeys = getRequiredWorkPromptKeys(subjectType);
    const supabaseKeys = new Set(meta.supabaseWorkKeys ?? []);
    const fallbackKeys = requiredKeys.filter((key) => !supabaseKeys.has(key));
    return {
      requiredKeys,
      supabaseKeys: requiredKeys.filter((key) => supabaseKeys.has(key)),
      fallbackKeys,
      missingRequiredKeys: [...fallbackKeys],
      hasMissingRequiredKeys: Boolean(fallbackKeys.length),
    };
  }
}

export default PromptConfigService;
