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
// A signed-in visitor's token is only ever sent to Xbox and Halo: the Worker never talks to Microsoft on their behalf.
const EGRESS_USER = /(^|\.)(halowaypoint\.com|xboxlive\.com)$/;
const quiet = { info() {}, warn() {}, error() {} };
const MIN = 60_000;

export const DEFAULT_LIMITS = {
  uncachedPerMinute: 30, // fresh Halo lookups, all visitors together: these protect the Worker, each visitor spends their own Halo allowance
  uncachedPerHour: 600,
  uncachedPerDay: 3000,
  uncachedPerIpPerHour: 30,
  uncachedPerAccountPerHour: 60, // per sign-in token (hashed); tokens change hourly, so this only bounds one session
  upstreamPerMinute: 300, // every request the Worker sends to Microsoft/Xbox/Halo
  okTtlSec: 1800, // a found player is reused for 30 minutes: CSR only moves after matches, and the default player loads on every visit
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
const SIGN_IN = { error: 'signin_required', message: 'Sign in with a Microsoft account that has an Xbox profile to look players up.' };

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
  async admit(ipHash, accountHash = null) {
    const L = this.limits;
    const checks = [
      ['min', MIN, L.uncachedPerMinute, 60],
      ['hour', 60 * MIN, L.uncachedPerHour, 900],
      ['day', 24 * 60 * MIN, L.uncachedPerDay, 3600],
      [`ip:${ipHash}`, 60 * MIN, L.uncachedPerIpPerHour, 900],
    ];
    if (accountHash) checks.push([`acct:${accountHash}`, 60 * MIN, L.uncachedPerAccountPerHour, 900]);
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

  // Secrets are trimmed: a trailing newline from piped `wrangler secret put` input would otherwise end up in the
  // OAuth form body, the first refresh would fail as invalid_grant, and that would open the breaker.
  seed() {
    return String(this.env.HALO_REFRESH_TOKEN_SEED ?? '').trim();
  }

  clientId() {
    return String(this.env.HALO_AZURE_CLIENT_ID ?? '').trim();
  }

  /**
   * Run once per instance (and from the Durable Object constructor). When the seed secret or client ID differs from the
   * one used last time, a new account or a re-seed is meant: forget everything derived from the old credentials, the
   * breaker included, or a fresh seed would stay locked out for up to 30 minutes and the old account's Halo tokens
   * would keep being used until they expire.
   */
  ensureSeed() {
    this.seedCheck ??= (async () => {
      const seed = this.seed();
      if (!seed) return;
      const hash = await sha256Hex(`${seed}|${this.clientId()}`);
      if ((await this.storage.get('seedHash')) === hash) return;
      const derived = [...(await this.storage.list({ prefix: 'halo:' })).keys()];
      await this.storage.delete(['breaker', 'ms', ...derived]);
      await this.storage.put('seedHash', hash);
      this.log.info?.('[vault] new credentials: cleared breaker and cached tokens');
    })();
    return this.seedCheck;
  }

  async refreshMs() {
    const seed = this.seed();
    if (!seed) throw new AuthError('not seeded');
    const seedHash = await sha256Hex(seed);
    let state = await this.storage.get('ms');
    // A new `wrangler secret put` replaces whatever was stored; the same secret never overwrites a rotated token.
    if (!state || state.seedHash !== seedHash) state = { refreshToken: seed, seedHash };
    if (state.access && state.accessExp - this.now() > 5 * MIN) return state.access;
    const res = await this.guardedFetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: this.clientId(), grant_type: 'refresh_token', refresh_token: state.refreshToken, scope: SCOPE }),
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
  async guardedFetch(input, init, allowed = EGRESS_OK) {
    const url = new URL(typeof input === 'string' ? input : (input.url ?? String(input)));
    if (url.protocol !== 'https:' || !allowed.test(url.hostname)) throw new Error(`blocked egress to ${url.hostname}`);
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

  /**
   * A visitor's own sign-in. A fresh source and an in-memory token cache are built per request, so one visitor's
   * Xbox/Halo tokens are never kept, never written to storage and never used for anybody else.
   */
  userSource(token) {
    if (this.sourceFactory) return this.sourceFactory(this, { token });
    const fetchFn = (i, o) => this.guardedFetch(i, o, EGRESS_USER);
    const mem = new Map();
    const persister = {
      load: async (name) => mem.get(name) ?? null,
      save: async (name, value) => void mem.set(name, JSON.parse(JSON.stringify(value))),
      clear: async (name) => void mem.delete(name),
    };
    const provider = new AutoTokenProvider(async () => token, persister, fetchFn);
    return new HaloClientSource({ client: new HaloInfiniteClient(provider, fetchFn), log: quiet });
  }

  // --- lookups ---------------------------------------------------------------------------------------------------
  /** Only what is already cached: lets a signed-out visitor see public data without anybody's token being used. */
  async cached(gamertag) {
    const hit = await this.storage.get(`c:${gamertag.toLowerCase()}`);
    if (hit && hit.until > this.now()) return { status: hit.status, body: hit.body };
    return { status: 401, body: SIGN_IN };
  }

  /**
   * @param {{ token: string }|null} user the visitor's Microsoft access token, or null to use the dedicated account
   * @returns {{ status:number, body:object, retryAfter?:number }}
   */
  async lookup(gamertag, ipHash = 'none', user = null) {
    const key = gamertag.toLowerCase();
    const t = this.now();
    // Hashed so the token itself is never a storage key or log line; shared only by identical sign-ins.
    const account = user ? (await sha256Hex(user.token)).slice(0, 16) : null;
    if (!user) await this.ensureSeed();
    await this.prune(t).catch(() => {});
    const hit = await this.storage.get(`c:${key}`);
    if (hit && hit.until > t) return { status: hit.status, body: hit.body };
    const flight = account ? `${key}|${account}` : key;
    if (this.inflight.has(flight)) return this.inflight.get(flight);
    // Registered synchronously, right after the check above: anything awaited before this point would let
    // simultaneous requests for one name each pass the check and each spend budget.
    const run = this.start(gamertag, key, ipHash, t, user, account).finally(() => this.inflight.delete(flight));
    this.inflight.set(flight, run);
    return run;
  }

  async start(gamertag, key, ipHash, t, user, account) {
    const br = await this.storage.get('breaker');
    // The dedicated account's sign-in breaker says nothing about a visitor's own sign-in.
    if (br && br.until > t && !(user && br.code === 'auth')) return { status: 503, body: UNAVAILABLE, retryAfter: Math.ceil((br.until - t) / 1000) };
    const busy = await this.admit(ipHash, account);
    if (busy) return { status: 429, body: { error: 'busy', message: 'Too many lookups right now. Try again shortly.' }, retryAfter: busy.retryAfter };
    return this.run(gamertag, key, user);
  }

  async run(gamertag, key, user = null) {
    try {
      const result = await runFetch({
        config: this.config,
        source: user ? this.userSource(user.token) : this.source(),
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
      if (/HTTP 429/.test(JSON.stringify(player ?? {}))) return this.fromUpstreamStatus(user);
      // The pipeline folds failures into the player record; a record with nothing usable is a failed lookup, not data.
      if (!player || player.error) {
        // Every mode failing with a Halo 5xx means Halo is down: pause briefly instead of hammering it.
        if (/HTTP 5\d\d/.test(JSON.stringify(player ?? {}))) {
          await this.openBreaker('halo_5xx', MIN);
          return { status: 503, body: UNAVAILABLE, retryAfter: 60 };
        }
        this.log.error?.('[vault] lookup produced no usable data');
        return { status: 502, body: { error: 'lookup_failed', message: 'The lookup failed. Try again in a moment.' } };
      }
      cleanErrors(player);
      const body ={ schemaVersion: 1, fetchedAt: result.data.lastUpdated, csrSeasonId: result.data.csrSeasonId, modes: result.data.modes, player };
      return this.remember(key, 200, body, this.limits.okTtlSec);
    } catch (e) {
      return this.fromError(e, user);
    }
  }

  async remember(key, status, body, ttlSec) {
    await this.storage.put(`c:${key}`, { status, body, until: this.now() + ttlSec * 1000 });
    return { status, body };
  }

  // Whether Halo limits per account or per Cloudflare egress address is unknown. A visitor's 429 therefore pauses
  // everyone only briefly; the dedicated account's 429 pauses for five minutes.
  async fromUpstreamStatus(user = null) {
    const sec = user ? 60 : 300;
    await this.openBreaker('halo_429', sec * 1000);
    return { status: 503, body: UNAVAILABLE, retryAfter: sec };
  }

  async fromError(e, user = null) {
    if (e instanceof BudgetError) return { status: 429, body: { error: 'busy', message: 'Too many lookups right now. Try again shortly.' }, retryAfter: e.retryAfter };
    if (isAuthError(e)) {
      // A visitor's rejected token is that visitor's problem: tell them to sign in again, and never trip the breaker.
      if (user) return { status: 401, body: SIGN_IN };
      await this.openBreaker('auth', 30 * MIN);
      return { status: 503, body: UNAVAILABLE, retryAfter: 1800 };
    }
    const status = statusOf(e);
    if (status === 429) return this.fromUpstreamStatus(user);
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
