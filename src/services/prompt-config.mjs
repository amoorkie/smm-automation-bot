import { DEFAULT_PROMPTS, TABLE_NAMES } from '../config/defaults.mjs';

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
    try {
      const rows = await this.store.getRows(TABLE_NAMES.promptConfig);
      for (const row of rows) {
        if (
          row.prompt_key
          && String(row.status ?? '').toLowerCase() === 'active'
          && !isPlaceholderPromptValue(row.prompt_key, row.content)
        ) {
          prompts[row.prompt_key] = row.content || prompts[row.prompt_key] || '';
        }
      }
    } catch {
      // Embedded defaults keep the bot alive during transient storage issues.
    }

    this.cache = {
      value: prompts,
      expiresAt: Date.now() + this.cacheTtlMs,
    };
    return prompts;
  }

  async get(key, fallback = '') {
    const prompts = await this.refresh();
    return prompts[key] || fallback;
  }
}

export default PromptConfigService;
