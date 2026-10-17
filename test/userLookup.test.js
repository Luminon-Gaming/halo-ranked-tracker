// Lookups made with the visitor's own Microsoft sign-in (Authorization: Bearer), through the real halo-infinite-api chain
// against faked Xbox and Halo endpoints. Synthetic tokens only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { Vault } from '../worker/vaultCore.js';
import { bearerToken } from '../worker/guard.js';
import { createFixtureFetch } from '../src/fetch/fixtureSource.js';
const config = JSON.parse(readFileSync(new URL('../config.json', import.meta.url), 'utf8'));

process.on('unhandledRejection', (reason, promise) => {
  if (promise?.constructor?.name === 'ResolvablePromise') return;
  throw reason;
});

const T0 = Date.parse('2026-10-10T10:00:00Z');
const TOK_A = 'EwB-token-for-visitor-A-0123456789';
const TOK_B = 'EwB-token-for-visitor-B-0123456789';

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
const jsonRes = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const later = () => new Date(Date.now() + 3_600_000).toISOString(); // the library judges expiry with the real clock

/** Xbox and Halo endpoints whose tokens embed what they were made from, so a test can see whose token reached Halo. */
async function world() {
  const fx = await createFixtureFetch();
  const w = { log: [], spartanSeen: [], rejectUserToken: /^$/ };
  w.fetchFn = async (input, init = {}) => {
    const url = new URL(typeof input === 'string' ? input : input.url);
    w.log.push(url.hostname);
    const body = init.body ? JSON.parse(String(init.body)) : {};
    if (url.hostname === 'user.auth.xboxlive.com') {
      const rps = body.Properties.RpsTicket;
      if (w.rejectUserToken.test(rps)) return jsonRes({ error: 'nope' }, 401);
      return jsonRes({ Token: `U(${rps})`, NotAfter: later(), DisplayClaims: { xui: [{ uhs: 'uhs' }] } });
    }
    if (url.hostname === 'xsts.auth.xboxlive.com') return jsonRes({ Token: `X(${body.Properties.UserTokens[0]})`, NotAfter: later(), DisplayClaims: { xui: [{ uhs: 'uhs' }] } });
    if (url.hostname.startsWith('settings.')) return jsonRes({ SpartanToken: `S(${body.Proof[0].Token})`, ExpiresUtc: { ISO8601Date: later() } });
    w.spartanSeen.push(new Headers(init.headers).get('x-343-authorization-spartan'));
    return fx.fetchFn(input, init);
  };
  return w;
}

const mk = async (env = {}) => {
  const w = await world();
  const storage = fakeStorage();
  let t = T0;
  const vault = new Vault({ storage, env, fetchFn: w.fetchFn, config, now: () => t });
  return { w, storage, vault, advance: (ms) => (t += ms) };
};

test('a visitor\'s own token drives the whole chain, and Microsoft is never contacted by the Worker', async () => {
  const { w, vault } = await mk();
  const r = await vault.lookup('VoidHarbinger', 'ip', { token: TOK_A });
  assert.equal(r.status, 200);
  assert.equal(r.body.player.modes.arena.tier, 'Onyx');
  assert.ok(w.spartanSeen.length > 0);
  for (const seen of w.spartanSeen) assert.match(seen, new RegExp(TOK_A), 'Halo calls carry a Spartan token built from this visitor\'s sign-in');
  assert.ok(!w.log.some((h) => /microsoftonline/.test(h)), 'no calls to Microsoft');
});

test('a visitor\'s tokens are never stored: no Halo token keys, no token text anywhere in storage', async () => {
  const { storage, vault } = await mk();
  await vault.lookup('VoidHarbinger', 'ip', { token: TOK_A });
  assert.deepEqual([...storage.m.keys()].filter((k) => k.startsWith('halo:') || k === 'ms'), []);
  assert.doesNotMatch(JSON.stringify([...storage.m]), new RegExp(TOK_A.slice(4, 30)));
});

test('two visitors never share tokens; the cached result of a public player is shared', async () => {
  const { w, vault } = await mk();
  assert.equal((await vault.lookup('VoidHarbinger', 'ip1', { token: TOK_A })).status, 200);
  const seenA = w.spartanSeen.length;
  assert.equal((await vault.lookup('Nova Kestrel', 'ip2', { token: TOK_B })).status, 200);
  const fromB = w.spartanSeen.slice(seenA);
  assert.ok(fromB.length > 0);
  for (const seen of fromB) {
    assert.match(seen, new RegExp(TOK_B));
    assert.doesNotMatch(seen, new RegExp(TOK_A), 'visitor B\'s lookup must not use visitor A\'s token');
  }
  const calls = w.log.length;
  assert.equal((await vault.lookup('voidharbinger', 'ip2', { token: TOK_B })).status, 200, 'cache hit');
  assert.equal(w.log.length, calls, 'and it makes no upstream request');
});

// The library parks an unawaited rejected promise when a token fetch fails (worker.test.js does the same), so the
// failing-sign-in case runs in its own process.
test('a rejected sign-in answers 401 for that visitor only: no breaker, nothing leaked, and the next visitor is unaffected', () => {
  const root = new URL('..', import.meta.url).href;
  const script = `
    import { Vault } from ${JSON.stringify(`${root}worker/vaultCore.js`)};
    import { readFileSync } from 'node:fs';
    const config = JSON.parse(readFileSync(new URL(${JSON.stringify(`${root}config.json`)}), 'utf8'));
    process.on('unhandledRejection', () => {});
    const m = new Map();
    const storage = { get: async (k) => m.get(k), put: async (k, v) => void m.set(k, v), delete: async () => {}, list: async () => new Map() };
    let hosts = [];
    const fetchFn = async (u) => { hosts.push(new URL(String(u)).hostname); return new Response(JSON.stringify({ XErr: 'secret-detail' }), { status: 401 }); };
    const v = new Vault({ storage, env: {}, config, fetchFn });
    const a = await v.lookup('Zed', 'ip1', { token: 'bad-token-0123456789abcdef' });
    const b = await v.lookup('Other', 'ip2', { token: 'another-bad-token-0123456789' });
    await new Promise((r) => setTimeout(r, 50));
    console.log(JSON.stringify({ a: a.status, code: a.body.error, b: b.status, breaker: m.get('breaker')?.code ?? null, leak: /bad-token|secret-detail/.test(JSON.stringify([a, b])), ms: hosts.filter((h) => /microsoftonline/.test(h)).length }));
  `;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', timeout: 20_000 });
  assert.equal(r.status, 0, `child exited ${r.status}\n${r.stderr}`);
  assert.deepEqual(JSON.parse(r.stdout.trim().split('\n').pop()), { a: 401, code: 'signin_required', b: 401, breaker: null, leak: false, ms: 0 });
});

test('the dedicated account\'s sign-in breaker does not block visitors who use their own', async () => {
  const { storage, vault } = await mk();
  await storage.put('breaker', { code: 'auth', until: T0 + 30 * 60_000 });
  assert.equal((await vault.lookup('VoidHarbinger', 'ip', { token: TOK_A })).status, 200);
});

test('a Halo outage or 429 still pauses lookups for everyone, a visitor\'s 429 only for a minute', async () => {
  const { vault, storage, advance } = await mk();
  const failing = {
    getCurrentCsrSeason: async () => 'CsrSeason13-3',
    getUser: async () => ({ xuid: '1', gamertag: 'Zed', gamerpic: null }),
    getUsers: async () => [],
    getPlaylistCsr: async () => { throw Object.assign(new Error('HTTP 429'), { response: { status: 429 } }); },
  };
  vault.sourceFactory = () => failing;
  const r = await vault.lookup('Zed', 'ip', { token: TOK_A });
  assert.equal(r.status, 503);
  assert.equal(r.retryAfter, 60);
  assert.equal((await storage.get('breaker')).code, 'halo_429');
  assert.equal((await vault.lookup('Other', 'ip2', { token: TOK_B })).status, 503);
  advance(61_000);
  vault.sourceFactory = null;
  assert.equal((await vault.lookup('Other', 'ip2', { token: TOK_B })).status, 404, 'recovered (this name is not in the fixture world)');
});

test('each sign-in token has its own hourly allowance, on top of the per-address one', async () => {
  const { vault } = await mk({ LIMIT_UNCACHED_PER_ACCOUNT_PER_HOUR: '1' });
  assert.equal((await vault.lookup('VoidHarbinger', 'ip1', { token: TOK_A })).status, 200);
  const second = await vault.lookup('Nova Kestrel', 'ip2', { token: TOK_A });
  assert.equal(second.status, 429);
  assert.equal((await vault.lookup('Nova Kestrel', 'ip2', { token: TOK_B })).status, 200);
});

test('signed out: only cached players answer, and nobody\'s token is used', async () => {
  const { w, vault } = await mk();
  const miss = await vault.cached('VoidHarbinger');
  assert.equal(miss.status, 401);
  assert.equal(miss.body.error, 'signin_required');
  assert.equal(w.log.length, 0);
  await vault.lookup('VoidHarbinger', 'ip', { token: TOK_A });
  const hit = await vault.cached('voidharbinger');
  assert.equal(hit.status, 200);
  assert.equal(hit.body.player.modes.arena.tier, 'Onyx');
});

test('Authorization header parsing: absent, well-formed, malformed', () => {
  const r = (headers) => bearerToken(new Request('https://x.example/api/player?gamertag=a', { headers }));
  assert.equal(r({}), null);
  assert.deepEqual(r({ authorization: `Bearer ${TOK_A}` }), { token: TOK_A });
  for (const bad of ['Bearer short', `Basic ${TOK_A}`, `Bearer ${TOK_A} extra`, `bearer ${TOK_A}`, 'Bearer ', `Bearer ${'a'.repeat(5000)}`]) {
    assert.deepEqual(r({ authorization: bad }), { invalid: true }, bad.slice(0, 20));
  }
});
