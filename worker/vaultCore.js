// Everything the hosted lookup needs to touch Halo, as one object that owns the dedicated account's tokens.
// It runs inside a single Durable Object, so token refreshes, budgets and caches are never raced by two isolates.
// No Cloudflare imports here: storage and fetch are injected, which is what the unit tests do.
import { HaloInfiniteClient, AutoTokenProvider } from 'halo-infinite-api';
import { runFetch } from '../src/fetch/pipeline.js';
import { HaloClientSource } from '../src/sources/HaloClientSource.js';
import { isAuthError, statusOf } from '../src/sources/haloShared.js';
import { sha256Hex, avatarUrlAllowed } from './guard.js';

const TOKEN_URL = 'https://login.microsoftonline.com/consumers/oauth2/v2.0/token';
const SCOPE = 'XboxLive.signin offline_access';
// The only hosts this account's tokens may ever be sent to.
const EGRESS_OK = /(^|\.)(halowaypoint\.com|xboxlive\.com|microsoftonline\.com)$/;
const quiet = { info() {}, warn() {}, error() {} };
const MIN = 60_000;

export const DEFAULT_LIMITS = {
  uncachedPerMinute: 6, // fresh Halo lookups, all visitors together
  uncachedPerHour: 60,
  uncachedPerDay: 300,
  uncachedPerIpPerHour: 10,
  upstreamPerMinute: 60, // every request this account sends to Microsoft/Xbox/Halo
  okTtlSec: 600, // a found player is reused for 10 minutes
  notFoundTtlSec: 3600, // so is "no such gamertag", which blunts name enumeration
  cacheMax: 300,
};

export function limitsFrom(env = {}) {
  const out = { ...DEFAULT_LIMITS };
  for (const k of Object.keys(out)) {
    const n = Number.parseInt(env[`LIMIT_${k.replace(/[A-Z]/g, (c) => `_${c}`).toUpperCase()}`], 10);
    if (Number.isFinite(n) && n >= 0) out[k] = n;
  }
  return out;
}

export class BudgetError extends Error {
  constructor(retryAfter = 60) {
    super('upstream budget exhausted');
    this.name = 'BudgetError';
    this.retryAfter = retryAfter;
  }
}

/** Named AuthRequiredError so the shared isAuthError() treats it like the Node sign-in failure. */
export class AuthError extends Error {
  constructor(message) {
    super(message);
    this.name = 'AuthRequiredError';
  }
}

/** Per-mode errors may carry free text from exceptions. Visitors only get the code and, if any, the HTTP status. */
function cleanErrors(player) {
  const clean = (e) => {
    const code = /^[a-z_]+/.exec(String(e))?.[0] ?? 'error';
    const status = /HTTP (\d{3})/.exec(String(e))?.[1];
    return status ? `${code}: HTTP ${status}` : code;
  };
  for (const m of Object.values(player.modes ?? {})) if (m?.error) m.error = clean(m.error);
}

const UNAVAILABLE = { error: 'unavailable', message: 'Player lookup is unavailable right now. Try again later.' };

export class Vault {
  constructor({ storage, env = {}, fetchFn = fetch, config, now = Date.now, log = quiet, sourceFactory = null }) {
    this.storage = storage;
    this.env = env;
    // Called unbound on purpose: workerd throws "Illegal invocation" if the global fetch is called as a method.
    this.fetchFn = (input, init) => fetchFn(input, init);
    this.config = config;
    this.now = now;
    this.log = log;
    this.limits = limitsFrom(env);
    this.sourceFactory = sourceFactory;
    this.inflight = new Map();
    this.msLock = null;
    this.lastPrune = 0;
    this._source = null;
    this.persister = {
      load: async (name) => (await storage.get(`halo:${name}`)) ?? null,
      save: async (name, token) => storage.put(`halo:${name}`, JSON.parse(JSON.stringify(token))),
      clear: async (name) => {
        await storage.delete(`halo:${name}`);
      },
    };
    this.emblem = async ({ xuid, sourceUrl }) => {
      if (!sourceUrl || !avatarUrlAllowed(sourceUrl)) return null;
      await storage.put(`a:${xuid}`, { url: sourceUrl, until: this.now() + 7 * 24 * 60 * MIN });
      return `/api/avatar/${xuid}`;
    };
  }

  // --- counters ------------------------------------------------------------------------------------------------
  // Key layout n:<windowMs>:<bucket>:<scope>, so prune() can tell from the key alone when a counter is dead.
  counterKey(scope, windowMs) {
    return `n:${windowMs}:${Math.floor(this.now() / windowMs)}:${scope}`;
  }

  async bump(scope, windowMs) {
    const key = this.counterKey(scope, windowMs);
    const n = ((await this.storage.get(key)) ?? 0) + 1;
    await this.storage.put(key, n);
    return n;
  }

  async peek(scope, windowMs) {
    return (await this.storage.get(this.counterKey(scope, windowMs))) ?? 0;
  }

  /** null when a fresh lookup may start, else { retryAfter } in seconds. Counts the lookup when admitted. */
  async admit(ipHash) {
    const L = this.limits;
    const checks = [
      ['min', MIN, L.uncachedPerMinute, 60],
      ['hour', 60 * MIN, L.uncachedPerHour, 900],
      ['day', 24 * 60 * MIN, L.uncachedPerDay, 3600],
      [`ip:${ipHash}`, 60 * MIN, L.uncachedPerIpPerHour, 900],
    ];
    for (const [scope, win, max, retry] of checks) if ((await this.peek(scope, win)) >= max) return { retryAfter: retry };
    for (const [scope, win] of checks) await this.bump(scope, win);
    return null;
  }

  // --- breaker ---------------------------------------------------------------------------------------------------
  async openBreaker(code, ms) {
    await this.storage.put('breaker', { code, until: this.now() + ms });
    this.log.error?.(`[vault] breaker open: ${code} for ${Math.round(ms / 1000)}s`);
  }

  // --- Microsoft sign-in -----------------------------------------------------------------------------------------
  /** Access token for XboxLive.signin. The refresh token rotates, so the new one is stored before it is used. */
  msAccessToken() {
    this.msLock ??= this.refreshMs().finally(() => {
      this.msLock = null;
    });
    return this.msLock;
  }

  async refreshMs() {
    const seed = this.env.HALO_REFRESH_TOKEN_SEED;
    if (!seed) throw new AuthError('not seeded');
    const seedHash = await sha256Hex(seed);
    let state = await this.storage.get('ms');
    // A new `wrangler secret put` replaces whatever was stored; the same secret never overwrites a rotated token.
    if (!state || state.seedHash !== seedHash) state = { refreshToken: seed, seedHash };
    if (state.access && state.accessExp - this.now() > 5 * MIN) return state.access;
    const res = await this.guardedFetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: this.env.HALO_AZURE_CLIENT_ID, grant_type: 'refresh_token', refresh_token: state.refreshToken, scope: SCOPE }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.access_token) {
      // Only the error code is kept: nothing from the response body is logged or returned.
      const code = String(data.error ?? res.status).slice(0, 40);
      if (res.status >= 500) throw new Error(`token endpoint HTTP ${res.status}`);
      throw new AuthError(`refresh rejected (${code})`);
    }
    const next = { seedHash, refreshToken: data.refresh_token ?? state.refreshToken, access: data.access_token, accessExp: this.now() + Number(data.expires_in ?? 3600) * 1000 };
    await this.storage.put('ms', next);
    return next.access;
  }

  // --- upstream --------------------------------------------------------------------------------------------------
  async guardedFetch(input, init) {
    const url = new URL(typeof input === 'string' ? input : (input.url ?? String(input)));
    if (url.protocol !== 'https:' || !EGRESS_OK.test(url.hostname)) throw new Error(`blocked egress to ${url.hostname}`);
    if ((await this.bump('up', MIN)) > this.limits.upstreamPerMinute) throw new BudgetError(60);
    return this.fetchFn(input, init);
  }

  source() {
    if (!this._source) {
      if (this.sourceFactory) this._source = this.sourceFactory(this);
      else {
        const fetchFn = (i, o) => this.guardedFetch(i, o);
        const provider = new AutoTokenProvider(() => this.msAccessToken(), this.persister, fetchFn);
        this._source = new HaloClientSource({ client: new HaloInfiniteClient(provider, fetchFn), log: quiet });
      }
    }
    return this._source;
  }

  // --- lookups ---------------------------------------------------------------------------------------------------
  /** @returns {{ status:number, body:object, retryAfter?:number }} */
  async lookup(gamertag, ipHash = 'none') {
    const key = gamertag.toLowerCase();
    const t = this.now();
    await this.prune(t).catch(() => {});
    const hit = await this.storage.get(`c:${key}`);
    if (hit && hit.until > t) return { status: hit.status, body: hit.body };
    if (this.inflight.has(key)) return this.inflight.get(key);
    // Registered synchronously, right after the check above: anything awaited before this point would let
    // simultaneous requests for one name each pass the check and each spend budget.
    const run = this.start(gamertag, key, ipHash, t).finally(() => this.inflight.delete(key));
    this.inflight.set(key, run);
    return run;
  }

  async start(gamertag, key, ipHash, t) {
    const br = await this.storage.get('breaker');
    if (br && br.until > t) return { status: 503, body: UNAVAILABLE, retryAfter: Math.ceil((br.until - t) / 1000) };
    const busy = await this.admit(ipHash);
    if (busy) return { status: 429, body: { error: 'busy', message: 'Too many lookups right now. Try again shortly.' }, retryAfter: busy.retryAfter };
    return this.run(gamertag, key);
  }

  async run(gamertag, key) {
    try {
      const result = await runFetch({
        config: this.config,
        source: this.source(),
        accounts: [{ gamertag }],
        xuidCache: {},
        log: quiet,
        now: () => new Date(this.now()),
        emblem: this.emblem,
      });
      const player = result.data.players[0];
      if (player?.error === 'gamertag_not_found') {
        return this.remember(key, 404, { error: 'gamertag_not_found', message: `No player found for "${gamertag}".` }, this.limits.notFoundTtlSec);
      }
      // Only a 429 means "slow down" for everyone. A 401/403 on one player's data must not be able to lock everybody out.
      if (/HTTP 429/.test(JSON.stringify(player ?? {}))) return this.fromUpstreamStatus();
      // The pipeline folds failures into the player record; a record with nothing usable is a failed lookup, not data.
      if (!player || player.error) {
        this.log.error?.('[vault] lookup produced no usable data');
        return { status: 502, body: { error: 'lookup_failed', message: 'The lookup failed. Try again in a moment.' } };
      }
      cleanErrors(player);
      const body ={ schemaVersion: 1, fetchedAt: result.data.lastUpdated, csrSeasonId: result.data.csrSeasonId, modes: result.data.modes, player };
      return this.remember(key, 200, body, this.limits.okTtlSec);
    } catch (e) {
      return this.fromError(e);
    }
  }

  async remember(key, status, body, ttlSec) {
    await this.storage.put(`c:${key}`, { status, body, until: this.now() + ttlSec * 1000 });
    return { status, body };
  }

  async fromUpstreamStatus() {
    await this.openBreaker('halo_429', 5 * MIN);
    return { status: 503, body: UNAVAILABLE, retryAfter: 300 };
  }

  async fromError(e) {
    if (e instanceof BudgetError) return { status: 429, body: { error: 'busy', message: 'Too many lookups right now. Try again shortly.' }, retryAfter: e.retryAfter };
    if (isAuthError(e)) {
      await this.openBreaker('auth', 30 * MIN);
      return { status: 503, body: UNAVAILABLE, retryAfter: 1800 };
    }
    const status = statusOf(e);
    if (status === 429) return this.fromUpstreamStatus();
    if (status >= 500) {
      await this.openBreaker('halo_5xx', MIN);
      return { status: 503, body: UNAVAILABLE, retryAfter: 60 };
    }
    this.log.error?.(`[vault] lookup failed: ${e?.name ?? 'Error'}`);
    return { status: 502, body: { error: 'lookup_failed', message: 'The lookup failed. Try again in a moment.' } };
  }

  /** Where to fetch this player's gamerpic from. Only URLs that Halo itself returned are ever stored. */
  async avatar(xuid) {
    if (!/^\d{1,20}$/.test(String(xuid))) return null;
    const a = await this.storage.get(`a:${xuid}`);
    return a && a.until > this.now() && avatarUrlAllowed(a.url) ? { url: a.url } : null;
  }

  /** Drops expired entries and old counters, and keeps the cache under cacheMax. At most once a minute. */
  async prune(t) {
    if (t - this.lastPrune < MIN) return;
    this.lastPrune = t;
    const dead = [];
    const cache = await this.storage.list({ prefix: 'c:' });
    for (const [k, v] of cache) if (v.until <= t) dead.push(k);
    const live = [...cache].filter(([, v]) => v.until > t).sort((a, b) => a[1].until - b[1].until);
    for (const [k] of live.slice(0, Math.max(0, live.length - this.limits.cacheMax))) dead.push(k);
    for (const [k, v] of await this.storage.list({ prefix: 'a:' })) if (v.until <= t) dead.push(k);
    for (const [k] of await this.storage.list({ prefix: 'n:' })) {
      const [, win, bucket] = k.split(':');
      if ((Number(bucket) + 2) * Number(win) < t) dead.push(k);
    }
    for (let i = 0; i < dead.length; i += 128) await this.storage.delete(dead.slice(i, i + 128)); // 128 keys per call
  }
}
