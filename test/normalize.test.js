import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  normalizeCsr, normalizeResult, displaySubTier, progressPct, tierIconName, placementIconName, allTierIconNames, mergePlayers, errorMode, summarize, unwrapXuid,
} from '../src/fetch/normalize.js';

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const fx = (n) => JSON.parse(fs.readFileSync(path.join(dir, `csr-${n}.json`), 'utf8'));

test('known example: CSR 997 Platinum SubTier 1 => Platinum 2', () => {
  const m = normalizeCsr(fx('platinum-997'));
  assert.equal(m.status, 'ranked');
  assert.equal(m.csr, 997);
  assert.equal(m.tier, 'Platinum');
  assert.equal(m.subTier, 2);
  assert.equal(m.tierStartCsr, 950);
  assert.equal(m.nextTier, 'Platinum');
  assert.equal(m.nextSubTier, 3);
  assert.equal(m.nextTierCsr, 1000);
  assert.equal(m.progressPct, 94);
  assert.equal(m.tierIconUrl, '/tiers/platinum_2.png');
  assert.equal(m.peakCsr, 1032);
  assert.equal(m.peakSubTier, 3);
  assert.equal(m.allTimePeakCsr, 1180);
});

test('SubTier is 0-indexed in the API and stored 1-indexed', () => {
  assert.equal(displaySubTier('Gold', 0), 1);
  assert.equal(displaySubTier('Diamond', 5), 6);
  assert.equal(displaySubTier('Onyx', 0), null);
  assert.equal(normalizeCsr(fx('silver')).subTier, 1);
  assert.equal(normalizeCsr(fx('diamond-6')).subTier, 6);
});

test('Onyx: no sub-tier, no next tier, no progress', () => {
  const m = normalizeCsr(fx('onyx'));
  assert.equal(m.status, 'ranked');
  assert.equal(m.tier, 'Onyx');
  assert.equal(m.subTier, null);
  assert.equal(m.nextTier, null);
  assert.equal(m.nextTierCsr, null);
  assert.equal(m.progressPct, null);
  assert.equal(m.tierIconUrl, '/tiers/onyx_1.png');
  assert.equal(normalizeCsr(fx('onyx-edge')).csr, 1500);
});

test('Diamond 6 points at Onyx with no sub-tier', () => {
  const m = normalizeCsr(fx('diamond-6'));
  assert.equal(m.nextTier, 'Onyx');
  assert.equal(m.nextSubTier, null);
  assert.equal(m.nextTierCsr, 1500);
  assert.equal(m.progressPct, 76);
});

test('placement: matches remaining > 0 with matches played', () => {
  const m = normalizeCsr(fx('placement'));
  assert.equal(m.status, 'placement');
  assert.equal(m.matchesRemaining, 3);
  assert.equal(m.matchesPlayed, 2);
  assert.equal(m.csr, null);
  assert.equal(m.tierIconUrl, '/tiers/unranked_2.png');
  assert.equal(m.allTimePeakCsr, 1290);
});

test('unranked: Value -1 sentinel with no placements started, and Tier "Unranked"', () => {
  const a = normalizeCsr(fx('unranked'));
  assert.equal(a.status, 'unranked');
  assert.equal(a.tierIconUrl, '/tiers/unranked_0.png');
  assert.equal(a.peakCsr, null);
  const b = normalizeCsr(fx('unranked-tier'));
  assert.equal(b.status, 'unranked');
  assert.equal(b.allTimePeakCsr, 1110);
});

test('not_in_rotation keeps data, unavailable/error results', () => {
  const m = normalizeCsr(fx('gold'), { inRotation: false });
  assert.equal(m.status, 'not_in_rotation');
  assert.equal(m.rankStatus, 'ranked');
  assert.equal(m.csr, 712);
  assert.equal(normalizeResult(undefined).status, 'unavailable');
  assert.equal(normalizeResult({ Id: 'xuid(1)', ResultCode: 1, Result: null }).status, 'unavailable');
  assert.equal(normalizeResult({ Id: 'xuid(1)', ResultCode: 0, Result: fx('bronze') }).tier, 'Bronze');
  assert.equal(errorMode('boom').status, 'error');
});

test('progress math is clamped and handles missing next tier', () => {
  assert.equal(progressPct(1372, 1350, 1400), 44);
  assert.equal(progressPct(1350, 1350, 1400), 0);
  assert.equal(progressPct(1420, 1350, 1400), 100);
  assert.equal(progressPct(1300, 1350, 1400), 0);
  assert.equal(progressPct(1734, 1500, null), null);
  assert.equal(progressPct(10, 10, 10), null);
});

test('icon filename mapping', () => {
  assert.equal(tierIconName('Diamond', 1), 'diamond_1');
  assert.equal(tierIconName('bronze', 6), 'bronze_6');
  assert.equal(tierIconName('Onyx', null), 'onyx_1');
  assert.equal(tierIconName('Bronze', 0), null);
  assert.equal(tierIconName('Bronze', 7), null);
  assert.equal(tierIconName('Unranked', 1), null);
  assert.equal(placementIconName(0), 'unranked_0');
  assert.equal(placementIconName(9), 'unranked_5');
  const all = allTierIconNames();
  assert.equal(all.length, 37);
  for (const missing of ['bronze_0', 'bronze_7', 'onyx_2']) assert.ok(!all.includes(missing));
});

test('unwrapXuid', () => {
  assert.equal(unwrapXuid('xuid(2533274900000001)'), '2533274900000001');
  assert.equal(unwrapXuid('2533274900000001'), '2533274900000001');
});

test('merge after a player error keeps last good modes as stale', () => {
  const good = normalizeCsr(fx('diamond'));
  const prev = [{ gamertag: 'A', xuid: '1', emblemUrl: '/assets/1.png', stale: false, error: null, modes: { arena: good, slayer: good } }];
  const next = [{ gamertag: 'A', xuid: '1', emblemUrl: null, stale: false, error: 'csr_request_failed: HTTP 503', modes: { arena: errorMode('x'), slayer: errorMode('x') } }];
  const [p] = mergePlayers(prev, next);
  assert.equal(p.stale, true);
  assert.equal(p.error, 'csr_request_failed: HTTP 503');
  assert.equal(p.modes.arena.csr, 1372);
  assert.equal(p.modes.arena.stale, true);
  assert.equal(p.emblemUrl, '/assets/1.png');
});

test('merge after a single mode error only staleness that mode', () => {
  const good = normalizeCsr(fx('diamond'));
  const prev = [{ gamertag: 'A', xuid: '1', modes: { arena: good, slayer: good } }];
  const next = [{ gamertag: 'A', xuid: '1', emblemUrl: null, stale: false, error: null, modes: { arena: normalizeCsr(fx('gold')), slayer: errorMode('csr_request_failed: HTTP 500') } }];
  const [p] = mergePlayers(prev, next);
  assert.equal(p.modes.arena.csr, 712);
  assert.equal(p.modes.arena.stale, undefined);
  assert.equal(p.modes.slayer.csr, 1372);
  assert.equal(p.modes.slayer.stale, true);
  assert.equal(p.stale, true);
  assert.match(p.error, /slayer/);
});

test('merge: a new player with an error and no history stays an error', () => {
  const [p] = mergePlayers([], [{ gamertag: 'Ghost', xuid: null, stale: false, error: 'gamertag_not_found', modes: { arena: errorMode('gamertag_not_found') } }]);
  assert.equal(p.stale, false);
  assert.equal(p.modes.arena.status, 'error');
  assert.equal(summarize([p]).errors, 1);
});
