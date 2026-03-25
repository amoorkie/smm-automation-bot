export async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

export async function withRetry(task, {
  retries = 2,
  delayMs = 400,
  factor = 2,
  shouldRetry = () => true,
} = {}) {
  let attempt = 0;
  let currentDelay = delayMs;
  while (true) {
    try {
      return await task(attempt);
    } catch (error) {
      if (attempt >= retries || !shouldRetry(error)) {
        throw error;
      }
      await sleep(currentDelay);
      currentDelay *= factor;
      attempt += 1;
    }
  }
}

export async function withTimeout(task, timeoutMs, timeoutMessage = 'Operation timed out') {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(timeoutMessage)), timeoutMs);
  try {
    return await task(controller.signal);
  } finally {
    clearTimeout(timer);
  }
}

export function isRetryableHttpError(error) {
  const message = String(error?.message ?? '');
  return /timed out|ECONNRESET|ENOTFOUND|EAI_AGAIN|429|500|502|503|504/iu.test(message);
}
