import test from 'node:test';
import assert from 'node:assert/strict';

import {
  PromptConfigService,
  REQUIRED_HAIR_WORK_PROMPT_KEYS,
} from '../src/services/prompt-config.mjs';

test('embedded defaults count as fallback prompt coverage instead of missing work prompts', async () => {
  const service = new PromptConfigService({
    store: {
      async getRows() {
        return [];
      },
    },
    cacheTtlMs: 0,
  });

  const coverage = await service.getWorkPromptCoverage('hair', true);

  assert.deepEqual(coverage.supabaseKeys, []);
  assert.deepEqual(coverage.missingRequiredKeys, []);
  assert.equal(coverage.hasMissingRequiredKeys, false);
  for (const key of REQUIRED_HAIR_WORK_PROMPT_KEYS) {
    assert.ok(coverage.fallbackKeys.includes(key), `Expected fallback coverage for ${key}`);
  }
});
