import test from 'node:test';
import assert from 'node:assert/strict';

import BotLogger from '../src/services/bot-logger.mjs';

function createDeferred() {
  let resolve;
  const promise = new Promise((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

test('log awaits storage write by default', async () => {
  const deferred = createDeferred();
  let appendStarted = false;
  const logger = new BotLogger({
    store: {
      async appendRow() {
        appendStarted = true;
        await deferred.promise;
      },
    },
  });

  const logPromise = logger.log({ event: 'sync_write_default', level: 'INFO' });
  await new Promise((resolve) => setTimeout(resolve, 10));

  assert.equal(appendStarted, true);
  let resolved = false;
  logPromise.then(() => {
    resolved = true;
  });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(resolved, false);

  deferred.resolve();
  await logPromise;
});

test('logBestEffort returns before storage write resolves', async () => {
  const deferred = createDeferred();
  let appendStarted = false;
  let appendFinished = false;
  const logger = new BotLogger({
    store: {
      async appendRow() {
        appendStarted = true;
        await deferred.promise;
        appendFinished = true;
      },
    },
  });

  const result = await logger.logBestEffort({ event: 'async_write_best_effort', level: 'INFO' });

  assert.equal(result.event, 'async_write_best_effort');
  assert.equal(appendStarted, true);
  assert.equal(appendFinished, false);

  deferred.resolve();
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(appendFinished, true);
});

