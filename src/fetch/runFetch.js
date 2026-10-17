import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { loadConfig } from '../config.js';
import { loadAccounts } from '../accounts.js';
import { HaloApiSource } from '../sources/HaloApiSource.js';
import { isAuthError } from '../sources/haloShared.js';
import { readJson, writeJsonAtomic } from './writeAtomic.js';
import { ensureTierIcons, ensureEmblem } from './icons.js';
import { acquireLock } from './lock.js';
import { runFetch as runPipeline } from './pipeline.js';

/** Node entry for the pipeline: same run, plus gamerpic downloads into data/assets (set downloadAssets: false to skip). */
export function runFetch({ paths, downloadAssets = true, ...args }) {
  const { source, log = console } = args;
  const emblem = downloadAssets && source.assetFetch
    ? (e) => ensureEmblem({ ...e, assetsDir: paths.assetsDir, fetchFn: source.assetFetch, log })
    : null;
  return runPipeline({ ...args, emblem });
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
