import fs from 'node:fs/promises';
import path from 'node:path';
import { loadConfig, MODES, MODE_KEYS, ROOT } from '../config.js';
import { HaloApiSource, isAuthError, statusOf } from '../sources/HaloApiSource.js';
import { writeJsonAtomic } from '../fetch/writeAtomic.js';

const { config, paths } = loadConfig();
let source;
try {
  source = HaloApiSource.create({ config, paths });
} catch (e) {
  console.error(e.message);
  process.exit(1);
}

const rows = [];
const nulled = [];
let authFailed = false;

let season = null;
try {
  season = await source.getCurrentCsrSeason();
} catch (e) {
  if (isAuthError(e)) authFailed = true;
  console.warn(`CSR season lookup failed: ${e.message}`);
}

for (const key of MODE_KEYS) {
  const id = config.playlists[key];
  if (!id) {
    rows.push({ mode: key, expected: MODES[key], id: '(null)', name: '-', csr: '-', result: 'SKIPPED' });
    continue;
  }
  try {
    const info = await source.getPlaylistInfo(id);
    const match = info.name && info.name.toLowerCase().includes(key) ? 'OK' : 'CHECK NAME';
    rows.push({ mode: key, expected: MODES[key], id, name: info.name ?? '?', csr: info.hasCsr ?? '?', result: match });
  } catch (e) {
    if (isAuthError(e)) {
      authFailed = true;
      rows.push({ mode: key, expected: MODES[key], id, name: '-', csr: '-', result: 'AUTH ERROR' });
    } else if (statusOf(e) === 404) {
      nulled.push(key);
      rows.push({ mode: key, expected: MODES[key], id, name: '-', csr: '-', result: 'NOT FOUND → set to null' });
    } else {
      rows.push({ mode: key, expected: MODES[key], id, name: '-', csr: '-', result: `ERROR ${e.message}` });
    }
  }
}

console.log(`\nCurrent CSR season: ${season ?? 'unknown'}\n`);
console.table(rows);

if (nulled.length) {
  const file = path.join(ROOT, 'config.json');
  const raw = JSON.parse(await fs.readFile(file, 'utf8'));
  for (const k of nulled) raw.playlists[k] = null;
  await writeJsonAtomic(file, raw);
  console.log(`\nSet ${nulled.join(', ')} to null in config.json (that mode shows "unavailable").`);
  console.log('To fix: open the mode on https://www.halowaypoint.com/halo-infinite/leaderboards — the playlist GUID is in the URL.');
}
if (authFailed) {
  console.error('\nAuthentication failed. Run "npm run auth" (or refresh HALO_SPARTAN_TOKEN).');
  process.exit(1);
}
