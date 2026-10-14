import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { loadConfig, MODES, MODE_KEYS } from '../config.js';
import { loadAccounts } from '../accounts.js';
import { HaloApiSource, isAuthError, statusOf } from '../sources/HaloApiSource.js';
import { normalizeResult, unavailableMode, errorMode, unwrapXuid, mergePlayers, summarize } from './normalize.js';
import { chunk } from './throttle.js';
import { readJson, writeJsonAtomic } from './writeAtomic.js';
import { ensureTierIcons, ensureEmblem } from './icons.js';
import { acquireLock } from './lock.js';

const GOOD = new Set(['ranked', 'placement', 'unranked', 'not_in_rotation']);
const errMsg = (e) => (statusOf(e) ? `HTTP ${statusOf(e)}` : e?.message || String(e));

/**
 * Core pipeline (no file IO besides emblem downloads). Throws only on auth errors.
 * @returns {{ data, xuidCache, summary, allFailed }}
 */
export async function runFetch({ config, paths, source, accounts, prev = null, xuidCache = {}, only = null, log = console, now = () => new Date(), downloadAssets = true }) {
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
          if (downloadAssets && source.assetFetch) {
            p.emblemUrl = await ensureEmblem({ xuid: p.xuid, sourceUrl, previousSourceUrl: entry.gamerpicUrl, assetsDir: paths.assetsDir, fetchFn: source.assetFetch, log });
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

async function recordAttempt(paths, attempt) {
  await writeJsonAtomic(paths.lastAttempt, attempt).catch(() => {});
}

/** CLI/scheduler entry: config + lock + source + IO. Never throws; returns { ok, ... }. */
export async function executeFetch({ dryRun = false, only = null, log = console } = {}) {
  const t0 = performance.now();
  const { config, paths } = loadConfig({ log });
  let release;
  try {
    release = await acquireLock(paths.lockFile);
  } catch (e) {
    log.error?.(`[fetch] ${e.message}`);
    return { ok: false, error: e.message };
  }
  const attemptAt = new Date().toISOString();
  try {
    let source;
    let accounts;
    let outFile = paths.dataFile;
    if (dryRun) {
      const { createFixtureSource } = await import('./fixtureSource.js');
      const fx = await createFixtureSource({ log });
      source = fx.source;
      accounts = fx.accounts;
      outFile = path.join(paths.dataDir, 'ranks.dry-run.json');
      log.info?.('[fetch] DRY RUN: fixtures only, no network. Output -> data/ranks.dry-run.json');
    } else {
      accounts = await loadAccounts(paths.accountsFile, log);
      if (!accounts.length) {
        log.warn?.('[fetch] accounts.txt has no gamertags; nothing to do');
        return { ok: false, error: 'no_accounts' };
      }
      source = HaloApiSource.create({ config, paths, log });
      await ensureTierIcons({ tiersDir: paths.tiersDir, log }).catch((e) => log.warn?.(`[icons] ${e.message}`));
    }

    const prev = await readJson(outFile).catch(() => null);
    const xuidCache = dryRun ? {} : await readJson(paths.xuidCache, {}).catch(() => ({}));
    const result = await runFetch({ config, paths, source, accounts, prev, xuidCache, only, log, downloadAssets: !dryRun });
    const duration = ((performance.now() - t0) / 1000).toFixed(1);
    const s = result.summary;
    const line = `ok=${s.ok} placement=${s.placement} unranked=${s.unranked} not_in_rotation=${s.not_in_rotation} unavailable=${s.unavailable} errors=${s.errors} duration=${duration}s`;

    if (result.allFailed) {
      log.error?.(`[fetch] Every player failed; keeping the previous ranks.json. ${line}`);
      if (!dryRun) await recordAttempt(paths, { at: attemptAt, ok: false, errors: s.errors, message: 'all_players_failed' });
      return { ok: false, summary: s };
    }
    await writeJsonAtomic(outFile, result.data);
    if (!dryRun) {
      await writeJsonAtomic(paths.xuidCache, result.xuidCache);
      await recordAttempt(paths, result.data.lastAttempt);
    }
    log.info?.(`[fetch] season=${result.data.csrSeasonId ?? 'current'} ${line}`);
    return { ok: true, summary: s, file: outFile };
  } catch (e) {
    const message = isAuthError(e) ? `${e.message.replace(/\s*Run "npm run auth"\.?$/, '')} Run "npm run auth".` : e.message;
    log.error?.(`[fetch] FAILED: ${message} (previous data kept)`);
    if (!dryRun) await recordAttempt(paths, { at: attemptAt, ok: false, errors: 1, message: isAuthError(e) ? 'auth_required' : 'run_failed' });
    return { ok: false, error: message };
  } finally {
    await release?.();
  }
}
