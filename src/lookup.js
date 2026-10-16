import { runFetch } from './fetch/runFetch.js';
import { looksLikeGamertag } from './accounts.js';
import { HaloApiSource, isAuthError } from './sources/HaloApiSource.js';
import { readJson } from './fetch/writeAtomic.js';

const MAX_CACHED = 100;

export class LookupError extends Error {
  constructor(status, code, message = code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/**
 * On-demand single-player lookup for the dashboard search box. Runs the normal pipeline for one
 * gamertag, caches the answer briefly, and never touches data/ranks.json. The Halo source (and so
 * the sign-in) is created on first use, so the server still starts with no credentials.
 */
export function createLookup({ config, paths, getSource = () => HaloApiSource.create({ config, paths, log }), log = console, ttlMs = 5 * 60_000, now = () => new Date() }) {
  const cache = new Map(); // key -> { at, result }
  const inflight = new Map(); // key -> Promise
  let source = null;

  async function fetchOne(gamertag) {
    source ??= getSource();
    const xuidCache = await readJson(paths.xuidCache, {}).catch(() => ({}));
    let result;
    try {
      result = await runFetch({ config, paths, source, accounts: [{ gamertag }], xuidCache, log, now });
    } catch (e) {
      if (isAuthError(e)) throw new LookupError(503, 'auth_required', 'Sign-in expired. Run "npm run auth".');
      throw e;
    }
    const player = result.data.players[0];
    if (player?.error === 'gamertag_not_found') throw new LookupError(404, 'gamertag_not_found', `No player found for "${gamertag}".`);
    return { schemaVersion: 1, fetchedAt: result.data.lastUpdated, csrSeasonId: result.data.csrSeasonId, modes: result.data.modes, player };
  }

  /** Resolves with { schemaVersion, fetchedAt, csrSeasonId, modes, player }. Throws LookupError. */
  return async function lookup(raw) {
    const gamertag = String(raw ?? '').trim().replace(/\s+/g, ' ');
    if (!gamertag || !looksLikeGamertag(gamertag)) throw new LookupError(400, 'invalid_gamertag', 'Enter a gamertag like "Name" or "Name#1234".');
    const key = gamertag.toLowerCase();
    const hit = cache.get(key);
    if (hit && now().getTime() - hit.at < ttlMs) return hit.result;
    if (!inflight.has(key)) {
      inflight.set(
        key,
        fetchOne(gamertag)
          .then((result) => {
            cache.set(key, { at: now().getTime(), result });
            if (cache.size > MAX_CACHED) cache.delete(cache.keys().next().value);
            return result;
          })
          .finally(() => inflight.delete(key)),
      );
    }
    return inflight.get(key);
  };
}
