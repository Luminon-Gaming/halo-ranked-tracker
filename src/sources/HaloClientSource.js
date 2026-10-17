import { AssetKind } from 'halo-infinite-api';
import { StatsSource } from './StatsSource.js';
import { isAuthError, pickCsrSeason } from './haloShared.js';
import { unwrapXuid } from '../fetch/normalize.js';

/** StatsSource over an already-built HaloInfiniteClient. Pure (no sign-in, no files), so the Worker uses it too. */
export class HaloClientSource extends StatsSource {
  constructor({ client, assetFetch = null, log = console }) {
    super();
    this.client = client;
    this._assetFetch = assetFetch;
    this.log = log;
  }

  get assetFetch() {
    return this._assetFetch;
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
