import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { Vault, BudgetError, AuthError, limitsFrom } from '../worker/vaultCore.js';
import { parsePlayerRequest, avatarUrlAllowed, crossSiteBlocked, verifyTurnstile, sha256Hex } from '../worker/guard.js';
import { createFixtureFetch, createFixtureSource } from '../src/fetch/fixtureSource.js';
// readFileSync, not `import … with { type: 'json' }`, which needs Node 20.10 and the README promises 20.6.
const config = JSON.parse(readFileSync(new URL('../config.json', import.meta.url), 'utf8'));

// halo-infinite-api parks a rejected promise nobody awaits when a token fetch fails (see HaloApiSource.js); drop only those.
process.on('unhandledRejection', (reason, promise) => {
  if (promise?.constructor?.name === 'ResolvablePromise') return;
  throw reason;
});

const T0 = Date.parse('2026-10-10T10:00:00Z');
const ENV = { HALO_AZURE_CLIENT_ID: 'client-id', HALO_REFRESH_TOKEN_SEED: 'seed-refresh-token' };

/** Same async surface as a Durable Object's ctx.storage, over a Map. */
function fakeStorage() {
  const m = new Map();
  return {
    m,
    get: async (k) => structuredClone(m.get(k)),
    put: async (k, v) => void m.set(k, structuredClone(v)),
    delete: async (k) => (Array.isArray(k) ? k.map((x) => m.delete(x)).some(Boolean) : m.delete(k)),
    list: async ({ prefix = '' } = {}) => new Map([...m].filter(([k]) => k.startsWith(prefix)).map(([k, v]) => [k, structuredClone(v)])),
  };
}
const clock = (start = T0) => {
  const c = { t: start, now: () => c.t, advance: (ms) => (c.t += ms) };
  return c;
};
const jsonRes = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const future = (ms = 3_600_000, base = T0) => new Date(base + ms).toISOString();

/** Vault whose Halo side is the fixture world, skipping the sign-in chain. */
async function fixtureVault(env = {}, c = clock()) {
  const fx = await createFixtureSource({ log: { info() {}, warn() {}, error() {} } });
  let sourceCalls = 0;
  const vault = new Vault({ storage: fakeStorage(), env: { ...ENV, ...env }, config, now: c.now, sourceFactory: () => fx.source });
  return { vault, c, fx, requests: fx.requests, sourceCalls: () => sourceCalls };
}

// --- request validation ---------------------------------------------------------------------------------------------
const req = (qs, init = {}) => new Request(`https://halo.example/api/player${qs}`, init);

test('accepts a plain gamertag and normalizes spacing', () => {
  assert.equal(parsePlayerRequest(req('?gamertag=%20Void%20%20Harbinger%20')).gamertag, 'Void Harbinger');
  assert.equal(parsePlayerRequest(req('?gamertag=TheLastSpartan7%232049')).gamertag, 'TheLastSpartan7#2049');
});

test('rejects bad input before anything else runs', async () => {
  const cases = {
    'no param': ['', 400],
    empty: ['?gamertag=', 400],
    'html': ['?gamertag=%3Cscript%3E', 400],
    'path trick': ['?gamertag=..%2F..%2Fetc', 400],
    'too long': [`?gamertag=${'a'.repeat(41)}`, 400],
    'bad suffix': ['?gamertag=Name%2312345', 400],
    'extra param': ['?gamertag=Name&x=1', 400],
    'duplicate param': ['?gamertag=a&gamertag=b', 400],
  };
  for (const [name, [qs, status]] of Object.entries(cases)) {
    const r = parsePlayerRequest(req(qs)).response;
    assert.equal(r?.status, status, name);
    assert.doesNotMatch(await r.text(), /script|etc/, `${name}: input must not be echoed`);
  }
  assert.equal(parsePlayerRequest(req('?gamertag=Name', { method: 'POST' })).response.status, 405);
  assert.equal(parsePlayerRequest(req('?gamertag=Name'), { LOOKUP_ENABLED: 'false' }).response.status, 503);
});

test('blocks cross-site browser requests, allows same-origin and header-less clients', () => {
  const h = (headers) => req('?gamertag=Name', { headers });
  assert.equal(crossSiteBlocked(h({ 'sec-fetch-site': 'cross-site' })), true);
  assert.equal(crossSiteBlocked(h({ 'sec-fetch-site': 'same-site' })), true);
  assert.equal(crossSiteBlocked(h({ origin: 'https://evil.example' })), true);
  assert.equal(crossSiteBlocked(h({ origin: 'not a url' })), true);
  assert.equal(crossSiteBlocked(h({ 'sec-fetch-site': 'same-origin', origin: 'https://halo.example' })), false);
  assert.equal(crossSiteBlocked(h({})), false);
  assert.equal(parsePlayerRequest(h({ 'sec-fetch-site': 'cross-site' })).response.status, 403);
});

test('avatar URLs must be https on the Xbox image host', () => {
  assert.equal(avatarUrlAllowed('https://images-eds-ssl.xboxlive.com/image?id=1'), true);
  for (const bad of ['http://images-eds-ssl.xboxlive.com/x', 'https://evil.example/x', 'https://xboxlive.com.evil.example/x', 'javascript:alert(1)', 'nope']) {
    assert.equal(avatarUrlAllowed(bad), false, bad);
  }
});

test('turnstile accepts only an explicit success from Cloudflare', async () => {
  const ok = async () => jsonRes({ success: true });
  assert.equal(await verifyTurnstile({ token: 't', secret: 's', ip: '1.2.3.4', fetchFn: ok }), true);
  assert.equal(await verifyTurnstile({ token: '', secret: 's', fetchFn: ok }), false);
  assert.equal(await verifyTurnstile({ token: 't', secret: 's', fetchFn: async () => jsonRes({ success: false }) }), false);
  assert.equal(await verifyTurnstile({ token: 't', secret: 's', fetchFn: async () => { throw new Error('down'); } }), false);
  assert.equal(await verifyTurnstile({ token: 'x'.repeat(3000), secret: 's', fetchFn: ok }), false);
});

// --- lookups, caching and budgets -----------------------------------------------------------------------------------
test('a lookup returns the player and is then served from the cache without touching Halo', async () => {
  const { vault, requests } = await fixtureVault();
  const first = await vault.lookup('VoidHarbinger', 'ip1');
  assert.equal(first.status, 200);
  assert.equal(first.body.player.modes.arena.tier, 'Onyx');
  assert.equal(first.body.csrSeasonId, 'CsrSeason13-3');
  const n = requests.length;
  const second = await vault.lookup('voidharbinger', 'ip2');
  assert.equal(second.status, 200);
  assert.equal(requests.length, n, 'cache hit: no new upstream requests');
});

test('an unknown gamertag is a 404 that is cached too', async () => {
  const { vault, requests } = await fixtureVault();
  const a = await vault.lookup('GhostOfReach404', 'ip1');
  assert.equal(a.status, 404);
  assert.equal(a.body.error, 'gamertag_not_found');
  const n = requests.length;
  assert.equal((await vault.lookup('GhostOfReach404', 'ip2')).status, 404);
  assert.equal(requests.length, n);
});

test('simultaneous lookups of one name share a single upstream run and a single budget slot', async () => {
  const { vault, requests } = await fixtureVault({ LIMIT_UNCACHED_PER_MINUTE: '1' });
  const [a, b, c] = await Promise.all([vault.lookup('VoidHarbinger', 'x'), vault.lookup('VoidHarbinger', 'y'), vault.lookup('voidharbinger', 'z')]);
  assert.deepEqual([a.status, b.status, c.status], [200, 200, 200]);
  assert.equal(requests.filter((u) => u.includes('/users/gt(')).length, 1);
});

test('global per-minute budget caps fresh lookups, then recovers in the next minute', async () => {
  const { vault, c } = await fixtureVault({ LIMIT_UNCACHED_PER_MINUTE: '2' });
  assert.equal((await vault.lookup('VoidHarbinger', 'a')).status, 200);
  assert.equal((await vault.lookup('Nova Kestrel', 'b')).status, 200);
  const third = await vault.lookup('BansheeQueen', 'c');
  assert.equal(third.status, 429);
  assert.ok(third.retryAfter > 0);
  assert.equal(third.body.error, 'busy');
  assert.equal((await vault.lookup('VoidHarbinger', 'a')).status, 200, 'cached names still answer while the budget is spent');
  c.advance(61_000);
  assert.equal((await vault.lookup('BansheeQueen', 'c')).status, 200);
});

test('one visitor cannot spend the whole budget', async () => {
  const { vault } = await fixtureVault({ LIMIT_UNCACHED_PER_IP_PER_HOUR: '2' });
  assert.equal((await vault.lookup('VoidHarbinger', 'same')).status, 200);
  assert.equal((await vault.lookup('Nova Kestrel', 'same')).status, 200);
  assert.equal((await vault.lookup('BansheeQueen', 'same')).status, 429);
  assert.equal((await vault.lookup('BansheeQueen', 'other')).status, 200);
});

test('daily budget stops fresh lookups for the rest of the day', async () => {
  const { vault, c } = await fixtureVault({ LIMIT_UNCACHED_PER_DAY: '1' });
  assert.equal((await vault.lookup('VoidHarbinger', 'a')).status, 200);
  c.advance(2 * 3_600_000);
  const r = await vault.lookup('Nova Kestrel', 'b');
  assert.equal(r.status, 429);
  assert.ok(r.retryAfter >= 900);
});

test('limits come from env and ignore garbage', () => {
  assert.equal(limitsFrom({ LIMIT_UNCACHED_PER_MINUTE: '3' }).uncachedPerMinute, 3);
  assert.equal(limitsFrom({ LIMIT_UNCACHED_PER_MINUTE: 'abc' }).uncachedPerMinute, 30);
  assert.equal(limitsFrom({ LIMIT_UNCACHED_PER_MINUTE: '-5' }).uncachedPerMinute, 30);
  assert.equal(limitsFrom({ LIMIT_UNCACHED_PER_IP_PER_HOUR: '4' }).uncachedPerIpPerHour, 4);
});

// --- breaker --------------------------------------------------------------------------------------------------------
test('an auth failure opens the breaker: later lookups never call Halo again until it expires', async () => {
  const c = clock();
  let calls = 0;
  const failing = { getCurrentCsrSeason: async () => { calls++; throw new AuthError('refresh rejected (invalid_grant)'); }, getUser: async () => { throw new AuthError('x'); } };
  const vault = new Vault({ storage: fakeStorage(), env: ENV, config, now: c.now, sourceFactory: () => failing });
  const a = await vault.lookup('VoidHarbinger', 'a');
  assert.equal(a.status, 503);
  assert.doesNotMatch(JSON.stringify(a.body), /invalid_grant|refresh/, 'upstream detail must not reach the visitor');
  const before = calls;
  for (const name of ['Nova Kestrel', 'BansheeQueen', 'VoidHarbinger']) assert.equal((await vault.lookup(name, 'a')).status, 503);
  assert.equal(calls, before, 'breaker open: no upstream calls');
  c.advance(31 * 60_000);
  await vault.lookup('Nova Kestrel', 'a');
  assert.ok(calls > before, 'after the breaker expires it tries again');
});

test('a Halo 429 inside a player result trips the breaker, but a per-player 403 does not', async () => {
  const c = clock();
  const mk = (errText) => ({
    getCurrentCsrSeason: async () => 'CsrSeason13-3',
    getUser: async () => ({ xuid: '1', gamertag: 'Zed', gamerpic: null }),
    getUsers: async () => [],
    getPlaylistCsr: async () => { throw Object.assign(new Error(errText), { response: { status: Number(errText.slice(-3)) } }); },
  });
  const v429 = new Vault({ storage: fakeStorage(), env: ENV, config, now: c.now, sourceFactory: () => mk('HTTP 429') });
  assert.equal((await v429.lookup('Zed', 'a')).status, 503);
  assert.equal((await v429.lookup('Other', 'a')).status, 503);
  const v403 = new Vault({ storage: fakeStorage(), env: ENV, config, now: c.now, sourceFactory: () => mk('HTTP 403') });
  await v403.lookup('Zed', 'a');
  assert.equal(await v403.storage.get('breaker'), undefined, 'one player must not be able to lock everyone out');
});

// --- the real sign-in chain -----------------------------------------------------------------------------------------
/** Fake Microsoft + Xbox + Halo endpoints; the Halo data side is the fixture world. */
async function chainWorld(c) {
  const fx = await createFixtureFetch();
  const log = [];
  let n = 0;
  const msBodies = [];
  const world = {
    log,
    msBodies,
    ms: { mode: 'ok', expiresIn: 3600 },
    fetchFn: async (input, init = {}) => {
      const url = new URL(typeof input === 'string' ? input : input.url);
      log.push(`${url.hostname}${url.pathname}`);
      if (url.hostname === 'login.microsoftonline.com') {
        msBodies.push(String(init.body));
        if (world.ms.mode === 'invalid_grant') return jsonRes({ error: 'invalid_grant', error_description: 'AADSTS70000 secret-looking-detail' }, 400);
        if (world.ms.mode === '500') return new Response('boom', { status: 500 });
        n++;
        return jsonRes({ access_token: `access-${n}`, refresh_token: `refresh-${n}`, expires_in: world.ms.expiresIn });
      }
      // The library judges token expiry with the real clock, so these expiry stamps must use it too.
      if (url.hostname === 'user.auth.xboxlive.com') return jsonRes({ Token: 'user-token', NotAfter: future(86_400_000, Date.now()), DisplayClaims: { xui: [{ uhs: 'uhs' }] } });
      if (url.hostname === 'xsts.auth.xboxlive.com') return jsonRes({ Token: 'xsts-token', NotAfter: future(86_400_000, Date.now()), DisplayClaims: { xui: [{ uhs: 'uhs' }] } });
      if (url.hostname.startsWith('settings.')) return jsonRes({ SpartanToken: 'spartan-token', ExpiresUtc: { ISO8601Date: future(3_600_000, Date.now()) } });
      world.spartanSeen = new Headers(init.headers).get('x-343-authorization-spartan') ?? world.spartanSeen;
      return fx.fetchFn(input, init);
    },
  };
  return world;
}

test('the full chain works: refresh token -> Xbox -> XSTS -> Spartan token -> a real lookup', async () => {
  const c = clock();
  const w = await chainWorld(c);
  const vault = new Vault({ storage: fakeStorage(), env: ENV, fetchFn: w.fetchFn, config, now: c.now });
  const r = await vault.lookup('VoidHarbinger', 'ip');
  assert.equal(r.status, 200);
  assert.equal(r.body.player.modes.arena.tier, 'Onyx');
  assert.equal(w.spartanSeen, 'spartan-token', 'Halo calls carry the Spartan token');
  const body = new URLSearchParams(w.msBodies[0]);
  assert.equal(body.get('grant_type'), 'refresh_token');
  assert.equal(body.get('refresh_token'), 'seed-refresh-token', 'the first refresh uses the seed');
  assert.equal(body.get('client_id'), 'client-id');
  assert.equal(body.get('scope'), 'XboxLive.signin offline_access');
  // A second, different player reuses every cached token: no extra sign-in traffic.
  const signIn = () => w.log.filter((u) => /microsoftonline|auth\.xboxlive|settings\./.test(u)).length;
  const before = signIn();
  assert.equal((await vault.lookup('Nova Kestrel', 'ip')).status, 200);
  assert.equal(signIn(), before);
});

test('the rotated refresh token is stored and used next time, and the same seed secret never overwrites it', async () => {
  const c = clock();
  const w = await chainWorld(c);
  const storage = fakeStorage();
  const mk = (env = ENV) => new Vault({ storage, env, fetchFn: w.fetchFn, config, now: c.now });
  const a = mk();
  assert.equal(await a.msAccessToken(), 'access-1');
  assert.equal((await storage.get('ms')).refreshToken, 'refresh-1', 'rotated token persisted');
  c.advance(3_500_000); // access token about to expire
  // A fresh isolate (new Vault, same storage and same seed secret) must continue from the rotated token.
  const b = mk();
  assert.equal(await b.msAccessToken(), 'access-2');
  assert.equal(new URLSearchParams(w.msBodies[1]).get('refresh_token'), 'refresh-1');
  // Re-putting a different secret is the way to re-seed.
  c.advance(3_500_000);
  const reseeded = mk({ ...ENV, HALO_REFRESH_TOKEN_SEED: 'brand-new-seed' });
  await reseeded.msAccessToken();
  assert.equal(new URLSearchParams(w.msBodies[2]).get('refresh_token'), 'brand-new-seed');
});

test('concurrent token requests perform one refresh', async () => {
  const c = clock();
  const w = await chainWorld(c);
  const vault = new Vault({ storage: fakeStorage(), env: ENV, fetchFn: w.fetchFn, config, now: c.now });
  const tokens = await Promise.all([vault.msAccessToken(), vault.msAccessToken(), vault.msAccessToken()]);
  assert.deepEqual(new Set(tokens).size, 1);
  assert.equal(w.msBodies.length, 1);
});

test('a rejected refresh token raises AuthError carrying only the error code', async () => {
  const c = clock();
  const w = await chainWorld(c);
  w.ms.mode = 'invalid_grant';
  const vault = new Vault({ storage: fakeStorage(), env: ENV, fetchFn: w.fetchFn, config, now: c.now });
  await assert.rejects(vault.msAccessToken(), (e) => e instanceof AuthError && /invalid_grant/.test(e.message) && !/AADSTS|secret-looking|seed-refresh/.test(e.message));
});

test('a missing seed is an auth failure, not a crash', async () => {
  const vault = new Vault({ storage: fakeStorage(), env: { HALO_AZURE_CLIENT_ID: 'x' }, fetchFn: async () => { throw new Error('should not be called'); }, config });
  await assert.rejects(vault.msAccessToken(), (e) => e instanceof AuthError);
});

// The library parks an unawaited rejected promise when a token fetch fails (the Node tests dodge it the same way:
// authCrash.test.js), so the whole-lookup version of "sign-in fails" runs in its own process.
test('through the real library, a rejected sign-in opens the breaker, stops retrying and leaks nothing', () => {
  const root = new URL('..', import.meta.url).href;
  const script = `
    import { Vault } from ${JSON.stringify(`${root}worker/vaultCore.js`)};
    import { readFileSync } from 'node:fs';
    const config = JSON.parse(readFileSync(new URL(${JSON.stringify(`${root}config.json`)}), 'utf8'));
    process.on('unhandledRejection', (r, p) => { if (p?.constructor?.name !== 'ResolvablePromise') throw r; });
    const m = new Map();
    const storage = { get: async (k) => m.get(k), put: async (k, v) => void m.set(k, v), delete: async () => {}, list: async () => new Map() };
    let ms = 0;
    const fetchFn = async () => { ms++; return new Response(JSON.stringify({ error: 'invalid_grant', error_description: 'AADSTS70000 secret-detail' }), { status: 400 }); };
    const v = new Vault({ storage, env: { HALO_AZURE_CLIENT_ID: 'x', HALO_REFRESH_TOKEN_SEED: 'seed-value' }, config, fetchFn });
    const a = await v.lookup('Zed', 'ip');
    const afterFirst = ms;
    const b = await v.lookup('Other', 'ip');
    await new Promise((r) => setTimeout(r, 50));
    console.log(JSON.stringify({ a: a.status, b: b.status, breaker: m.get('breaker')?.code, retried: ms - afterFirst, leak: /AADSTS|secret-detail|seed-value/.test(JSON.stringify([a, b])) }));
  `;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', timeout: 20_000 });
  assert.equal(r.status, 0, `child exited ${r.status}\n${r.stderr}`);
  assert.deepEqual(JSON.parse(r.stdout.trim().split('\n').pop()), { a: 503, b: 503, breaker: 'auth', retried: 0, leak: false });
});

test('a Microsoft outage is a plain failure, not an auth failure', async () => {
  const c = clock();
  const w = await chainWorld(c);
  w.ms.mode = '500';
  const vault = new Vault({ storage: fakeStorage(), env: ENV, fetchFn: w.fetchFn, config, now: c.now });
  await assert.rejects(vault.msAccessToken(), (e) => !(e instanceof AuthError));
});

// --- egress, upstream budget, avatars, housekeeping -----------------------------------------------------------------
test('tokens can only be sent to Microsoft, Xbox and Halo hosts', async () => {
  const sent = [];
  const vault = new Vault({ storage: fakeStorage(), env: ENV, fetchFn: async (u) => (sent.push(String(u)), jsonRes({})), config });
  await vault.guardedFetch('https://profile.svc.halowaypoint.com/users', {});
  await vault.guardedFetch('https://login.microsoftonline.com/consumers/oauth2/v2.0/token', {});
  for (const bad of ['https://evil.example/', 'http://profile.svc.halowaypoint.com/', 'https://halowaypoint.com.evil.example/', 'https://169.254.169.254/']) {
    await assert.rejects(vault.guardedFetch(bad, {}), /blocked egress/, bad);
  }
  assert.equal(sent.length, 2);
});

test('the upstream cap stops runaway requests mid-run', async () => {
  const vault = new Vault({ storage: fakeStorage(), env: { ...ENV, LIMIT_UPSTREAM_PER_MINUTE: '3' }, fetchFn: async () => jsonRes({}), config });
  for (let i = 0; i < 3; i++) await vault.guardedFetch('https://profile.svc.halowaypoint.com/x', {});
  await assert.rejects(vault.guardedFetch('https://profile.svc.halowaypoint.com/x', {}), BudgetError);
});

test('avatars: only Halo-returned Xbox URLs are stored, and only for numeric ids', async () => {
  const vault = new Vault({ storage: fakeStorage(), env: ENV, config, now: clock().now });
  assert.equal(await vault.emblem({ xuid: '123', sourceUrl: 'https://evil.example/a.png' }), null);
  assert.equal(await vault.avatar('123'), null);
  assert.equal(await vault.emblem({ xuid: '123', sourceUrl: 'https://images-eds-ssl.xboxlive.com/a.png' }), '/api/avatar/123');
  assert.deepEqual(await vault.avatar('123'), { url: 'https://images-eds-ssl.xboxlive.com/a.png' });
  for (const bad of ['abc', '../x', '1'.repeat(30), '']) assert.equal(await vault.avatar(bad), null);
});

test('housekeeping drops expired cache and counters and keeps the cache bounded', async () => {
  const c = clock();
  const vault = new Vault({ storage: fakeStorage(), env: { ...ENV, LIMIT_CACHE_MAX: '2' }, config, now: c.now });
  const cacheKeys = () => [...vault.storage.m.keys()].filter((k) => k.startsWith('c:')).sort();
  await vault.remember('a', 200, {}, 10);
  await vault.remember('b', 200, {}, 20);
  await vault.remember('c', 200, {}, 1000);
  await vault.remember('d', 200, {}, 2000);
  await vault.remember('e', 200, {}, 3000);
  c.advance(60_000); // a and b have expired
  await vault.bump('min', 60_000);
  await vault.prune(c.now());
  assert.deepEqual(cacheKeys(), ['c:d', 'c:e'], 'expired entries dropped, then the soonest-to-expire trimmed to the cap');
  assert.equal([...vault.storage.m.keys()].some((k) => k.startsWith('n:')), true, 'a recent counter survives');
  c.advance(3 * 24 * 3_600_000);
  vault.lastPrune = 0;
  await vault.prune(c.now());
  assert.equal([...vault.storage.m.keys()].some((k) => k.startsWith('n:')), false, 'old counters are gone');
});

test('sha256Hex is stable', async () => {
  assert.equal(await sha256Hex('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
});

// --- regressions found by running the real Worker under wrangler dev -----------------------------------------------------
test('the injected fetch is called unbound (workerd throws "Illegal invocation" otherwise)', async () => {
  const c = clock();
  const w = await chainWorld(c);
  const strict = function (input, init) {
    if (this !== undefined) throw new TypeError('Illegal invocation: function called with incorrect `this` reference');
    return w.fetchFn(input, init);
  };
  const vault = new Vault({ storage: fakeStorage(), env: ENV, fetchFn: strict, config, now: c.now });
  assert.equal((await vault.lookup('VoidHarbinger', 'ip')).status, 200);
});

test('a lookup that produced no usable data is a 502, is never cached, and shows no internal text', async () => {
  const fx = await createFixtureSource({ log: { info() {}, warn() {}, error() {} } });
  const broken = Object.create(fx.source, { getPlaylistCsr: { value: async () => { throw new TypeError('sensitive-internal-detail'); } } });
  const vault = new Vault({ storage: fakeStorage(), env: ENV, config, now: clock().now, sourceFactory: () => broken });
  const r = await vault.lookup('VoidHarbinger', 'ip');
  assert.equal(r.status, 502);
  assert.doesNotMatch(JSON.stringify(r), /sensitive-internal-detail/);
  assert.equal(await vault.storage.get('c:voidharbinger'), undefined, 'failures are not cached');
});

test('a single failing mode keeps the rest of the player and exposes only a code', async () => {
  const fx = await createFixtureSource({ log: { info() {}, warn() {}, error() {} } });
  const snipers = config.playlists.snipers;
  const flaky = Object.create(fx.source, {
    getPlaylistCsr: { value: async (id, ...rest) => { if (id === snipers) throw new TypeError('sensitive-internal-detail'); return fx.source.getPlaylistCsr(id, ...rest); } },
  });
  const vault = new Vault({ storage: fakeStorage(), env: ENV, config, now: clock().now, sourceFactory: () => flaky });
  const r = await vault.lookup('VoidHarbinger', 'ip');
  assert.equal(r.status, 200);
  assert.equal(r.body.player.modes.arena.tier, 'Onyx');
  assert.equal(r.body.player.modes.snipers.status, 'error');
  assert.doesNotMatch(JSON.stringify(r), /sensitive-internal-detail/);
});

// --- re-seeding, secret hygiene, 5xx -------------------------------------------------------------------------------------
test('a new seed clears an open breaker and the old account\'s Halo tokens, so re-seeding takes effect at once', async () => {
  const c = clock();
  const w = await chainWorld(c);
  const storage = fakeStorage();
  const mk = (env) => new Vault({ storage, env, fetchFn: w.fetchFn, config, now: c.now });
  const first = mk(ENV);
  assert.equal((await first.lookup('VoidHarbinger', 'ip')).status, 200);
  assert.ok([...storage.m.keys()].some((k) => k.startsWith('halo:')), 'old account tokens are stored');
  await storage.put('breaker', { code: 'auth', until: c.now() + 30 * 60_000 }); // e.g. "not seeded" before the first seed

  const sameSeed = mk(ENV);
  assert.equal((await sameSeed.lookup('Nova Kestrel', 'ip')).status, 503, 'same credentials: the breaker stays');

  const reseeded = mk({ ...ENV, HALO_REFRESH_TOKEN_SEED: 'seed-for-another-account' });
  await reseeded.ensureSeed();
  assert.equal(await storage.get('breaker'), undefined);
  assert.equal([...storage.m.keys()].some((k) => k.startsWith('halo:')), false, 'old Halo tokens are gone');
  const calls = w.msBodies.length;
  assert.equal((await reseeded.lookup('Nova Kestrel', 'ip')).status, 200);
  assert.equal(new URLSearchParams(w.msBodies[calls]).get('refresh_token'), 'seed-for-another-account');
});

test('secrets with a trailing newline are trimmed before use', async () => {
  const c = clock();
  const w = await chainWorld(c);
  const vault = new Vault({ storage: fakeStorage(), env: { HALO_AZURE_CLIENT_ID: 'client-id\n', HALO_REFRESH_TOKEN_SEED: 'seed-refresh-token\n' }, fetchFn: w.fetchFn, config, now: c.now });
  await vault.msAccessToken();
  const body = new URLSearchParams(w.msBodies[0]);
  assert.equal(body.get('client_id'), 'client-id');
  assert.equal(body.get('refresh_token'), 'seed-refresh-token');
  // And the trimmed and untrimmed forms of one secret count as the same credentials.
  const a = new Vault({ storage: fakeStorage(), env: ENV, config });
  const b = new Vault({ storage: fakeStorage(), env: { ...ENV, HALO_REFRESH_TOKEN_SEED: `${ENV.HALO_REFRESH_TOKEN_SEED}\n` }, config });
  await a.ensureSeed();
  await b.ensureSeed();
  assert.equal(await a.storage.get('seedHash'), await b.storage.get('seedHash'));
});

test('Halo failing with 5xx on every mode pauses lookups briefly instead of hammering it', async () => {
  const c = clock();
  const down = {
    getCurrentCsrSeason: async () => 'CsrSeason13-3',
    getUser: async () => ({ xuid: '1', gamertag: 'Zed', gamerpic: null }),
    getUsers: async () => [],
    getPlaylistCsr: async () => { throw Object.assign(new Error('x'), { response: { status: 503 } }); },
  };
  let calls = 0;
  const vault = new Vault({ storage: fakeStorage(), env: ENV, config, now: c.now, sourceFactory: () => ({ ...down, getUser: async (...a) => (calls++, down.getUser(...a)) }) });
  const r = await vault.lookup('Zed', 'ip');
  assert.equal(r.status, 503);
  assert.equal((await vault.storage.get('breaker')).code, 'halo_5xx');
  const n = calls;
  assert.equal((await vault.lookup('Other', 'ip')).status, 503);
  assert.equal(calls, n, 'no further Halo calls while paused');
  c.advance(61_000);
  await vault.lookup('Other', 'ip');
  assert.ok(calls > n, 'tries again after a minute');
});
