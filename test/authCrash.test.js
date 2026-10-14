import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const sourceUrl = new URL('../src/sources/HaloApiSource.js', import.meta.url).href;
const configUrl = new URL('../src/config.js', import.meta.url).href;

// Runs `body` in a fresh Node process (an unhandled rejection kills the whole process, which would take the test runner with it).
function runChild(body) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'halo-auth-'));
  const script = `
    import { HaloApiSource, isAuthError } from ${JSON.stringify(sourceUrl)};
    import { DEFAULTS } from ${JSON.stringify(configUrl)};
    const paths = { msalCache: ${JSON.stringify(path.join(dir, 'msal.json'))}, haloTokens: ${JSON.stringify(path.join(dir, 'halo-tokens.json'))} };
    const quiet = { info() {}, warn() {}, error() {} };
    ${body}
  `;
  try {
    return spawnSync(process.execPath, ['--input-type=module', '-e', script], {
      env: { ...process.env, HALO_AZURE_CLIENT_ID: '00000000-0000-0000-0000-000000000000', HALO_SPARTAN_TOKEN: '' },
      encoding: 'utf8',
      timeout: 20_000,
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('signed-out API calls reject cleanly instead of crashing the process', () => {
  const r = runChild(`
    const source = HaloApiSource.create({ config: structuredClone(DEFAULTS), paths, log: quiet });
    let caught = 0;
    for (let i = 0; i < 2; i++) {
      try { await source.getCurrentCsrSeason(); } catch (e) { if (isAuthError(e)) caught++; }
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
    console.log('caught=' + caught);
  `);
  assert.equal(r.status, 0, `child exited ${r.status}\n${r.stderr}`);
  assert.match(r.stdout, /caught=2/);
});

test('unrelated unhandled rejections still crash the process', () => {
  const r = runChild(`
    HaloApiSource.create({ config: structuredClone(DEFAULTS), paths, log: quiet });
    Promise.reject(new Error('real bug'));
    await new Promise((resolve) => setTimeout(resolve, 50));
    console.log('survived');
  `);
  assert.notEqual(r.status, 0);
  assert.doesNotMatch(r.stdout, /survived/);
  assert.match(r.stderr, /real bug/);
});
