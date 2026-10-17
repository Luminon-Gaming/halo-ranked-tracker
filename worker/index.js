// Cloudflare Worker for the hosted copy. Static files are served by the assets binding; only the paths listed in
// wrangler.jsonc `run_worker_first` reach this code: /api/player, /api/avatar/*, /api/config.
import { DurableObject } from 'cloudflare:workers';
import config from '../config.json';
import { Vault } from './vaultCore.js';
import { json, fail, clientIp, sha256Hex, crossSiteBlocked, parsePlayerRequest, bearerToken, verifyTurnstile } from './guard.js';

// halo-infinite-api leaves a rejected promise nobody awaits when a token fetch fails; the caller already got the error.
if (typeof addEventListener === 'function') {
  addEventListener('unhandledrejection', (e) => {
    if (e.promise?.constructor?.name === 'ResolvablePromise') e.preventDefault();
  });
}

/** The one object that holds the dedicated account's tokens, the budgets and the caches. */
export class HaloVault extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.vault = new Vault({ storage: ctx.storage, env, config, log: console });
    // A new `wrangler secret put` restarts this object with the new env; adopt it before any request is served.
    ctx.blockConcurrencyWhile(() => this.vault.ensureSeed());
  }
  lookup(gamertag, ipHash, user = null) {
    return this.vault.lookup(gamertag, ipHash, user);
  }
  cached(gamertag) {
    return this.vault.cached(gamertag);
  }
  avatar(xuid) {
    return this.vault.avatar(xuid);
  }
}

const vaultOf = (env) => env.VAULT.get(env.VAULT.idFromName('main'));
const ipHashOf = async (ip, env) => (await sha256Hex(`${ip}|${String(env.IP_SALT ?? '').trim()}`)).slice(0, 16);

async function handlePlayer(request, env) {
  const parsed = parsePlayerRequest(request, env);
  if (parsed.response) return parsed.response;
  const auth = bearerToken(request);
  if (auth?.invalid) return fail(401, 'signin_required', 'Sign in again to look players up.');
  const ip = clientIp(request);

  // Cheap per-visitor limits first (per Cloudflare location, permissive by design); the strict budgets are in the vault.
  for (const rl of [env.RL_BURST, env.RL_MINUTE]) {
    if (rl && !(await rl.limit({ key: ip })).success) return fail(429, 'rate_limited', 'Slow down a little.', { 'Retry-After': '30' });
  }

  const turnstileSecret = String(env.TURNSTILE_SECRET ?? '').trim();
  if (turnstileSecret) {
    const ok = await verifyTurnstile({ token: request.headers.get('x-turnstile-token'), secret: turnstileSecret, ip });
    if (!ok) return fail(403, 'challenge_failed', 'Verification failed. Reload the page and try again.');
  }

  const vault = vaultOf(env);
  let out;
  if (auth) out = await vault.lookup(parsed.gamertag, await ipHashOf(ip, env), auth); // the visitor's own sign-in
  else if (String(env.HALO_REFRESH_TOKEN_SEED ?? '').trim()) out = await vault.lookup(parsed.gamertag, await ipHashOf(ip, env)); // dedicated account
  else out = await vault.cached(parsed.gamertag); // signed out: only what someone signed in has already looked up
  const headers = {};
  if (out.retryAfter) headers['Retry-After'] = String(out.retryAfter);
  // Found players and "no such gamertag" may sit in the visitor's browser briefly; failures never do.
  headers['Cache-Control'] = out.status === 200 || out.status === 404 ? 'private, max-age=60' : 'no-store';
  return json(out.status, out.body, headers);
}

async function handleAvatar(request, env, xuid) {
  if (request.method !== 'GET') return fail(405, 'method_not_allowed', 'Use GET.', { Allow: 'GET' });
  if (crossSiteBlocked(request)) return fail(403, 'cross_site', 'Cross-site requests are not allowed.');
  const found = await vaultOf(env).avatar(xuid);
  if (!found) return new Response(null, { status: 404, headers: { 'Cache-Control': 'no-store' } });
  // redirect: 'manual' so a redirect can never carry the request off the Xbox image host.
  const upstream = await fetch(found.url, { redirect: 'manual', cf: { cacheEverything: true, cacheTtl: 86400 } }).catch(() => null);
  const type = upstream?.headers.get('content-type') ?? '';
  const len = Number(upstream?.headers.get('content-length') ?? 0);
  if (!upstream?.ok || !type.startsWith('image/') || len > 1_000_000) return new Response(null, { status: 404, headers: { 'Cache-Control': 'no-store' } });
  return new Response(upstream.body, {
    headers: { 'Content-Type': type, 'Cache-Control': 'public, max-age=86400', 'X-Content-Type-Options': 'nosniff', 'Cross-Origin-Resource-Policy': 'same-origin' },
  });
}

export default {
  async fetch(request, env) {
    try {
      const { pathname } = new URL(request.url);
      if (pathname === '/api/player') return await handlePlayer(request, env);
      const avatar = /^\/api\/avatar\/(\d{1,20})$/.exec(pathname);
      if (avatar) return await handleAvatar(request, env, avatar[1]);
      // The page reads this to learn whether to show the Turnstile challenge. The site key is public by design.
      // An OAuth client ID is public by design (it is in every sign-in URL), so it is safe to hand to the page.
      if (pathname === '/api/config') return json(200, { turnstileSiteKey: String(env.TURNSTILE_SECRET ?? '').trim() && String(env.TURNSTILE_SITE_KEY ?? '').trim() ? String(env.TURNSTILE_SITE_KEY).trim() : null, lookup: env.LOOKUP_ENABLED !== 'false', signin: String(env.HALO_AZURE_CLIENT_ID ?? '').trim() ? { clientId: String(env.HALO_AZURE_CLIENT_ID).trim() } : null }, { 'Cache-Control': 'no-cache' });
      return env.ASSETS.fetch(request);
    } catch (e) {
      console.error(`[worker] ${e?.name ?? 'Error'}`); // name only: never the message, which could carry request data
      return fail(500, 'internal_error', 'Something went wrong.');
    }
  },
};
