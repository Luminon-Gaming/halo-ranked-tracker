// Cloudflare Worker for the hosted copy: the Durable Object class and the entry point. Routing lives in routes.js.
// Static files are served by the assets binding; only the paths in wrangler.jsonc `run_worker_first` reach the Worker.
import { DurableObject } from 'cloudflare:workers';
import config from '../config.json';
import { Vault } from './vaultCore.js';
import { handleFetch } from './routes.js';

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

export default { fetch: handleFetch };
