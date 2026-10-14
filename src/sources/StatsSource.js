/**
 * StatsSource: where ranked data comes from. The fetch pipeline only talks to this interface,
 * so the Halo API can be swapped (fixtures for --dry-run, or a future source).
 */
export class NotImplementedError extends Error {
  constructor(what) {
    super(`${what} is not implemented`);
    this.name = 'NotImplementedError';
  }
}

export class StatsSource {
  /** @returns {Promise<string|null>} current CSR season id, e.g. "CsrSeason13-3" */
  async getCurrentCsrSeason(_now = Date.now()) {
    throw new NotImplementedError(`${this.constructor.name}.getCurrentCsrSeason`);
  }

  /** @returns {Promise<{ xuid: string, gamertag: string, gamerpic?: object }>} — throws { status: 404 } if unknown */
  async getUser(_gamertag) {
    throw new NotImplementedError(`${this.constructor.name}.getUser`);
  }

  /** @returns {Promise<Array<{ xuid, gamertag, gamerpic }>>} */
  async getUsers(_xuids) {
    throw new NotImplementedError(`${this.constructor.name}.getUsers`);
  }

  /** @returns {Promise<Array<{ Id, ResultCode, Result: { Current, SeasonMax, AllTimeMax } }>>} */
  async getPlaylistCsr(_playlistId, _xuids, _seasonId) {
    throw new NotImplementedError(`${this.constructor.name}.getPlaylistCsr`);
  }

  /** @returns {Promise<{ name: string|null, hasCsr: boolean|null }>} */
  async getPlaylistInfo(_playlistId) {
    throw new NotImplementedError(`${this.constructor.name}.getPlaylistInfo`);
  }

  /** Fetches a binary asset (gamerpic). Return null to skip downloads. */
  get assetFetch() {
    return null;
  }
}
