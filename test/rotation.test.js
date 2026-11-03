import { test } from 'node:test';
import assert from 'node:assert/strict';
import { localDate, resolveModeRotation, resolveRotation, isWindowList } from '../src/rotation.js';
import { DEFAULTS, validateConfig } from '../src/config.js';

const NY = 'America/New_York';
const cfg = (over = {}) => ({ ...structuredClone(DEFAULTS), ...over });
const snipersAt = (iso, config = cfg()) => resolveRotation(config, new Date(iso), ['arena', 'snipers']).snipers;

test('localDate uses the configured timezone, not UTC', () => {
  // 03:30 UTC on Nov 3 is still Nov 2 in New York.
  assert.equal(localDate(new Date('2026-11-03T03:30:00Z'), NY), '2026-11-02');
  assert.equal(localDate(new Date('2026-11-03T05:30:00Z'), NY), '2026-11-03');
  assert.equal(localDate(new Date('2026-11-03T03:30:00Z'), 'UTC'), '2026-11-03');
});

test('auto: Snipers is live through Nov 2, 2026 and leaves on Nov 3 (local time)', () => {
  const lastDay = snipersAt('2026-11-03T04:59:00Z'); // Nov 2, 11:59 PM EST
  assert.equal(lastDay.inRotation, true);
  assert.equal(lastDay.source, 'auto');
  assert.equal(lastDay.liveUntil, '2026-11-02');

  const morningAfter = snipersAt('2026-11-03T11:00:00Z'); // 6 AM EST daily fetch
  assert.equal(morningAfter.inRotation, false);
  assert.deepEqual(morningAfter.next, { from: '2027-02-02', to: '2027-03-01' });
  assert.equal(morningAfter.liveUntil, null);
  assert.equal(morningAfter.scheduleExhausted, false);
});

test('auto: Snipers comes back Feb 2, 2027 and leaves after Mar 1, 2027', () => {
  assert.equal(snipersAt('2027-02-01T12:00:00Z').inRotation, false);
  assert.equal(snipersAt('2027-02-02T12:00:00Z').inRotation, true);
  assert.equal(snipersAt('2027-03-01T12:00:00Z').inRotation, true);
  const after = snipersAt('2027-03-02T12:00:00Z');
  assert.equal(after.inRotation, false);
  assert.equal(after.scheduleExhausted, true);
});

test('forced true/false in config overrides the schedule', () => {
  const forcedOff = snipersAt('2026-10-10T12:00:00Z', cfg({ rotation: { snipers: false } }));
  assert.equal(forcedOff.inRotation, false);
  assert.equal(forcedOff.source, 'config');
  const forcedOn = snipersAt('2026-12-10T12:00:00Z', cfg({ rotation: { snipers: true } }));
  assert.equal(forcedOn.inRotation, true);
  assert.equal(forcedOn.source, 'config');
});

test('modes without a rotation setting, or auto with no schedule, stay live', () => {
  assert.equal(resolveRotation(cfg(), new Date('2026-12-10T12:00:00Z'), ['arena']).arena.inRotation, true);
  const r = resolveModeRotation('auto', [], '2026-12-10');
  assert.equal(r.inRotation, true);
  assert.equal(r.source, 'default');
});

test('window order in config does not matter', () => {
  const r = resolveModeRotation('auto', [{ from: '2027-02-02', to: '2027-03-01' }, { from: '2026-09-01', to: '2026-11-02' }], '2026-11-03');
  assert.equal(r.inRotation, false);
  assert.deepEqual(r.next, { from: '2027-02-02', to: '2027-03-01' });
});

test('config validation accepts auto + windows and rejects bad values', () => {
  assert.equal(isWindowList(DEFAULTS.rotationSchedule.snipers), true);
  assert.equal(validateConfig({ rotation: { snipers: 'auto' } }).errors.length, 0);
  assert.equal(validateConfig({ rotation: { snipers: false } }).errors.length, 0);
  assert.match(validateConfig({ rotation: { snipers: 'yes' } }).errors[0], /rotation\.snipers/);
  assert.match(validateConfig({ rotationSchedule: { snipers: [{ from: '2026-11-02', to: '2026-09-01' }] } }).errors[0], /rotationSchedule\.snipers/);
  assert.match(validateConfig({ rotationSchedule: { snipers: [{ from: 'Nov 1', to: '2026-12-01' }] } }).errors[0], /rotationSchedule\.snipers/);
  assert.equal(validateConfig({}).config.rotation.snipers, 'auto');
});
