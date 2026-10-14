import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseAccounts, looksLikeGamertag } from '../src/accounts.js';

test('parses, trims, skips comments/blanks, dedupes case-insensitively keeping first spelling', () => {
  const { accounts, warnings } = parseAccounts('# squad\n\n  VoidHarbinger  \nvoidharbinger\nNova Kestrel\r\n   # indented comment\nVOIDHARBINGER\nTheLastSpartan7#2049\n');
  assert.deepEqual(accounts.map((a) => a.gamertag), ['VoidHarbinger', 'Nova Kestrel', 'TheLastSpartan7#2049']);
  assert.equal(warnings.filter((w) => w.includes('duplicate')).length, 2);
});

test('warns on odd-looking gamertags but still keeps them', () => {
  const { accounts, warnings } = parseAccounts('ThisGamertagIsWayTooLong\nbad!name\nOK Tag');
  assert.equal(accounts.length, 3);
  assert.equal(warnings.length, 2);
});

test('gamertag shape check', () => {
  for (const ok of ['a', 'Spartan 117', 'ABCDEFGHIJKLMNO', 'Name#1234']) assert.ok(looksLikeGamertag(ok), ok);
  for (const bad of ['', ' leading', 'ABCDEFGHIJKLMNOP', 'x#12345', 'semi;colon']) assert.ok(!looksLikeGamertag(bad), bad);
});
