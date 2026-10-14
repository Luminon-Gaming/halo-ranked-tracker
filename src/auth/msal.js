import fs from 'node:fs/promises';
import { PublicClientApplication } from '@azure/msal-node';
import { writeFileAtomic } from '../fetch/writeAtomic.js';

// MSAL can't resolve OIDC metadata for login.live.com, so use the v2 consumers endpoint.
// Its access tokens work as an Xbox RpsTicket with the "d=" prefix the library sends.
export const SCOPES = ['XboxLive.signin', 'offline_access'];

export class AuthRequiredError extends Error {
  constructor(message = 'Not signed in. Run "npm run auth".') {
    super(message);
    this.name = 'AuthRequiredError';
  }
}

/** MSAL ICachePlugin backed by a chmod-600 JSON file (holds the refresh token). */
function fileCachePlugin(file) {
  return {
    beforeCacheAccess: async (ctx) => {
      try {
        ctx.tokenCache.deserialize(await fs.readFile(file, 'utf8'));
      } catch (e) {
        if (e.code !== 'ENOENT') throw e;
      }
    },
    afterCacheAccess: async (ctx) => {
      if (!ctx.cacheHasChanged) return;
      await writeFileAtomic(file, ctx.tokenCache.serialize(), { mode: 0o600 });
      await fs.chmod(file, 0o600).catch(() => {});
    },
  };
}

export function createMsalApp({ clientId, cacheFile }) {
  if (!clientId) throw new AuthRequiredError('HALO_AZURE_CLIENT_ID is not set. Copy .env.example to .env and add your Azure app client ID.');
  return new PublicClientApplication({
    auth: {
      clientId,
      authority: 'https://login.microsoftonline.com/consumers',
    },
    cache: { cachePlugin: fileCachePlugin(cacheFile) },
    system: { loggerOptions: { piiLoggingEnabled: false, logLevel: 0, loggerCallback: () => {} } },
  });
}

const SUCCESS_HTML = `<!doctype html><meta charset="utf-8"><title>Signed in</title>
<body style="font-family:system-ui;background:#0b0f14;color:#e6edf3;display:grid;place-items:center;height:100vh;margin:0">
<div><h1>Signed in ✔</h1><p>Halo Ranked Tracker can now refresh tokens on its own. You can close this tab.</p></div></body>`;

/** Interactive browser sign-in (first run). Opens the system browser and listens on http://localhost. */
export async function loginInteractive(app, openBrowser) {
  return app.acquireTokenInteractive({
    scopes: SCOPES,
    openBrowser: async (url) => {
      console.log(`\nOpening your browser to sign in. If it doesn't open, visit:\n${url}\n`);
      await openBrowser(url).catch(() => {});
    },
    successTemplate: SUCCESS_HTML,
    errorTemplate: '<h1>Sign-in failed</h1><p>{{error}}</p>',
  });
}

/** Silent token from the cached refresh token. Throws AuthRequiredError if a browser sign-in is needed. */
export async function getAccessTokenSilent(app) {
  const accounts = await app.getTokenCache().getAllAccounts();
  if (!accounts.length) throw new AuthRequiredError();
  try {
    const result = await app.acquireTokenSilent({ account: accounts[0], scopes: SCOPES });
    if (!result?.accessToken) throw new Error('empty token');
    return result.accessToken;
  } catch (e) {
    throw new AuthRequiredError(`Silent sign-in failed (${e.errorCode || e.message}). Run "npm run auth".`);
  }
}
