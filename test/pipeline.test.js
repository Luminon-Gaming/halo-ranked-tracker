import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runFetch } from '../src/fetch/runFetch.js';
import { createFixtureSource } from '../src/fetch/fixtureSource.js';
import { pickCsrSeason, isAuthError } from '../src/sources/HaloApiSource.js';
import { AuthRequiredError } from '../src/auth/msal.js';
import { DEFAULTS, validateConfig } from '../src/config.js';

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
const paths = { assetsDir: '/nonexistent' };
const now = () => new Date('2026-10-10T10:00:00Z');
const byTag = (data, gt) => data.players.find((p) => p.gamertag.toLowerCase() === gt.toLowerCase());

test('full pipeline on fixtures through the real halo-infinite-api client', async () => {
  const { source, accounts, requests } = await createFixtureSource({ log: quiet });
  const { data, summary, allFailed, xuidCache } = await runFetch({ config: config(), paths, source, accounts, log: quiet, now, downloadAssets: false });
  assert.equal(allFailed, false);
  assert.equal(data.schemaVersion, 1);
  assert.equal(data.csrSeasonId, 'CsrSeason13-3');
  assert.equal(data.players.length, 10);

  // The library wraps bare XUIDs as xuid(...) and sends the season.
  const csrReq = requests.find((u) => u.includes('/csrs?'));
  assert.match(decodeURIComponent(csrReq), /players=xuid\(\d+\),xuid\(\d+\)/);
  assert.match(csrReq, /season=CsrSeason13-3/);

  assert.equal(byTag(data, 'VoidHarbinger').modes.arena.tier, 'Onyx');
  assert.equal(byTag(data, 'TheLastSpartan7#2049').modes.arena.subTier, 2);
  assert.equal(byTag(data, 'WarthogWendy').modes.arena.status, 'placement');
  assert.equal(byTag(data, 'GruntBirthday').modes.arena.status, 'unranked');
  assert.equal(byTag(data, 'PlasmaPilgrim').modes.snipers.status, 'unavailable');
  // Canonical spelling from getUsers replaces the accounts.txt spelling.
  assert.ok(byTag(data, 'Nova Kestrel').gamertag === 'Nova Kestrel');
  // Bad gamertag degrades gracefully.
  const ghost = byTag(data, 'GhostOfReach404');
  assert.equal(ghost.error, 'gamertag_not_found');
  assert.equal(ghost.modes.arena.status, 'error');
  assert.ok(summary.ok > 20);
  assert.equal(xuidCache['nova kestrel'].xuid, '2533274900000002');
});

test('null playlist => unavailable for everyone; rotation flag => not_in_rotation', async () => {
  const { source, accounts } = await createFixtureSource({ log: quiet });
  const c = config();
  c.playlists.doubles = null;
  c.rotation.snipers = false;
  const { data } = await runFetch({ config: c, paths, source, accounts, log: quiet, now, downloadAssets: false });
  for (const p of data.players) assert.equal(p.modes.doubles.status, 'unavailable');
  assert.equal(byTag(data, 'VoidHarbinger').modes.snipers.status, 'not_in_rotation');
  assert.equal(byTag(data, 'VoidHarbinger').modes.snipers.csr, 1372);
  assert.equal(data.modes.snipers.inRotation, false);
});

test('unknown playlist id returns unavailable, not a crash', async () => {
  const { source, accounts } = await createFixtureSource({ log: quiet });
  const c = config();
  c.playlists.slayer = '00000000-0000-0000-0000-000000000000';
  const { data } = await runFetch({ config: c, paths, source, accounts, log: quiet, now, downloadAssets: false });
  assert.equal(byTag(data, 'VoidHarbinger').modes.slayer.status, 'unavailable');
  assert.equal(byTag(data, 'VoidHarbinger').modes.slayer.reason, 'playlist_not_found');
});

test('per-mode failure merges with previous data as stale', async () => {
  const fx = await createFixtureSource({ log: quiet });
  const first = await runFetch({ config: config(), paths, source: fx.source, accounts: fx.accounts, log: quiet, now, downloadAssets: false });
  const flaky = Object.create(fx.source);
  flaky.getPlaylistCsr = async (id, ...rest) => {
    if (id.startsWith('dcb2e24e')) throw Object.assign(new Error('Service Unavailable'), { status: 503 });
    return fx.source.getPlaylistCsr(id, ...rest);
  };
  const second = await runFetch({ config: config(), paths, source: flaky, accounts: fx.accounts, prev: first.data, xuidCache: first.xuidCache, log: quiet, now, downloadAssets: false });
  const p = byTag(second.data, 'VoidHarbinger');
  assert.equal(p.modes.slayer.status, 'ranked');
  assert.equal(p.modes.slayer.stale, true);
  assert.equal(p.stale, true);
  assert.equal(p.modes.arena.stale, undefined);
});

test('every player failing is reported so the caller keeps the old file', async () => {
  const fx = await createFixtureSource({ log: quiet });
  const broken = Object.create(fx.source);
  broken.getUser = async () => { throw Object.assign(new Error('nope'), { status: 404 }); };
  const r = await runFetch({ config: config(), paths, source: broken, accounts: fx.accounts, log: quiet, now, downloadAssets: false });
  assert.equal(r.allFailed, true);
});

test('revoked token aborts the run with an auth error', async () => {
  const fx = await createFixtureSource({ log: quiet });
  const revoked = Object.create(fx.source);
  revoked.getCurrentCsrSeason = async () => { throw new AuthRequiredError(); };
  await assert.rejects(runFetch({ config: config(), paths, source: revoked, accounts: fx.accounts, log: quiet, now, downloadAssets: false }), (e) => isAuthError(e));
});

test('--only refreshes a subset and keeps everyone else', async () => {
  const fx = await createFixtureSource({ log: quiet });
  const first = await runFetch({ config: config(), paths, source: fx.source, accounts: fx.accounts, log: quiet, now, downloadAssets: false });
  const r = await runFetch({ config: config(), paths, source: fx.source, accounts: fx.accounts, prev: first.data, only: ['voidharbinger'], log: quiet, now, downloadAssets: false });
  assert.equal(r.data.players.length, first.data.players.length);
  assert.equal(r.data.players[0].gamertag, 'VoidHarbinger');
});

test('CSR season is picked from the calendar by date (handles the Nov 3, 2026 reset)', () => {
  const cal = { Seasons: [
    { CsrSeasonFilePath: 'CsrSeason13-3.json', StartDate: { ISO8601Date: '2026-08-04T17:00:00Z' }, EndDate: { ISO8601Date: '2026-11-03T17:00:00Z' } },
    { CsrSeasonFilePath: 'Csr/Seasons/CsrSeason14-1.json', StartDate: { ISO8601Date: '2026-11-03T17:00:00Z' }, EndDate: { ISO8601Date: '2027-02-02T18:00:00Z' } },
  ] };
  assert.equal(pickCsrSeason(cal, Date.parse('2026-10-10T00:00:00Z')), 'CsrSeason13-3');
  assert.equal(pickCsrSeason(cal, Date.parse('2026-11-04T00:00:00Z')), 'CsrSeason14-1');
  assert.equal(pickCsrSeason({}, Date.now()), null);
});

test('config validation: unknown keys warn, wrong types error with the key name', () => {
  const ok = validateConfig({ port: 3000, extra: 1, schedule: { cron: '0 6 * * *', oops: true } });
  assert.equal(ok.errors.length, 0);
  assert.equal(ok.warnings.length, 2);
  assert.equal(ok.config.throttle.csrBatchSize, 25);
  const bad = validateConfig({ port: '3000', throttle: { concurrency: 1.5 }, playlists: { arena: 5 }, emblemSource: 'banner' });
  assert.equal(bad.errors.length, 4);
  assert.ok(bad.errors.some((e) => e.includes('"port"')));
  assert.ok(bad.errors.some((e) => e.includes('"throttle.concurrency"')));
  assert.ok(bad.errors.some((e) => e.includes('"playlists.arena"')));
  assert.ok(bad.errors.some((e) => e.includes('"emblemSource"')));
});
