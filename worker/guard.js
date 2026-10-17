// Request checks for the public lookup endpoints. Pure functions: no bindings, so they are unit-tested directly.
import { looksLikeGamertag } from '../src/gamertag.js';

export const API_HEADERS = {
  'Content-Type': 'application/json; charset=utf-8',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Cross-Origin-Resource-Policy': 'same-origin',
};

/** JSON response with the API headers. No CORS headers on purpose: only this site's own page may read it. */
export function json(status, body, extra = {}) {
  return new Response(JSON.stringify(body), { status, headers: { ...API_HEADERS, 'Cache-Control': 'no-store', ...extra } });
}

export const fail = (status, error, message, extra) => json(status, { error, message }, extra);

/** The visitor's address as Cloudflare saw it. Never trust X-Forwarded-For. */
export const clientIp = (request) => request.headers.get('cf-connecting-ip') || 'unknown';

export async function sha256Hex(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Browsers always label cross-site requests; reject them, and reject an Origin that isn't this host.
 * Requests with neither header (curl, scripts) pass here and still hit the rate limits below.
 */
export function crossSiteBlocked(request) {
  const site = request.headers.get('sec-fetch-site');
  if (site && site !== 'same-origin' && site !== 'none') return true;
  const origin = request.headers.get('origin');
  if (origin) {
    try {
      if (new URL(origin).host !== new URL(request.url).host) return true;
    } catch {
      return true;
    }
  }
  return false;
}

/**
 * Validates a /api/player request. Returns { gamertag } or { response } to send back.
 * Order matters: cheap checks first, nothing here touches Halo.
 */
export function parsePlayerRequest(request, env = {}) {
  if (env.LOOKUP_ENABLED === 'false') return { response: fail(503, 'lookup_disabled', 'Player lookup is switched off right now.', { 'Retry-After': '600' }) };
  if (request.method !== 'GET') return { response: fail(405, 'method_not_allowed', 'Use GET.', { Allow: 'GET' }) };
  if (crossSiteBlocked(request)) return { response: fail(403, 'cross_site', 'Cross-site requests are not allowed.') };
  const url = new URL(request.url);
  const keys = [...url.searchParams.keys()];
  if (keys.length !== 1 || keys[0] !== 'gamertag' || url.searchParams.getAll('gamertag').length !== 1) {
    return { response: fail(400, 'invalid_request', 'Send exactly one "gamertag" parameter.') };
  }
  const raw = url.searchParams.get('gamertag');
  if (raw.length > 40) return { response: fail(400, 'invalid_gamertag', 'Enter a gamertag like "Name" or "Name#1234".') };
  const gamertag = raw.trim().replace(/\s+/g, ' ');
  if (!gamertag || !looksLikeGamertag(gamertag)) return { response: fail(400, 'invalid_gamertag', 'Enter a gamertag like "Name" or "Name#1234".') };
  return { gamertag };
}

/** Verifies a Cloudflare Turnstile token. Only called when TURNSTILE_SECRET is set. */
export async function verifyTurnstile({ token, secret, ip, fetchFn = fetch }) {
  if (!token || token.length > 2048) return false;
  const body = new URLSearchParams({ secret, response: token });
  if (ip && ip !== 'unknown') body.set('remoteip', ip);
  try {
    const res = await fetchFn('https://challenges.cloudflare.com/turnstile/v0/siteverify', { method: 'POST', body });
    return res.ok && (await res.json()).success === true;
  } catch {
    return false;
  }
}

/** Allowed avatar hosts: only Xbox's image CDN, only https. */
export function avatarUrlAllowed(url) {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && /(^|\.)xboxlive\.com$/.test(u.hostname);
  } catch {
    return false;
  }
}
