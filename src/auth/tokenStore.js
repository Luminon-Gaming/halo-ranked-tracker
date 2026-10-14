import fs from 'node:fs/promises';
import path from 'node:path';
import { writeJsonAtomic } from '../fetch/writeAtomic.js';

/**
 * TokenPersister (halo-infinite-api) backed by a single JSON file, chmod 600.
 * Stores the Xbox user token, XSTS tickets and the Spartan token.
 */
export function createFileTokenPersister(file) {
  let cache = null;
  const read = async () => {
    if (cache) return cache;
    try {
      cache = JSON.parse(await fs.readFile(file, 'utf8'));
    } catch (e) {
      if (e.code !== 'ENOENT') console.warn(`[auth] Ignoring unreadable token cache ${path.basename(file)}: ${e.message}`);
      cache = {};
    }
    return cache;
  };
  const write = async (data) => {
    cache = data;
    await writeJsonAtomic(file, data, { mode: 0o600 });
    await fs.chmod(file, 0o600).catch(() => {});
  };
  return {
    load: async (name) => (await read())[name] ?? null,
    save: async (name, token) => {
      // Round-trip through JSON so luxon DateTimes become ISO strings, matching the library's own fs persister.
      await write({ ...(await read()), [name]: JSON.parse(JSON.stringify(token)) });
    },
    clear: async (name) => {
      const data = { ...(await read()) };
      delete data[name];
      await write(data);
    },
  };
}

/** Removes all cached Halo/Xbox tokens (used by `npm run auth`). */
export async function clearTokenFile(file) {
  await fs.unlink(file).catch(() => {});
}
