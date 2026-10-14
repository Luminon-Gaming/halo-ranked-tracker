import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { allTierIconNames } from './normalize.js';
import { writeFileAtomic } from './writeAtomic.js';

export const TIER_ICON_BASE = 'https://www.halowaypoint.com/images/halo-infinite/csr';

/**
 * Downloads the official tier icons into public/tiers once (they're public, no auth).
 * Missing icons are fine: the dashboard falls back to a built-in SVG badge.
 */
export async function ensureTierIcons({ tiersDir, fetchFn = fetch, log = console } = {}) {
  await fsp.mkdir(tiersDir, { recursive: true });
  const missing = allTierIconNames().filter((n) => !fs.existsSync(path.join(tiersDir, `${n}.png`)));
  let failed = 0;
  for (const name of missing) {
    try {
      const res = await fetchFn(`${TIER_ICON_BASE}/${name}.png`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      await writeFileAtomic(path.join(tiersDir, `${name}.png`), Buffer.from(await res.arrayBuffer()));
    } catch (e) {
      failed++;
      log.warn?.(`[icons] ${name}.png: ${e.message} (dashboard will use the fallback badge)`);
    }
  }
  if (missing.length) log.info?.(`[icons] downloaded ${missing.length - failed}/${missing.length} tier icons`);
  return { missing: missing.length, failed };
}

/**
 * Downloads a player's gamerpic to data/assets/{xuid}.png when the source URL changed or the file is missing.
 * Returns the local URL, or null if there's nothing usable.
 */
export async function ensureEmblem({ xuid, sourceUrl, previousSourceUrl, assetsDir, fetchFn = fetch, log = console }) {
  if (!xuid || !/^\d+$/.test(xuid)) return null;
  const file = path.join(assetsDir, `${xuid}.png`);
  const local = `/assets/${xuid}.png`;
  const exists = fs.existsSync(file);
  if (!sourceUrl) return exists ? local : null;
  if (exists && sourceUrl === previousSourceUrl) return local;
  try {
    const res = await fetchFn(sourceUrl);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    await writeFileAtomic(file, Buffer.from(await res.arrayBuffer()));
    return local;
  } catch (e) {
    log.warn?.(`[emblem] ${xuid}: ${e.message}`);
    return exists ? local : null;
  }
}
