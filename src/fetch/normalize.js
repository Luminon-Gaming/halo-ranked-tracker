// Pure functions: API CSR results -> dashboard data contract (see README "Data contract").

export const STATUSES = ['ranked', 'placement', 'unranked', 'not_in_rotation', 'unavailable', 'error'];
const SUBTIERED = new Set(['bronze', 'silver', 'gold', 'platinum', 'diamond']);

export function isOnyx(tier) {
  return typeof tier === 'string' && tier.toLowerCase() === 'onyx';
}

/** True when a PlaylistCsr block carries no usable rank (API sentinel: Value -1 and/or Tier "Unranked"/""). */
export function isUnrankedCsr(c) {
  if (!c || typeof c.Value !== 'number' || c.Value < 0) return true;
  const tier = typeof c.Tier === 'string' ? c.Tier.trim().toLowerCase() : '';
  return tier === '' || tier === 'unranked';
}

/** API SubTier is 0-indexed; the contract stores 1-indexed (1–6). Onyx has no sub-tiers. */
export function displaySubTier(tier, apiSubTier) {
  if (isOnyx(tier) || typeof apiSubTier !== 'number' || apiSubTier < 0) return null;
  return apiSubTier + 1;
}

/** Official icon filename (without .png) for a tier + 1-indexed sub-tier, or null. */
export function tierIconName(tier, subTier) {
  if (typeof tier !== 'string') return null;
  const t = tier.toLowerCase();
  if (t === 'onyx') return 'onyx_1';
  if (SUBTIERED.has(t) && Number.isInteger(subTier) && subTier >= 1 && subTier <= 6) return `${t}_${subTier}`;
  return null;
}

/** Placement icon: unranked_0 … unranked_5 by matches played. */
export function placementIconName(matchesPlayed) {
  const n = Math.min(5, Math.max(0, Math.floor(Number(matchesPlayed) || 0)));
  return `unranked_${n}`;
}

/** Every icon the dashboard may reference (bronze_0, bronze_7 and onyx_2 do not exist upstream). */
export function allTierIconNames() {
  const names = [];
  for (const t of SUBTIERED) for (let n = 1; n <= 6; n++) names.push(`${t}_${n}`);
  names.push('onyx_1');
  for (let n = 0; n <= 5; n++) names.push(placementIconName(n));
  return names;
}

export const iconUrl = (name) => (name ? `/tiers/${name}.png` : null);

export function progressPct(csr, tierStartCsr, nextTierCsr) {
  if (![csr, tierStartCsr, nextTierCsr].every((n) => typeof n === 'number' && Number.isFinite(n))) return null;
  const span = nextTierCsr - tierStartCsr;
  if (span <= 0) return null;
  return Math.min(100, Math.max(0, Math.round(((csr - tierStartCsr) / span) * 100)));
}

const valueOrNull = (c) => (c && !isUnrankedCsr(c) ? c.Value : null);

/**
 * Normalizes one PlaylistCsrContainer ({ Current, SeasonMax, AllTimeMax }) into a mode entry.
 * `inRotation: false` keeps the numbers but marks the entry not_in_rotation (shown dimmed).
 */
export function normalizeCsr(container, { inRotation = true } = {}) {
  const cur = container?.Current;
  if (!cur) return unavailableMode('no_data');

  const peak = container.SeasonMax && !isUnrankedCsr(container.SeasonMax) ? container.SeasonMax : null;
  const base = {
    peakCsr: peak ? peak.Value : null,
    peakTier: peak ? peak.Tier : null,
    peakSubTier: peak ? displaySubTier(peak.Tier, peak.SubTier) : null,
    allTimePeakCsr: valueOrNull(container.AllTimeMax),
  };

  const remaining = Number(cur.MeasurementMatchesRemaining) || 0;
  const initial = Number(cur.InitialMeasurementMatches) || 0;
  const played = Math.max(0, initial - remaining);

  let entry;
  if (remaining > 0 && !(played === 0 && isUnrankedCsr(cur))) {
    entry = {
      status: 'placement',
      csr: null, tier: null, subTier: null, tierStartCsr: null,
      nextTier: null, nextSubTier: null, nextTierCsr: null, progressPct: null,
      matchesRemaining: remaining,
      matchesPlayed: played,
      ...base,
      tierIconUrl: iconUrl(placementIconName(played)),
    };
  } else if (isUnrankedCsr(cur)) {
    // No placement matches started this season (or the API returned its unranked sentinel).
    entry = {
      status: 'unranked',
      csr: null, tier: null, subTier: null, tierStartCsr: null,
      nextTier: null, nextSubTier: null, nextTierCsr: null, progressPct: null,
      matchesRemaining: remaining,
      matchesPlayed: played,
      ...base,
      tierIconUrl: iconUrl(placementIconName(0)),
    };
  } else {
    const onyx = isOnyx(cur.Tier);
    const subTier = displaySubTier(cur.Tier, cur.SubTier);
    const nextTierCsr = onyx || typeof cur.NextTierStart !== 'number' || cur.NextTierStart <= cur.TierStart ? null : cur.NextTierStart;
    const nextTier = onyx || !cur.NextTier ? null : cur.NextTier;
    entry = {
      status: 'ranked',
      csr: cur.Value,
      tier: cur.Tier,
      subTier,
      tierStartCsr: typeof cur.TierStart === 'number' ? cur.TierStart : null,
      nextTier,
      nextSubTier: nextTier ? displaySubTier(nextTier, cur.NextSubTier) : null,
      nextTierCsr,
      progressPct: progressPct(cur.Value, cur.TierStart, nextTierCsr),
      matchesRemaining: 0,
      ...base,
      tierIconUrl: iconUrl(tierIconName(cur.Tier, subTier)),
    };
  }
  if (!inRotation) entry = { ...entry, rankStatus: entry.status, status: 'not_in_rotation' };
  return entry;
}

export function unavailableMode(reason = null) {
  return { status: 'unavailable', reason, csr: null, tier: null, subTier: null, tierIconUrl: null };
}

export function errorMode(error) {
  return { status: 'error', error: String(error), csr: null, tier: null, subTier: null, tierIconUrl: null };
}

/** Normalizes one ResultContainer from getPlaylistCsr. */
export function normalizeResult(result, opts) {
  if (!result) return unavailableMode('no_result');
  if (result.ResultCode !== 0) return unavailableMode(`result_code_${result.ResultCode}`);
  return normalizeCsr(result.Result, opts);
}

/** "xuid(2533…)" -> "2533…" */
export function unwrapXuid(id) {
  const m = /^\w+\((\d+)\)$/.exec(String(id));
  return m ? m[1] : String(id);
}

const playerKey = (p) => (p.xuid ? `x:${p.xuid}` : `g:${p.gamertag.toLowerCase()}`);
const hasGoodData = (m) => m && m.status !== 'error';

/**
 * Merges a fresh run with the previous file.
 * - Player-level failures keep their last good modes, flagged stale with the error.
 * - Mode-level errors fall back to the previous mode entry for that player (flagged stale).
 */
export function mergePlayers(prevPlayers = [], nextPlayers = []) {
  const prevByKey = new Map();
  for (const p of prevPlayers) {
    prevByKey.set(playerKey(p), p);
    prevByKey.set(`g:${p.gamertag.toLowerCase()}`, p);
  }
  return nextPlayers.map((p) => {
    const prev = prevByKey.get(playerKey(p)) ?? prevByKey.get(`g:${p.gamertag.toLowerCase()}`);
    if (!prev) return p;
    if (p.error && Object.values(p.modes ?? {}).every((m) => !hasGoodData(m))) {
      if (!Object.values(prev.modes ?? {}).some(hasGoodData)) return { ...p, emblemUrl: p.emblemUrl ?? prev.emblemUrl ?? null };
      return {
        ...prev,
        gamertag: p.gamertag || prev.gamertag,
        modes: Object.fromEntries(Object.entries(prev.modes).map(([k, m]) => [k, hasGoodData(m) ? { ...m, stale: true } : p.modes?.[k] ?? m])),
        stale: true,
        error: p.error,
      };
    }
    const modes = { ...p.modes };
    const errors = [];
    for (const [k, m] of Object.entries(modes)) {
      if (m.status === 'error') {
        errors.push(`${k}: ${m.error}`);
        if (hasGoodData(prev.modes?.[k])) modes[k] = { ...prev.modes[k], stale: true, error: m.error };
      }
    }
    const stale = Object.values(modes).some((m) => m.stale);
    return { ...p, emblemUrl: p.emblemUrl ?? prev.emblemUrl ?? null, modes, stale, error: p.error ?? (errors.length ? errors.join('; ') : null) };
  });
}

/** Counts mode statuses across every player × mode; `errors` counts players with an error. */
export function summarize(players) {
  const counts = { ok: 0, placement: 0, unranked: 0, not_in_rotation: 0, unavailable: 0, errors: 0 };
  for (const p of players) {
    if (p.error) counts.errors++;
    for (const m of Object.values(p.modes ?? {})) {
      if (m.status === 'ranked') counts.ok++;
      else if (m.status in counts) counts[m.status]++;
    }
  }
  return counts;
}
