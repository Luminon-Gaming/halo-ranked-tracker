// Helpers shared by the Node source and the Cloudflare Worker: no filesystem, no sign-in code.
import { RequestError } from 'halo-infinite-api';

export const statusOf = (e) => e?.response?.status ?? e?.status ?? null;

/** True when the run can't continue without the user re-authenticating. */
export function isAuthError(e) {
  if (e?.name === 'AuthRequiredError') return true;
  const status = statusOf(e);
  if (e instanceof RequestError || e?.name === 'RequestError') {
    const url = String(e.url ?? '');
    if (/xboxlive\.com|xsts|login\.live\.com|spartan-token/.test(url)) return [400, 401, 403].includes(status);
    return status === 401;
  }
  return false;
}

const baseName = (p) => String(p).split('/').pop();

/** Picks the CSR season active at `now` from a CSR/season calendar ({ Seasons: [{ CsrSeasonFilePath, StartDate, EndDate }] }). */
export function pickCsrSeason(calendar, now = Date.now()) {
  const seasons = (calendar?.Seasons ?? [])
    .map((s) => ({
      id: s.CsrSeasonFilePath ? baseName(s.CsrSeasonFilePath).replace(/\.json$/i, '') : null,
      start: Date.parse(s.StartDate?.ISO8601Date ?? s.StartDate),
      end: Date.parse(s.EndDate?.ISO8601Date ?? s.EndDate),
    }))
    .filter((s) => s.id && Number.isFinite(s.start));
  const current = seasons.filter((s) => s.start <= now && (!Number.isFinite(s.end) || now < s.end));
  const pool = current.length ? current : seasons.filter((s) => s.start <= now);
  pool.sort((a, b) => a.start - b.start);
  return pool.at(-1)?.id ?? null;
}
