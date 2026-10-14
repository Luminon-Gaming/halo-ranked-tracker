import path from 'node:path';
import { HaloInfiniteClient, AutoTokenProvider, RequestError, AssetKind } from 'halo-infinite-api';
import { StatsSource } from './StatsSource.js';
import { createMsalApp, getAccessTokenSilent, AuthRequiredError } from '../auth/msal.js';
import { createFileTokenPersister } from '../auth/tokenStore.js';
import { createThrottledFetch } from '../fetch/throttle.js';
import { unwrapXuid } from '../fetch/normalize.js';
import { env } from '../config.js';

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

/** Spartan token pasted from browser DevTools (testing only; short-lived). */
export class StaticSpartanTokenProvider {
  constructor(token) {
    this.token = token;
  }
  async getSpartanToken() {
    return this.token;
  }
  async getCurrentExpiration() {
    return null;
  }
  async clearSpartanToken() {}
}

/** Picks the CSR season active at `now` from a CSR/season calendar ({ Seasons: [{ CsrSeasonFilePath, StartDate, EndDate }] }). */
export function pickCsrSeason(calendar, now = Date.now()) {
  const seasons = (calendar?.Seasons ?? [])
    .map((s) => ({
      id: s.CsrSeasonFilePath ? path.posix.basename(s.CsrSeasonFilePath).replace(/\.json$/i, '') : null,
      start: Date.parse(s.StartDate?.ISO8601Date ?? s.StartDate),
      end: Date.parse(s.EndDate?.ISO8601Date ?? s.EndDate),
    }))
    .filter((s) => s.id && Number.isFinite(s.start));
  const current = seasons.filter((s) => s.start <= now && (!Number.isFinite(s.end) || now < s.end));
  const pool = current.length ? current : seasons.filter((s) => s.start <= now);
  pool.sort((a, b) => a.start - b.start);
  return pool.at(-1)?.id ?? null;
}

export class HaloApiSource extends StatsSource {
  constructor({ client, assetFetch = null, log = console }) {
    super();
    this.client = client;
    this._assetFetch = assetFetch;
    this.log = log;
  }

  get assetFetch() {
    return this._assetFetch;
  }

  /** Builds a source from .env: HALO_SPARTAN_TOKEN (static) or MSAL silent refresh. */
  static create({ config, paths, log = console, baseFetch = fetch }) {
    const fetchFn = createThrottledFetch(baseFetch, { ...config.throttle, log });
    const { clientId, spartanToken } = env();
    let provider;
    if (spartanToken) {
      log.warn?.('[auth] Using HALO_SPARTAN_TOKEN from .env (testing shortcut; expires in a few hours)');
      provider = new StaticSpartanTokenProvider(spartanToken);
    } else {
      if (!clientId) throw new AuthRequiredError('No credentials: set HALO_AZURE_CLIENT_ID in .env and run "npm run auth".');
      const app = createMsalApp({ clientId, cacheFile: paths.msalCache });
      provider = new AutoTokenProvider(() => getAccessTokenSilent(app), createFileTokenPersister(paths.haloTokens), fetchFn);
    }
    return new HaloApiSource({ client: new HaloInfiniteClient(provider, fetchFn), assetFetch: baseFetch, log });
  }

  async getCurrentCsrSeason(now = Date.now()) {
    try {
      const id = pickCsrSeason(await this.client.getCsrSeasonCalendar(), now);
      if (id) return id;
    } catch (e) {
      if (isAuthError(e)) throw e;
      this.log.warn?.(`[season] CSR calendar lookup failed (${e.message}); trying season calendar`);
    }
    return pickCsrSeason(await this.client.getSeasonCalendar(), now);
  }

  async getUser(gamertag) {
    // The library interpolates the gamertag into the path unencoded; a modern "Name#1234" would become a URL fragment.
    const u = await this.client.getUser(encodeURIComponent(gamertag));
    return { xuid: unwrapXuid(u.xuid), gamertag: u.gamertag, gamerpic: u.gamerpic ?? null };
  }

  async getUsers(xuids) {
    const users = await this.client.getUsers(xuids);
    return users.map((u) => ({ xuid: unwrapXuid(u.xuid), gamertag: u.gamertag, gamerpic: u.gamerpic ?? null }));
  }

  async getPlaylistCsr(playlistId, xuids, seasonId) {
    // The library wraps bare XUIDs as xuid(...) itself (verified in 14.3.2 src/util/xuid.ts).
    return this.client.getPlaylistCsr(playlistId, xuids, seasonId || undefined);
  }

  async getPlaylistInfo(playlistId) {
    const [playlist, asset] = await Promise.allSettled([
      this.client.getPlaylist(playlistId),
      this.client.getAsset(AssetKind.Playlist, playlistId),
    ]);
    for (const r of [playlist, asset]) if (r.status === 'rejected' && isAuthError(r.reason)) throw r.reason;
    if (playlist.status === 'rejected' && asset.status === 'rejected') throw asset.reason;
    return {
      name: (asset.status === 'fulfilled' && asset.value?.PublicName) || (playlist.status === 'fulfilled' && playlist.value?.NameHint) || null,
      hasCsr: playlist.status === 'fulfilled' ? Boolean(playlist.value?.HasCsr) : null,
    };
  }
}
