// Request routing for the Worker. No `cloudflare:*` imports and no bindings at module load, so Node tests can run it
// with a fake env. Static files are served by the assets binding; only the paths listed in wrangler.jsonc
// `run_worker_first` reach this code: /api/player, /api/avatar/*, /api/config.
import { json, fail, clientIp, sha256Hex, crossSiteBlocked, parsePlayerRequest, bearerToken, verifyTurnstile, lookupEnabled, lookupDisabled } from './guard.js';

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

// The page reads /api/config to learn whether lookup is on and whether to show sign-in or the Turnstile challenge.
// The Turnstile site key and the OAuth client ID are public by design (both appear in the page and in sign-in URLs).
function siteConfig(env) {
  const trimmed = (v) => String(v ?? '').trim();
  return {
    lookup: true,
    turnstileSiteKey: trimmed(env.TURNSTILE_SECRET) && trimmed(env.TURNSTILE_SITE_KEY) ? trimmed(env.TURNSTILE_SITE_KEY) : null,
    signin: trimmed(env.HALO_AZURE_CLIENT_ID) ? { clientId: trimmed(env.HALO_AZURE_CLIENT_ID) } : null,
  };
}

export async function handleFetch(request, env) {
  try {
    const { pathname } = new URL(request.url);
    const avatar = /^\/api\/avatar\/(\d{1,20})$/.exec(pathname);
    const lookupRoute = pathname === '/api/player' || pathname === '/api/config' || pathname.startsWith('/api/avatar/');
    // Switched off: answer every lookup route here, before any secret, binding or the Durable Object is touched,
    // so the Worker runs with no secrets set at all. Static files and /api/ranks never reach this code.
    if (lookupRoute && !lookupEnabled(env)) {
      if (pathname === '/api/config') return json(200, { lookup: false, turnstileSiteKey: null, signin: null }, { 'Cache-Control': 'no-cache' });
      return lookupDisabled();
    }
    if (pathname === '/api/player') return await handlePlayer(request, env);
    if (avatar) return await handleAvatar(request, env, avatar[1]);
    if (pathname === '/api/config') return json(200, siteConfig(env), { 'Cache-Control': 'no-cache' });
    return env.ASSETS.fetch(request);
  } catch (e) {
    console.error(`[worker] ${e?.name ?? 'Error'}`); // name only: never the message, which could carry request data
    return fail(500, 'internal_error', 'Something went wrong.');
  }
}
