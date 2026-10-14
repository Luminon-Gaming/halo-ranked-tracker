export const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Limits concurrency and spaces out task starts by at least `delayMs`.
 * Returns schedule(fn) -> Promise of fn's result.
 */
export function createLimiter({ concurrency = 2, delayMs = 0, sleep = defaultSleep, now = Date.now } = {}) {
  let active = 0;
  let nextStartAt = 0;
  const queue = [];

  const pump = () => {
    while (active < concurrency && queue.length) {
      const { fn, resolve, reject } = queue.shift();
      active++;
      const wait = Math.max(0, nextStartAt - now());
      nextStartAt = Math.max(now(), nextStartAt) + delayMs;
      (async () => {
        if (wait > 0) await sleep(wait);
        return fn();
      })()
        .then(resolve, reject)
        .finally(() => {
          active--;
          pump();
        });
    }
  };

  return (fn) =>
    new Promise((resolve, reject) => {
      queue.push({ fn, resolve, reject });
      pump();
    });
}

export function isRetryableStatus(status) {
  return status === 429 || (status >= 500 && status <= 599);
}

/** Parses a Retry-After header (seconds or HTTP date) into milliseconds, or null. */
export function parseRetryAfter(value, now = Date.now()) {
  if (value == null || value === '') return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(value);
  if (Number.isFinite(date)) return Math.max(0, date - now);
  return null;
}

/** Exponential backoff with full jitter on top of the base: base*2^attempt + random(0..base). */
export function backoffDelay(attempt, baseBackoffMs, random = Math.random) {
  return baseBackoffMs * 2 ** attempt + Math.floor(random() * baseBackoffMs);
}

/**
 * Wraps a fetch function with throttling and retries.
 * Retries 429, 5xx and network errors up to maxRetries times, honoring Retry-After.
 * 401 handling lives in halo-infinite-api (it clears the Spartan token and retries once).
 */
export function createThrottledFetch(
  baseFetch,
  { concurrency = 2, delayMs = 500, maxRetries = 4, baseBackoffMs = 1000, sleep = defaultSleep, random = Math.random, log } = {},
) {
  const schedule = createLimiter({ concurrency, delayMs, sleep });
  return async function throttledFetch(input, init) {
    for (let attempt = 0; ; attempt++) {
      let response;
      try {
        response = await schedule(() => baseFetch(input, init));
      } catch (err) {
        if (attempt >= maxRetries || err?.name === 'AbortError') throw err;
        const wait = backoffDelay(attempt, baseBackoffMs, random);
        log?.warn?.(`Network error (${err.message}); retry ${attempt + 1}/${maxRetries} in ${wait}ms`);
        await sleep(wait);
        continue;
      }
      if (!isRetryableStatus(response.status) || attempt >= maxRetries) return response;
      const retryAfter = parseRetryAfter(response.headers.get('retry-after'));
      const wait = retryAfter ?? backoffDelay(attempt, baseBackoffMs, random);
      log?.warn?.(`HTTP ${response.status} from ${hostOf(input)}; retry ${attempt + 1}/${maxRetries} in ${wait}ms`);
      await response.body?.cancel().catch(() => {});
      await sleep(wait);
    }
  };
}

function hostOf(input) {
  try {
    return new URL(typeof input === 'string' ? input : input.url ?? String(input)).host;
  } catch {
    return 'request';
  }
}

export function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}
