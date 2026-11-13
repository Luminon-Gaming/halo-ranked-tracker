# Handoff: make the lookup PRs mergeable (2026-11-13)

PRs: [#5 `feat/persist-view-prefs`](https://github.com/Luminon-Gaming/halo-ranked-tracker/pull/5) (base `main`) and [#6 `feat/hosted-lookup`](https://github.com/Luminon-Gaming/halo-ranked-tracker/pull/6) (base `feat/persist-view-prefs`, stacked). Nothing was merged.

## State

**#5** was rebased onto `main` (now includes #7, #8 rotation schedule, #9 CI + auto-deploy, #10 real squad data).
- Conflict: `ASSUMPTIONS.md` only. Kept main's text. Main's rotation entry stays **D12**, player lookup is now **D13**, and the "seen live" note on unverified item 1 is kept.
- Merge-gate hold (Nov 8, at `017c68c`) fixed. `src/lookup.js` now creates the source inside the auth-normalizing `try`, so an `AuthRequiredError` from `HaloApiSource.create()` becomes `LookupError(503, 'auth_required')` instead of a generic 502. A failed create is not cached, so the next lookup retries. Regression tests in `test/lookup.test.js`: `getSource()` itself throws `AuthRequiredError` → 503 (twice, with two create attempts), and `GET /api/player` → HTTP 503 `auth_required`. Both fail without the fix.
- Also fixed: on a static host (no `/api/player`), the page opened on the roster filtered to the default player, which showed one row. It now opens on the **full roster from `/api/ranks`**. A typed search or a `?player=` link still filters.

**#6** was rebased onto the new #5.
- Conflicts: `src/fetch/runFetch.js`. Main's rotation logic (`resolveRotation`, per-mode `rotation` info, schedule logs) was moved into `src/fetch/pipeline.js`, and `runFetch.js` is the thin Node wrapper. The other conflicts were `public/app.js` (Turnstile/sign-in kept alongside the roster fix) and docs. Decisions are renumbered D14 (hosted lookup, dedicated account) and D15 (visitor sign-in); unverified item 7 points at D15.
- `wrangler.jsonc`: `"LOOKUP_ENABLED": "false"`. No other change to bindings, migrations or CI.
- New `worker/routes.js` holds the routing (no `cloudflare:*` imports). While lookup is off it answers every lookup route before any secret, rate limit or the Durable Object is touched: `/api/player` and `/api/avatar/*` → `503 {"error":"lookup_disabled"}`, and `/api/config` → `200 {"lookup":false,"turnstileSiteKey":null,"signin":null}`. `worker/index.js` keeps the `HaloVault` class and `export default { fetch: handleFetch }`.
- Page: when `/api/config` says `lookup:false` (or a lookup answers `lookup_disabled`), the page skips the lookup call, opens on the full roster and says "Player lookup is switched off on this site".
- New `test/workerRoutes.test.js` covers the no-secrets, lookup-off case with a `VAULT` and rate limits that throw if touched.

## Verified locally (Node 22, wrangler 4.151.0)
- `npm test`: #5 51/51, #6 118/118. `node scripts/build-preview.js`: OK on both.
- `wrangler dev` with no secrets and no `.dev.vars`. On #5: `/` 200, `/api/ranks` 200, `/api/player` 404 (static). On #6: `/` 200, `/api/ranks` 200, `/api/player` 503 `lookup_disabled`, `/api/avatar/<xuid>` 503 `lookup_disabled`, `/api/config` 200 `{"lookup":false,...}`, nothing in the log.
- Headless Chromium against both: the default page shows all 8 squad players (no sample banner); `?player=DaLuminar` shows 1 of 8; no console errors on #6.
- `wrangler deploy --dry-run` on #6: config valid, 323 KiB upload.
- Workers Free: SQLite-backed Durable Objects (`new_sqlite_classes`) are available on Free. The `ratelimits` config is valid (period 10/60, integer-string namespace IDs), and the docs list no plan restriction for that binding. Not proven against the real account until the first deploy.

## What's left
1. CI on both heads (see the PRs). #6 targets a non-main base. The CI workflow runs on every `pull_request` regardless of base, so it should trigger; if it doesn't, local results are in the PR.
2. Merge #5, then retarget #6 to `main` (GitHub does this when the base branch is deleted on merge; otherwise change it by hand) and check that CI is green again.
3. Merging #6 auto-deploys (`deploy.yml`). The first deploy creates the `HaloVault` namespace (migration `v1`) and the two ratelimit namespaces. Lookup stays off, so no secrets are needed, and the smoke test (`/`, `/api/ranks`) should pass.
4. Out of scope, still open: a real visitor sign-in (ASSUMPTIONS item 7), Azure SPA redirect URIs, Cloudflare secrets, and removing the dedicated-account path.

## How to resume
```bash
git fetch origin
git checkout feat/persist-view-prefs && git reset --hard origin/feat/persist-view-prefs
npm ci && npm test && node scripts/build-preview.js
git checkout feat/hosted-lookup && git reset --hard origin/feat/hosted-lookup
npm test && node scripts/build-preview.js && npx wrangler@4.151.0 dev   # no secrets; lookup routes answer lookup_disabled
```
If #5 changes again: `git rebase --onto feat/persist-view-prefs <old #5 head> feat/hosted-lookup`, then `git push --force-with-lease`.
