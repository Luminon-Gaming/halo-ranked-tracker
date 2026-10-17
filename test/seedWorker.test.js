import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { extractRefreshToken } from '../src/auth/refreshToken.js';

const cache = {
  Account: {},
  RefreshToken: {
    a: { home_account_id: 'acct-A', secret: 'refresh-for-A' },
    b: { home_account_id: 'acct-B', secret: 'refresh-for-B' },
  },
};

test('picks the refresh token of the requested account only', () => {
  assert.equal(extractRefreshToken(JSON.stringify(cache), 'acct-B'), 'refresh-for-B');
  assert.equal(extractRefreshToken(cache, 'acct-A'), 'refresh-for-A');
  assert.equal(extractRefreshToken(cache, 'acct-Z'), null, 'never falls back to another account');
});

test('returns null for caches without a refresh token', () => {
  assert.equal(extractRefreshToken({}, 'x'), null);
  assert.equal(extractRefreshToken({ RefreshToken: { a: { home_account_id: 'x' } } }, 'x'), null);
});

test('the seeding command refuses to start without --name and --expect, before any sign-in or upload', () => {
  for (const args of [[], ['--name', 'w'], ['--expect', 'a@b.c']]) {
    const r = spawnSync(process.execPath, ['src/cli/seedWorker.js', ...args], { encoding: 'utf8', timeout: 15_000, env: { ...process.env, HALO_AZURE_CLIENT_ID: '' } });
    assert.equal(r.status, 1, args.join(' '));
    assert.match(r.stderr, /Usage: npm run seed:worker/);
  }
});
