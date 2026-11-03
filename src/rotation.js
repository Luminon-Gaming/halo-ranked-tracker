/**
 * Playlist rotation, resolved per run from the dated schedule in config.json.
 *
 * `rotation.<mode>` is `"auto"` (follow `rotationSchedule.<mode>`), or `true` / `false` to force it.
 * Schedule windows are inclusive local dates (`YYYY-MM-DD`) in `schedule.timezone`, copied from the
 * official Halo Support "Halo Infinite Multiplayer Playlists" page. Nothing here hardcodes a date.
 */

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** True when `value` is a valid list of `{ from, to }` windows (from <= to). */
export function isWindowList(value) {
  return (
    Array.isArray(value) &&
    value.every(
      (w) =>
        w && typeof w === 'object' && !Array.isArray(w) &&
        DATE_RE.test(w.from) && DATE_RE.test(w.to) &&
        !Number.isNaN(Date.parse(`${w.from}T00:00:00Z`)) && !Number.isNaN(Date.parse(`${w.to}T00:00:00Z`)) &&
        w.from <= w.to,
    )
  );
}

/** The calendar date (`YYYY-MM-DD`) of `date` in the IANA `timeZone`. */
export function localDate(date, timeZone) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(date);
  const get = (t) => parts.find((p) => p.type === t).value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

/**
 * Resolves one mode.
 * @returns {{ inRotation: boolean, source: 'auto'|'config'|'default', today: string,
 *             liveUntil: string|null, next: {from,to}|null, scheduleExhausted: boolean }}
 */
export function resolveModeRotation(setting, windows, today) {
  const sorted = [...(windows ?? [])].sort((a, b) => a.from.localeCompare(b.from));
  const current = sorted.find((w) => w.from <= today && today <= w.to) ?? null;
  const next = sorted.find((w) => w.from > today) ?? null;
  const base = { today, liveUntil: current?.to ?? null, next: next ? { from: next.from, to: next.to } : null };

  if (setting === true || setting === false) return { ...base, inRotation: setting, source: 'config', scheduleExhausted: false };
  if (setting !== 'auto' || !sorted.length) return { ...base, inRotation: true, source: 'default', scheduleExhausted: false };
  return { ...base, inRotation: Boolean(current), source: 'auto', scheduleExhausted: !current && !next };
}

/** Resolves every mode in `modeKeys`. Modes without a rotation setting are always live. */
export function resolveRotation(config, now, modeKeys) {
  const tz = config.schedule?.timezone || 'UTC';
  const today = localDate(now, tz);
  return Object.fromEntries(
    modeKeys.map((k) => [k, resolveModeRotation(config.rotation?.[k], config.rotationSchedule?.[k], today)]),
  );
}
