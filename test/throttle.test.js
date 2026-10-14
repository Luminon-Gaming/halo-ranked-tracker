import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createThrottledFetch, parseRetryAfter, backoffDelay, createLimiter, chunk } from '../src/fetch/throttle.js';

const noSleep = () => {
  const calls = [];
  const sleep = async (ms) => { calls.push(ms); };
  return { sleep, calls };
};

test('429 then 200 respects Retry-After', async () => {
  const { sleep, calls } = noSleep();
  const responses = [new Response('slow down', { status: 429, headers: { 'Retry-After': '2' } }), new Response('{"ok":true}', { status: 200 })];
  let n = 0;
  const f = createThrottledFetch(async () => responses[n++], { delayMs: 0, sleep, random: () => 0 });
  const res = await f('https://skill.svc.halowaypoint.com/x');
  assert.equal(res.status, 200);
  assert.equal(n, 2);
  assert.deepEqual(calls, [2000]);
});

test('5xx retries with exponential backoff, then gives up after maxRetries', async () => {
  const { sleep, calls } = noSleep();
  let n = 0;
  const f = createThrottledFetch(async () => { n++; return new Response('', { status: 503 }); }, { delayMs: 0, maxRetries: 3, baseBackoffMs: 100, sleep, random: () => 0 });
  const res = await f('https://x.test/');
  assert.equal(res.status, 503);
  assert.equal(n, 4);
  assert.deepEqual(calls, [100, 200, 400]);
});

test('network errors are retried; 4xx (non-429) are not', async () => {
  const { sleep } = noSleep();
  let n = 0;
  const f = createThrottledFetch(async () => { if (n++ === 0) throw new TypeError('fetch failed'); return new Response('', { status: 404 }); }, { delayMs: 0, sleep });
  assert.equal((await f('https://x.test/')).status, 404);
  assert.equal(n, 2);
});

test('Retry-After parsing and jittered backoff', () => {
  assert.equal(parseRetryAfter('5'), 5000);
  assert.equal(parseRetryAfter(null), null);
  assert.equal(parseRetryAfter(new Date(10_000).toUTCString(), 4_000), 6000);
  assert.equal(backoffDelay(0, 1000, () => 0), 1000);
  assert.equal(backoffDelay(2, 1000, () => 0.5), 4500);
});

test('limiter caps concurrency', async () => {
  const schedule = createLimiter({ concurrency: 2, delayMs: 0 });
  let active = 0, peak = 0;
  const task = () => schedule(async () => { active++; peak = Math.max(peak, active); await new Promise((r) => setTimeout(r, 5)); active--; });
  await Promise.all(Array.from({ length: 8 }, task));
  assert.equal(peak, 2);
  assert.deepEqual(chunk([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
});
