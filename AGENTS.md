# AGENTS.md

Guide for AI agents working on this repo.

## What this is

A local Node.js (20.6+, ESM, plain JS, **no build step**) app that fetches Halo Infinite ranked CSR once a day for the gamertags in `accounts.txt`, writes `data/ranks.json`, and serves a dashboard at `127.0.0.1:3000` that reads only that file. Cloudflare Workers (static assets, no Worker code) hosts a static, read-only preview built from the sample data (`wrangler.jsonc` → `scripts/build-preview.js` → `.preview/`; deploy with `npm run deploy`).

## Architecture

```
accounts.txt ─┐
config.json ──┼─> fetch/runFetch.js ──> sources/HaloApiSource.js ──> halo-infinite-api (fetchFn = throttle.js)
.env ─────────┘        │                       └─ auth: msal.js (MSAL, .cache/msal.json) + tokenStore.js (.cache/halo-tokens.json)
                       ├─ fetch/normalize.js (pure: API → contract, merge, summary)
                       ├─ fetch/icons.js (tier icons → public/tiers, gamerpics → data/assets)
                       └─ writeAtomic.js → data/ranks.json, data/xuid-cache.json, .cache/last-attempt.json
server.js (node:http) ── GET /api/ranks (ETag, overlays newer last-attempt) + static public/ + /assets
scheduler.js (node-cron, in the npm start process) ── executeFetch()
```

- `runFetch()` is the pipeline core with no file IO, so it's testable. `executeFetch()` adds config loading, the lock, source creation and file writes, and never throws.
- `StatsSource` is the seam. `--dry-run` and tests use `fetch/fixtureSource.js`, which runs fake Halo endpoints (from `test/fixtures/world.json` + `csr-*.json`) through the **real** `HaloInfiniteClient`.
- Errors: auth errors (`isAuthError`) abort the run and keep the old data. Per-player and per-mode errors never stop the run, and `mergePlayers` keeps the last good data with `stale: true`.

## Conventions

- `node:` built-ins only, plus 4 pinned dependencies. No Express, dotenv or Jest. Tests use `node:test` in `test/*.test.js`.
- Contract (`data/ranks.json`, schemaVersion 1): `subTier`, `nextSubTier` and `peakSubTier` are **1-indexed** (API + 1). Status enum: `ranked | placement | unranked | not_in_rotation | unavailable | error`. If you change the shape, bump `schemaVersion` and update the README, the sample, and `public/app.js`.
- Never hardcode playlist rotation or the CSR season: use `config.rotation.*` and the per-run calendar lookup.
- Never invent endpoints or response fields. Check them against the `halo-infinite-api@14.3.2` types, and record anything unverified in `ASSUMPTIONS.md`.
- Hosted lookup (`worker/`): `index.js` routes, `guard.js` validates, `vaultCore.js` owns the dedicated account's rotating refresh token, budgets, breaker and caches inside one Durable Object. Modules the Worker bundles (`src/fetch/pipeline.js`, `src/sources/HaloClientSource.js`, `haloShared.js`, `modes.js`, `gamertag.js`, everything in `worker/`) must not import `node:*` or MSAL: `test/workerSafe.test.js` enforces it. Node can't reproduce workerd-only errors (the global `fetch` called as a method throws "Illegal invocation"), so also run changes under `npx wrangler dev`. Never log or return upstream error text, tokens or IPs.
- Front end: no framework, no external fonts or CDNs. `app.js` is about 26 KB now (player lookup, saved recents); keep it from growing further. The search box calls `/api/player` (`src/lookup.js`); a non-JSON answer means a static host with no lookup, and the page falls back to filtering the roster. Status must always carry a text label, not just a color.
- Secrets only go in `.env` and `.cache/` (git-ignored, chmod 600). Never log tokens.

## Regenerating the sample

`data/ranks.json` and `data/assets/sample-*.svg` are fixture-derived demo data (10 fictional players covering every status). If the contract changes, rebuild it with `normalize.js` from the fixtures rather than editing it by hand.

## Open items

See `ASSUMPTIONS.md` → "Still unverified": capture a live unranked response, and confirm Snipers behavior after Nov 2, 2026.
