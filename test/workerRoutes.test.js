import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { handleFetch } from '../worker/routes.js';

// wrangler.jsonc is JSONC: drop full-line // comments and trailing // comments outside strings.
const wrangler = JSON.parse(
  readFileSync(new URL('../wrangler.jsonc', import.meta.url), 'utf8')
    .split('\n')
    .map((l) => l.replace(/^(\s*(?:"(?:[^"\\]|\\.)*"|[^"/])*?)\s*\/\/.*$/, '$1'))
    .join('\n'),
);

/**
 * The env the deployed Worker gets with no secrets set: only the vars from wrangler.jsonc and the bindings.
 * VAULT throws if touched, so these tests also prove the Durable Object is never reached while lookup is off.
 */
function noSecretsEnv(vars = wrangler.vars) {
  const assetHits = [];
  const env = {
    ...vars,
    ASSETS: {
      fetch: async (request) => {
        const { pathname } = new URL(request.url);
        assetHits.push(pathname);
        if (pathname === '/') return new Response('<!doctype html><title>dash</title>', { headers: { 'content-type': 'text/html' } });
        if (pathname === '/api/ranks') return new Response('{"schemaVersion":1,"players":[]}', { headers: { 'content-type': 'application/json' } });
        return new Response(null, { status: 404 });
      },
    },
    VAULT: new Proxy({}, { get() { throw new Error('the Durable Object must not be touched while lookup is off'); } }),
    RL_BURST: { limit: async () => { throw new Error('rate limits must not be touched while lookup is off'); } },
    RL_MINUTE: { limit: async () => { throw new Error('rate limits must not be touched while lookup is off'); } },
  };
  return { env, assetHits };
}
const get = (path, init) => new Request(`https://halo.example${path}`, init);

test('wrangler.jsonc ships with lookup switched off and no secrets in vars', () => {
  assert.equal(wrangler.vars.LOOKUP_ENABLED, 'false');
  for (const secret of ['HALO_AZURE_CLIENT_ID', 'HALO_REFRESH_TOKEN_SEED', 'IP_SALT', 'TURNSTILE_SECRET', 'TURNSTILE_SITE_KEY']) {
    assert.equal(secret in wrangler.vars, false, `${secret} must be a secret, not a var`);
  }
  assert.deepEqual(wrangler.assets.run_worker_first, ['/api/player', '/api/avatar/*', '/api/config']);
});

test('lookup off, no secrets: static pages and /api/ranks come from assets', async () => {
  const { env, assetHits } = noSecretsEnv();
  const page = await handleFetch(get('/'), env);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /<title>/);
  const ranks = await handleFetch(get('/api/ranks'), env);
  assert.equal(ranks.status, 200);
  assert.equal((await ranks.json()).schemaVersion, 1);
  assert.deepEqual(assetHits, ['/', '/api/ranks']);
});

test('lookup off, no secrets: /api/player and /api/avatar/* answer lookup_disabled without touching anything', async () => {
  const { env, assetHits } = noSecretsEnv();
  const errors = [];
  const orig = console.error;
  console.error = (...a) => errors.push(a.join(' '));
  try {
    for (const path of ['/api/player?gamertag=DaLuminar', '/api/player', '/api/player?gamertag=%3Cscript%3E', '/api/avatar/2535407908114668']) {
      for (const method of ['GET', 'POST']) {
        const res = await handleFetch(get(path, { method }), env);
        assert.equal(res.status, 503, `${method} ${path}`);
        assert.match(res.headers.get('content-type'), /application\/json/);
        assert.equal(res.headers.get('cache-control'), 'no-store');
        assert.deepEqual(await res.json(), { error: 'lookup_disabled', message: 'Player lookup is switched off on this site.' });
      }
    }
  } finally {
    console.error = orig;
  }
  assert.deepEqual(errors, [], 'nothing was thrown and caught');
  assert.deepEqual(assetHits, []);
});

test('lookup off, no secrets: /api/config says lookup is off and offers no sign-in or challenge', async () => {
  const { env } = noSecretsEnv();
  const res = await handleFetch(get('/api/config'), env);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { lookup: false, turnstileSiteKey: null, signin: null });
});

test('lookup off hides configured sign-in and Turnstile keys too', async () => {
  const { env } = noSecretsEnv({ ...wrangler.vars, HALO_AZURE_CLIENT_ID: 'client-id', TURNSTILE_SECRET: 's', TURNSTILE_SITE_KEY: 'k' });
  assert.deepEqual(await (await handleFetch(get('/api/config'), env)).json(), { lookup: false, turnstileSiteKey: null, signin: null });
});

test('LOOKUP_ENABLED is read leniently: " FALSE " is off, anything else is on', async () => {
  const off = noSecretsEnv({ LOOKUP_ENABLED: ' FALSE ' }).env;
  assert.equal((await handleFetch(get('/api/player?gamertag=Name'), off)).status, 503);
  const on = noSecretsEnv({ LOOKUP_ENABLED: 'true' }).env;
  const cfg = await (await handleFetch(get('/api/config'), on)).json();
  assert.deepEqual(cfg, { lookup: true, turnstileSiteKey: null, signin: null });
});
