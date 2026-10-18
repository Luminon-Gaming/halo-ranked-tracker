// Microsoft sign-in for the hosted page: authorization code + PKCE, no library. The page redeems the code itself at
// Microsoft's token endpoint (allowed cross-origin for "Single-page application" redirect URIs) and sends the access
// token to /api/player. Tokens stay in sessionStorage (gone when the tab closes), never localStorage, and are never
// written to the page or the URL.
const BASE = 'https://login.microsoftonline.com/consumers/oauth2/v2.0';
const SCOPE = 'XboxLive.signin offline_access';
const PENDING = 'auth-pending'; // PKCE verifier + state between leaving for Microsoft and coming back
const TOKENS = 'auth-tokens'; // { clientId, access, exp, refresh }
const NOTICE = 'auth-notice'; // one-time message for the page after a failed sign-in

const store = {
  get(k) {
    try {
      return JSON.parse(sessionStorage.getItem(k));
    } catch {
      return null;
    }
  },
  set(k, v) {
    try {
      sessionStorage.setItem(k, JSON.stringify(v));
    } catch {}
  },
  del(k) {
    try {
      sessionStorage.removeItem(k);
    } catch {}
  },
};

const b64url = (bytes) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
export const randomString = (bytes = 32) => b64url(crypto.getRandomValues(new Uint8Array(bytes)));
export async function challengeFor(verifier) {
  return b64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))));
}

export function authorizeUrl({ clientId, redirectUri, state, challenge }) {
  const q = new URLSearchParams({
    client_id: clientId,
    response_type: 'code',
    redirect_uri: redirectUri,
    scope: SCOPE,
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    prompt: 'select_account',
  });
  return `${BASE}/authorize?${q}`;
}

const redirectUri = () => `${location.origin}/`;

export const signedIn = () => Boolean(store.get(TOKENS)?.refresh);
export const signOut = () => store.del(TOKENS);
/** A message left by a failed sign-in, shown once. */
export function takeNotice() {
  const n = store.get(NOTICE);
  store.del(NOTICE);
  return n;
}

export async function beginSignIn(clientId) {
  const verifier = randomString(48);
  const state = randomString(16);
  // The page falls back to ?view=roster when a lookup needs a sign-in; coming back should retry the lookup instead.
  const back = new URLSearchParams(location.search);
  back.delete('view');
  store.set(PENDING, { clientId, verifier, state, returnTo: `${location.pathname}${back.size ? `?${back}` : ''}` });
  location.assign(authorizeUrl({ clientId, redirectUri: redirectUri(), state, challenge: await challengeFor(verifier) }));
}

/** True when this page load is Microsoft sending the visitor back. */
export const isRedirect = (search = location.search) => {
  const p = new URLSearchParams(search);
  return p.has('state') && (p.has('code') || p.has('error'));
};

async function tokenRequest(params) {
  const res = await fetch(`${BASE}/token`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(params) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.access_token) throw new Error(String(data.error ?? res.status).slice(0, 40));
  return data;
}

const keep = (clientId, data, previous = null) =>
  store.set(TOKENS, { clientId, access: data.access_token, exp: Date.now() + Number(data.expires_in ?? 3600) * 1000, refresh: data.refresh_token ?? previous });

/** Redeems the code, then reloads the page the visitor came from. Never returns to the caller's flow. */
export async function finishRedirect() {
  const p = new URLSearchParams(location.search);
  const pending = store.get(PENDING);
  store.del(PENDING);
  let notice = null;
  if (!pending || p.get('state') !== pending.state) notice = 'The sign-in could not be verified. Try again.';
  else if (p.has('error')) notice = p.get('error') === 'access_denied' ? 'Sign-in was cancelled.' : 'Microsoft could not sign you in. Try again.';
  else {
    try {
      keep(pending.clientId, await tokenRequest({ client_id: pending.clientId, grant_type: 'authorization_code', code: p.get('code'), redirect_uri: redirectUri(), code_verifier: pending.verifier, scope: SCOPE }));
    } catch {
      notice = 'Microsoft could not complete the sign-in. Try again.';
    }
  }
  if (notice) store.set(NOTICE, notice);
  // Same-site paths only: "//host" and "/\host" would be read as another origin.
  const back = pending?.returnTo;
  location.replace(typeof back === 'string' && /^\/(?![/\\])/.test(back) ? back : '/');
}

let refreshing = null;
/** A valid access token, refreshed when it is about to expire; null when the visitor is signed out. */
export function accessToken() {
  const t = store.get(TOKENS);
  if (!t) return Promise.resolve(null);
  if (t.exp - Date.now() > 60_000) return Promise.resolve(t.access);
  refreshing ??= tokenRequest({ client_id: t.clientId, grant_type: 'refresh_token', refresh_token: t.refresh, scope: SCOPE })
    .then((data) => (keep(t.clientId, data, t.refresh), data.access_token))
    .catch((e) => (e instanceof TypeError ? null : (signOut(), null))) // offline keeps the sign-in; a rejection from Microsoft ends it
    .finally(() => (refreshing = null));
  return refreshing;
}

/** Draws the sign-in / sign-out button into `box`. `onChange` runs after the visitor signs out. */
export function mountAuth(box, { clientId, onChange }) {
  const draw = () => {
    box.textContent = '';
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'btn';
    if (signedIn()) {
      b.textContent = 'Sign out';
      b.addEventListener('click', () => (signOut(), draw(), onChange?.()));
      const s = document.createElement('span');
      s.className = 'chip chip-info';
      s.textContent = 'Signed in';
      box.append(s, b);
    } else {
      b.textContent = 'Sign in with Microsoft';
      b.addEventListener('click', () => beginSignIn(clientId));
      box.append(b);
    }
  };
  draw();
  return draw;
}
