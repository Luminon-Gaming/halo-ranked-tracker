import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { writeJsonAtomic, readJson } from '../src/fetch/writeAtomic.js';

test('atomic write replaces the file', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'hrt-'));
  const file = path.join(dir, 'ranks.json');
  await writeJsonAtomic(file, { v: 1 });
  await writeJsonAtomic(file, { v: 2 });
  assert.deepEqual(await readJson(file), { v: 2 });
  assert.deepEqual(await fs.readdir(dir), ['ranks.json']);
});

test('failed write keeps the old file and cleans up the temp file', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'hrt-'));
  const file = path.join(dir, 'ranks.json');
  await writeJsonAtomic(file, { v: 1 });
  const ops = {
    open: (...a) => fs.open(...a),
    unlink: (...a) => fs.unlink(...a),
    mkdir: (...a) => fs.mkdir(...a),
    rename: async () => { throw Object.assign(new Error('disk full'), { code: 'ENOSPC' }); },
  };
  await assert.rejects(writeJsonAtomic(file, { v: 2 }, { ops }), /disk full/);
  assert.deepEqual(await readJson(file), { v: 1 });
  assert.deepEqual(await fs.readdir(dir), ['ranks.json']);
});

test('readJson returns fallback for missing files', async () => {
  assert.equal(await readJson(path.join(os.tmpdir(), 'nope-hrt.json'), 'fb'), 'fb');
});
