import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createLookup, LookupError } from '../src/lookup.js';
import { createServer } from '../src/server.js';
import { createFixtureSource } from '../src/fetch/fixtureSource.js';
import { AuthRequiredError } from '../src/auth/msal.js';
import { DEFAULTS } from '../src/config.js';

const quiet = { info() {}, warn() {}, error() {} };
const config = () => ({
  ...structuredClone(DEFAULTS),
  playlists: {
    arena: 'edfef3ac-9cbe-4fa2-b949-8f29deafd483',
    doubles: 'fa5aa2a3-2428-4912-a023-e1eeea7b877c',
    slayer: 'dcb2e24e-05fb-4390-8076-32a0cdb4326e',
    snipers: '6233381c-fc96-40b9-b1ff-f6a4de72dd7a',
  },
});
const paths = { assetsDir: '/nonexistent', xuidCache: '/nonexistent/xuid-cache.json' };
const now = () => new Date('2026-10-10T10:00:00Z');

async function setup(overrides = {}) {
  const fx = await createFixtureSource({ log: quiet });
  let created = 0;
  const lookup = createLookup({ config: config(), paths, log: quiet, now, getSource: () => { created++; return fx.source; }, ...overrides });
  return { ...fx, lookup, created: () => created };
}

test('looks up one gamertag and returns only that player', async () => {
  const { lookup, requests } = await setup();
  const r = await lookup('  voidharbinger ');
  assert.equal(r.player.gamertag, 'VoidHarbinger');
  assert.equal(r.player.modes.arena.tier, 'Onyx');
  assert.equal(r.csrSeasonId, 'CsrSeason13-3');
  assert.deepEqual(Object.keys(r.modes), ['arena', 'doubles', 'slayer', 'snipers']);
  assert.ok(requests.some((u) => u.includes('/csrs?')));
});

test('answers repeat lookups from a short-lived cache and shares in-flight requests', async () => {
  const { lookup, requests } = await setup();
  const [a, b] = await Promise.all([lookup('VoidHarbinger'), lookup('VOIDHARBINGER')]);
  assert.equal(a, b);
  const first = requests.length;
  await lookup('VoidHarbinger');
  assert.equal(requests.length, first, 'cached: no new requests');
});

test('rejects invalid gamertags before any request or sign-in', async () => {
  const { lookup, created } = await setup();
  for (const bad of ['', '   ', '../etc/passwd', 'a'.repeat(40), 'Name#12345', undefined]) {
    await assert.rejects(lookup(bad), (e) => e instanceof LookupError && e.status === 400 && e.code === 'invalid_gamertag');
  }
  assert.equal(created(), 0);
});

test('an unknown gamertag is a 404', async () => {
  const { lookup } = await setup();
  await assert.rejects(lookup('GhostOfReach404'), (e) => e instanceof LookupError && e.status === 404 && e.code === 'gamertag_not_found');
});

test('an expired sign-in is a 503 asking for npm run auth', async () => {
  const lookup = createLookup({
    config: config(), paths, log: quiet, now,
    getSource: () => ({
      getCurrentCsrSeason: async () => { throw new AuthRequiredError(); },
      getUser: async () => { throw new AuthRequiredError(); },
    }),
  });
  await assert.rejects(lookup('VoidHarbinger'), (e) => e instanceof LookupError && e.status === 503 && /npm run auth/.test(e.message));
});

test('GET /api/player maps results and errors to HTTP', async () => {
  const { lookup } = await setup();
  const server = createServer({ config: config(), paths: { ...paths, dataFile: '/nonexistent/ranks.json', lastAttempt: '/nonexistent/a.json', publicDir: '/nonexistent', assetsDir: '/nonexistent' }, log: quiet, lookup });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const get = (q) => new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: server.address().port, path: `/api/player${q}` }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode, type: res.headers['content-type'], json: JSON.parse(body) }));
    }).on('error', reject);
  });
  try {
    const ok = await get('?gamertag=VoidHarbinger');
    assert.equal(ok.status, 200);
    assert.match(ok.type, /application\/json/);
    assert.equal(ok.json.player.gamertag, 'VoidHarbinger');
    assert.equal((await get('?gamertag=GhostOfReach404')).status, 404);
    const bad = await get('?gamertag=%3Cscript%3E');
    assert.equal(bad.status, 400);
    assert.equal(bad.json.error, 'invalid_gamertag');
    assert.equal((await get('')).status, 400);
  } finally {
    server.close();
  }
});
