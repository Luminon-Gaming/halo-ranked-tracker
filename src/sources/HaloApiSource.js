import { HaloInfiniteClient, AutoTokenProvider } from 'halo-infinite-api';
import { HaloClientSource } from './HaloClientSource.js';
import { createMsalApp, getAccessTokenSilent, AuthRequiredError } from '../auth/msal.js';
import { createFileTokenPersister } from '../auth/tokenStore.js';
import { createThrottledFetch } from '../fetch/throttle.js';
import { env } from '../config.js';

export { statusOf, isAuthError, pickCsrSeason } from './haloShared.js';

/**
 * halo-infinite-api's ExpiryTokenCache rejects its internal ResolvablePromise when a token fetch fails, then rethrows
 * the same error to the caller. With no concurrent waiter that promise has no handler, and Node's default
 * unhandled-rejection mode kills the process (including `npm start`). The caller already received the error, so
 * those orphans are dropped; any other unhandled rejection is rethrown to keep Node's crash behaviour.
 */
let orphanGuardInstalled = false;
function ignoreTokenCacheOrphans() {
  if (orphanGuardInstalled) return;
  orphanGuardInstalled = true;
  process.on('unhandledRejection', (reason, promise) => {
    if (promise?.constructor?.name === 'ResolvablePromise') return;
    throw reason;
  });
}

/** Spartan token pasted from browser DevTools (testing only; short-lived). */
export class StaticSpartanTokenProvider {
  constructor(token) {
    this.token = token;
  }
  async getSpartanToken() {
    return this.token;
  }
  async getCurrentExpiration() {
    return null;
  }
  async clearSpartanToken() {}
}

/** The local source: MSAL sign-in cached in .cache/, file-backed Halo tokens. */
export class HaloApiSource extends HaloClientSource {
  /** Builds a source from .env: HALO_SPARTAN_TOKEN (static) or MSAL silent refresh. */
  static create({ config, paths, log = console, baseFetch = fetch }) {
    const fetchFn = createThrottledFetch(baseFetch, { ...config.throttle, log });
    const { clientId, spartanToken } = env();
    let provider;
    if (spartanToken) {
      log.warn?.('[auth] Using HALO_SPARTAN_TOKEN from .env (testing shortcut; expires in a few hours)');
      provider = new StaticSpartanTokenProvider(spartanToken);
    } else {
      if (!clientId) throw new AuthRequiredError('No credentials: set HALO_AZURE_CLIENT_ID in .env and run "npm run auth".');
      ignoreTokenCacheOrphans();
      const app = createMsalApp({ clientId, cacheFile: paths.msalCache });
      provider = new AutoTokenProvider(() => getAccessTokenSilent(app), createFileTokenPersister(paths.haloTokens), fetchFn);
    }
    return new HaloApiSource({ client: new HaloInfiniteClient(provider, fetchFn), assetFetch: baseFetch, log });
  }
}
