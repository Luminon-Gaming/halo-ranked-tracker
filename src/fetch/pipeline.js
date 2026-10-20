// Pure one-run pipeline: no filesystem, no sign-in code, so it also bundles into the Cloudflare Worker.
import { MODES, MODE_KEYS } from '../modes.js';
import { isAuthError, statusOf } from '../sources/haloShared.js';
import { normalizeResult, unavailableMode, errorMode, unwrapXuid, mergePlayers, summarize } from './normalize.js';
import { chunk } from './throttle.js';

const GOOD = new Set(['ranked', 'placement', 'unranked', 'not_in_rotation']);
const errMsg = (e) => (statusOf(e) ? `HTTP ${statusOf(e)}` : e?.message || String(e));

/**
 * Core pipeline (no file IO besides emblem downloads). Throws only on auth errors.
 * @returns {{ data, xuidCache, summary, allFailed }}
 */
export async function runFetch({ config, source, accounts, prev = null, xuidCache = {}, only = null, log = console, now = () => new Date(), emblem = null }) {
  const onlySet = only?.length ? new Set(only.map((g) => g.toLowerCase())) : null;
  const targets = onlySet ? accounts.filter((a) => onlySet.has(a.gamertag.toLowerCase())) : accounts;
  const cache = { ...xuidCache };
  const batchSize = config.throttle.csrBatchSize;
  const modes = Object.fromEntries(
    MODE_KEYS.map((k) => [k, { label: MODES[k], playlistId: config.playlists[k] ?? null, inRotation: config.rotation[k] ?? true }]),
  );

  // Season is looked up every run: rank resets (e.g. Nov 3, 2026) start a new CSR season.
  let csrSeasonId = null;
  try {
    csrSeasonId = await source.getCurrentCsrSeason(now().getTime());
  } catch (e) {
    if (isAuthError(e)) throw e;
    log.warn?.(`[season] lookup failed (${errMsg(e)}); querying the API's current season`);
  }

  // 1. Gamertag -> XUID (cached)
  const players = await Promise.all(
    targets.map(async ({ gamertag }) => {
      const p = { gamertag, xuid: null, emblemUrl: null, stale: false, error: null, modes: {} };
      const key = gamertag.toLowerCase();
      if (cache[key]?.xuid) {
        p.xuid = cache[key].xuid;
        return p;
      }
      try {
        const u = await source.getUser(gamertag);
        p.xuid = u.xuid;
        cache[key] = { xuid: u.xuid, gamertag: u.gamertag ?? gamertag, gamerpicUrl: null, resolvedAt: now().toISOString() };
      } catch (e) {
        if (isAuthError(e)) throw e;
        p.error = statusOf(e) === 404 ? 'gamertag_not_found' : `lookup_failed: ${errMsg(e)}`;
        log.warn?.(`[lookup] ${gamertag}: ${p.error}`);
      }
      return p;
    }),
  );
  const withXuid = players.filter((p) => p.xuid);

  // 2. CSR per mode, batched
  for (const key of MODE_KEYS) {
    const { playlistId, inRotation } = modes[key];
    for (const p of players) {
      if (!playlistId) p.modes[key] = unavailableMode('no_playlist_id');
      else if (!p.xuid) p.modes[key] = errorMode(p.error);
    }
    if (!playlistId) continue;
    await Promise.all(
      chunk(withXuid, batchSize).map(async (group) => {
        try {
          const results = await source.getPlaylistCsr(playlistId, group.map((p) => p.xuid), csrSeasonId);
          const byXuid = new Map((results ?? []).map((r) => [unwrapXuid(r.Id), r]));
          for (const p of group) p.modes[key] = normalizeResult(byXuid.get(p.xuid), { inRotation });
        } catch (e) {
          if (isAuthError(e)) throw e;
          const status = statusOf(e);
          log.warn?.(`[csr] ${key} batch of ${group.length}: ${errMsg(e)}`);
          for (const p of group) {
            p.modes[key] = status === 404 || (!inRotation && status === 400)
              ? unavailableMode(inRotation ? 'playlist_not_found' : 'not_in_rotation')
              : errorMode(`csr_request_failed: ${errMsg(e)}`);
          }
        }
      }),
    );
  }

  // 3. Profiles: canonical gamertag spelling + gamerpic
  if (config.emblemSource === 'spartan-emblem') log.warn?.('[emblem] spartan-emblem is not implemented yet; using gamerpic');
  for (const group of chunk(withXuid, batchSize)) {
    try {
      const users = await source.getUsers(group.map((p) => p.xuid));
      const byXuid = new Map(users.map((u) => [u.xuid, u]));
      await Promise.all(
        group.map(async (p) => {
          const u = byXuid.get(p.xuid);
          const entry = cache[p.gamertag.toLowerCase()] ?? { xuid: p.xuid };
          if (u?.gamertag) entry.gamertag = u.gamertag;
          const sourceUrl = u?.gamerpic?.medium ?? null;
          if (emblem) {
            // `emblem` turns the profile's gamerpic URL into the URL the page should load (a saved file, or a proxy path).
            p.emblemUrl = await emblem({ xuid: p.xuid, sourceUrl, previousSourceUrl: entry.gamerpicUrl });
            if (p.emblemUrl && sourceUrl) entry.gamerpicUrl = sourceUrl;
          }
          cache[p.gamertag.toLowerCase()] = entry;
          if (u?.gamertag) p.gamertag = u.gamertag;
        }),
      );
    } catch (e) {
      if (isAuthError(e)) throw e;
      log.warn?.(`[profiles] batch of ${group.length}: ${errMsg(e)} (keeping previous gamertags/emblems)`);
    }
  }

  // 4. Player-level error when nothing usable came back
  for (const p of players) {
    if (p.error) continue;
    const ms = Object.values(p.modes);
    const errs = ms.filter((m) => m.status === 'error');
    if (errs.length && !ms.some((m) => GOOD.has(m.status))) p.error = errs[0].error;
  }
  const allFailed = players.length > 0 && players.every((p) => p.error && !Object.values(p.modes).some((m) => GOOD.has(m.status)));

  // 5. Merge with previous file
  let merged = mergePlayers(prev?.players ?? [], players);
  if (onlySet) {
    const fresh = new Map(merged.map((p) => [p.xuid ?? p.gamertag.toLowerCase(), p]));
    const used = new Set();
    const out = [];
    for (const prevP of prev?.players ?? []) {
      const k = prevP.xuid ?? prevP.gamertag.toLowerCase();
      if (fresh.has(k)) {
        out.push(fresh.get(k));
        used.add(k);
      } else out.push(prevP);
    }
    for (const [k, p] of fresh) if (!used.has(k)) out.push(p);
    merged = out;
  }

  const summary = summarize(merged);
  const at = now().toISOString();
  const data = {
    schemaVersion: 1,
    lastUpdated: at,
    lastAttempt: { at, ok: !allFailed, errors: summary.errors },
    csrSeasonId: csrSeasonId ?? prev?.csrSeasonId ?? null,
    modes,
    players: merged,
  };
  return { data, xuidCache: cache, summary, allFailed };
}
