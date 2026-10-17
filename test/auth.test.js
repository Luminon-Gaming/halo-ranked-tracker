// public/auth.js with the browser's globals stubbed: PKCE, the redirect handling, token refresh. Synthetic tokens only.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { challengeFor, randomString, authorizeUrl, isRedirect, beginSignIn, finishRedirect, accessToken, signedIn, signOut, takeNotice } from '../public/auth.js';

let session, nav, requests, respond;
beforeEach(() => {
  const m = new Map();
  session = m;
  globalThis.sessionStorage = { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => void m.set(k, String(v)), removeItem: (k) => void m.delete(k) };
  nav = { assigned: null, replaced: null };
  globalThis.location = { origin: 'https://halo.example', pathname: '/', search: '', assign: (u) => (nav.assigned = u), replace: (u) => (nav.replaced = u) };
  requests = [];
  respond = () => new Response(JSON.stringify({ access_token: 'access-1', refresh_token: 'refresh-1', expires_in: 3600 }), { status: 200 });
  globalThis.fetch = async (url, init) => {
    requests.push({ url: String(url), body: new URLSearchParams(String(init.body)) });
    return respond(requests.length);
  };
});

test('the PKCE challenge matches the RFC 7636 example', async () => {
  assert.equal(await challengeFor('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk'), 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
});

test('random strings are URL-safe and different each time', () => {
  const a = randomString(32);
  assert.match(a, /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(a, randomString(32));
});

test('the authorize URL asks for the consumer endpoint, S256, the Xbox scope and this site\'s exact redirect', () => {
  const u = new URL(authorizeUrl({ clientId: 'cid', redirectUri: 'https://halo.example/', state: 's', challenge: 'c' }));
  assert.equal(u.origin + u.pathname, 'https://login.microsoftonline.com/consumers/oauth2/v2.0/authorize');
  const p = u.searchParams;
  assert.equal(p.get('response_type'), 'code');
  assert.equal(p.get('code_challenge_method'), 'S256');
  assert.equal(p.get('scope'), 'XboxLive.signin offline_access');
  assert.equal(p.get('redirect_uri'), 'https://halo.example/');
  assert.equal(p.get('state'), 's');
});

test('only a return from Microsoft counts as a redirect', () => {
  assert.equal(isRedirect('?code=abc&state=s'), true);
  assert.equal(isRedirect('?error=access_denied&state=s'), true);
  assert.equal(isRedirect('?player=DaLuminar'), false);
  assert.equal(isRedirect('?code=abc'), false, 'no state: not ours');
  assert.equal(isRedirect(''), false);
});

test('signing in leaves the page with a stored verifier/state and returns to where the visitor was', async () => {
  location.pathname = '/';
  location.search = '?player=Nova%20Kestrel';
  await beginSignIn('cid');
  const url = new URL(nav.assigned);
  const pending = JSON.parse(session.get('auth-pending'));
  assert.equal(url.searchParams.get('state'), pending.state);
  assert.equal(url.searchParams.get('code_challenge'), await challengeFor(pending.verifier));
  assert.equal(pending.returnTo, '/?player=Nova+Kestrel');
  location.search = '?view=roster';
  await beginSignIn('cid');
  assert.equal(JSON.parse(session.get('auth-pending')).returnTo, '/', 'the roster fallback is not carried back');
  assert.doesNotMatch(nav.assigned, new RegExp(pending.verifier), 'the verifier never goes in the URL');
});

async function comeBack(search) {
  location.search = search;
  await finishRedirect();
}

test('a matching return redeems the code with the verifier, keeps tokens in sessionStorage and reloads the original page', async () => {
  await beginSignIn('cid');
  const pending = JSON.parse(session.get('auth-pending'));
  await comeBack(`?code=the-code&state=${pending.state}`);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, 'https://login.microsoftonline.com/consumers/oauth2/v2.0/token');
  const b = requests[0].body;
  assert.equal(b.get('grant_type'), 'authorization_code');
  assert.equal(b.get('code'), 'the-code');
  assert.equal(b.get('code_verifier'), pending.verifier);
  assert.equal(b.get('redirect_uri'), 'https://halo.example/');
  assert.equal(b.get('client_id'), 'cid');
  assert.equal(signedIn(), true);
  assert.equal(await accessToken(), 'access-1');
  assert.equal(session.has('auth-pending'), false, 'single use');
  assert.equal(nav.replaced, '/');
});

test('a wrong state is refused without contacting Microsoft', async () => {
  await beginSignIn('cid');
  await comeBack('?code=the-code&state=forged');
  assert.equal(requests.length, 0);
  assert.equal(signedIn(), false);
  assert.match(takeNotice(), /could not be verified/);
  assert.equal(takeNotice(), null, 'shown once');
});

test('a return with no sign-in in progress is refused too', async () => {
  await comeBack('?code=the-code&state=whatever');
  assert.equal(requests.length, 0);
  assert.equal(signedIn(), false);
});

test('cancelling, or Microsoft refusing the code, signs nobody in and says so', async () => {
  await beginSignIn('cid');
  let pending = JSON.parse(session.get('auth-pending'));
  await comeBack(`?error=access_denied&state=${pending.state}&error_description=secret`);
  assert.match(takeNotice(), /cancelled/);
  await beginSignIn('cid');
  pending = JSON.parse(session.get('auth-pending'));
  respond = () => new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 });
  await comeBack(`?code=bad&state=${pending.state}`);
  assert.equal(signedIn(), false);
  assert.match(takeNotice(), /could not complete/);
});

test('an expired access token is refreshed with the rotating refresh token; a rejected refresh signs out', async () => {
  session.set('auth-tokens', JSON.stringify({ clientId: 'cid', access: 'old', exp: Date.now() - 1000, refresh: 'refresh-0' }));
  const [a, b] = await Promise.all([accessToken(), accessToken()]);
  assert.deepEqual([a, b], ['access-1', 'access-1']);
  assert.equal(requests.length, 1, 'concurrent callers share one refresh');
  assert.equal(requests[0].body.get('grant_type'), 'refresh_token');
  assert.equal(requests[0].body.get('refresh_token'), 'refresh-0');
  assert.equal(JSON.parse(session.get('auth-tokens')).refresh, 'refresh-1', 'rotated token kept');
  session.set('auth-tokens', JSON.stringify({ clientId: 'cid', access: 'old', exp: Date.now() - 1000, refresh: 'refresh-1' }));
  respond = () => { throw new TypeError('network down'); };
  assert.equal(await accessToken(), null);
  assert.equal(signedIn(), true, 'offline: still signed in');
  respond = () => new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 });
  assert.equal(await accessToken(), null);
  assert.equal(signedIn(), false);
});

test('signing out forgets the tokens; signed out means no token at all', async () => {
  session.set('auth-tokens', JSON.stringify({ clientId: 'cid', access: 'a', exp: Date.now() + 3_600_000, refresh: 'r' }));
  assert.equal(await accessToken(), 'a');
  signOut();
  assert.equal(await accessToken(), null);
  assert.equal(requests.length, 0);
});

test('tokens are never written to localStorage', async () => {
  globalThis.localStorage = { setItem() { throw new Error('localStorage must not be used for tokens'); }, getItem: () => null };
  await beginSignIn('cid');
  const pending = JSON.parse(session.get('auth-pending'));
  await comeBack(`?code=the-code&state=${pending.state}`);
  assert.equal(signedIn(), true);
  delete globalThis.localStorage;
});
