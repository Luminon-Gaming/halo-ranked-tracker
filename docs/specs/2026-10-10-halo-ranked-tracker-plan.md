> **Historical spec (Oct 10, 2026).** This is the pre-build plan the app was built from. The repo has since moved on (Cloudflare Workers preview, player lookup PRs #5/#6, Azure sign-in). For current behavior see `AGENTS.md`, `README.md` and `ASSUMPTIONS.md`. Rotation dates below were accurate on Oct 10; Snipers leaves rotation after Nov 2, 2026 and ranks reset Nov 3.

<!--
Plan improvement log
- Round 1: Perplexity Computer, "Improve this plan for oneshot execution" + v1 prompt.
  https://www.perplexity.ai/computer/tasks/98e2d34b-4b9a-47fb-8d5c-a3a241caa0fa
- Round 2 (same thread): targeted check on Snipers rotation + playlist GUIDs. Perplexity retracted its S&D Extraction claim.
Accepted from Perplexity: halo-infinite-api instead of grunt, MSAL auth step, batched CSR calls, status enum,
  decisions table, acceptance tests, atomic write/merge/lock, 127.0.0.1 bind, no scraper.
Added from independent fact-check: 4 verified playlist GUIDs pre-filled, SubTier is 0-indexed (display +1),
  public official tier icon URL pattern (verified 200s), CSR endpoints 401 without token,
  exact library export names checked from the 14.3.2 tarball, per-run season lookup.
Rejected: "Snipers not live / S&D Extraction until Nov 2" (older Nov 2025 patch notes; superseded by Aug 25, 2026 page),
  placeholder tier icon set (official icons are public), playlist IDs left null.
-->
# Halo Infinite Ranked Tracker: Build Spec (one-shot, v2)

Build a Node.js 20.6+ app (ESM, plain JavaScript, no build step) that fetches Halo Infinite ranked CSR once a day for a list of gamertags, saves it to `data/ranks.json`, and serves a local dark esports-style dashboard that reads only that file.

Work top to bottom. If something is unclear, use the default in section 2 and write it down in `ASSUMPTIONS.md` instead of stopping. Never invent an endpoint, playlist ID, or response field. Anything unconfirmed goes in `config.json` or is checked at runtime by `npm run discover`.

## 1. Verified facts (checked Oct 10, 2026)

Build on these. Don't re-derive them.

**Library:** `halo-infinite-api@14.3.2` (npm, last published Aug 17, 2026). ESM + CJS, `engines: node >=20`, subpath export `halo-infinite-api/token-persisters`.
- `HaloInfiniteClient(spartanTokenProvider)` has `getUser(gamertag)`, `getUsers(xuids[])`, `getPlaylistCsr(playlistId, playerIds[], seasonId?)` → `Promise<ResultContainer<PlaylistCsrContainer>[]>`, `getPlaylist(id)`, `getSeasonCalendar()`, `getProgressionFile()`.
- Token providers: `AutoTokenProvider` (also exported as `AutoXstsSpartanTokenProvider`), which runs Xbox user token → XSTS → Spartan token and takes a `TokenPersister`. There's also `StaticXstsTicketTokenSpartanTokenProvider`.
- The library does NOT do the first Microsoft OAuth step. Use `@azure/msal-node` `PublicClientApplication` with `authority: "https://login.live.com"`, `knownAuthorities: ["login.live.com"]`, `protocolMode: "OIDC"`, and scopes `Xboxlive.signin` and `Xboxlive.offline_access`. This requires your own Azure app registration.
- Do NOT use `grunt`. The original is a .NET library and its repo was deleted. The Node port is `@dendotdev/grunt` (v1.0.15, Apr 2026). The `@dendev/grunt` name in old docs returns 404. Use it as a reference only.

**Auth is required.** The CSR and GameCMS endpoints return 401 without a Spartan token (`x-343-authorization-spartan` header). No API key is involved. Ignore any site that describes an "official Halo Stats API key"; that API doesn't exist.

**Endpoints** (for reference and fixtures only; call them through the library):
- `profile.svc.halowaypoint.com/users/{gamertag}` (gamertag → XUID)
- `skill.svc.halowaypoint.com/hi/playlist/{playlistId}/csrs?players=xuid(...),...` (many players per call; optional `&season=CsrSeasonN-N`)

**CSR response:** each result has `Current`, `SeasonMax`, and `AllTimeMax`. Each of those has `Value, MeasurementMatchesRemaining, Tier, TierStart, SubTier, NextTier, NextTierStart, NextSubTier, InitialMeasurementMatches, DemotionProtectionMatchesRemaining, InitialDemotionProtectionMatches`.
- **SubTier is 0-indexed.** Known example: CSR 997, Tier "Platinum", TierStart 950, SubTier 1 = Platinum 2. Display it as `SubTier + 1` (1–6). Onyx has a single tier (1500+), with no sub-tiers and no next tier.
- `MeasurementMatchesRemaining > 0` means the player is still in placement matches.

**Ranked playlist IDs** (from current Waypoint leaderboard URLs, CSR season `CsrSeason13-3`). Pre-fill `config.json` with these and have `npm run discover` verify them:

| Mode | Playlist GUID |
|---|---|
| Ranked Arena | `edfef3ac-9cbe-4fa2-b949-8f29deafd483` |
| Ranked Doubles | `fa5aa2a3-2428-4912-a023-e1eeea7b877c` |
| Ranked Slayer | `dcb2e24e-05fb-4390-8076-32a0cdb4326e` |
| Ranked Snipers | `6233381c-fc96-40b9-b1ff-f6a4de72dd7a` |

**Rotation** (official Halo Support playlists page, updated Aug 25, 2026):
- Arena, Doubles, and Slayer are permanent.
- Snipers rotates. It's **live now** (Sep 1 to Nov 2, 2026, extended), then out until **Feb 2 to Mar 1, 2027**. Ignore the older Operation: Infinite patch notes (Nov 18, 2025), which listed Sep 29 to Nov 2 as S&D Extraction; that was superseded.
- Next rank reset: **Nov 3, 2026**. Expect a wave of `placement` statuses after it.
- Never hardcode the rotation. Use the `config.rotation.snipers` flag plus API behavior.

**Rank tier icons are public** (no auth, verified HTTP 200):
`https://www.halowaypoint.com/images/halo-infinite/csr/{tier}_{n}.png`, where `tier` is lowercase.
- `n = SubTier + 1` (1–6) for bronze, silver, gold, platinum, and diamond
- `onyx_1` for Onyx
- `unranked_0`–`unranked_5` for placement progress
- `bronze_0`, `bronze_7`, and `onyx_2` return 404

## 2. Decisions and defaults (confirm before building)

| # | Decision | Default |
|---|---|---|
| D1 | Auth | `npm run auth` = MSAL interactive login once, then silent refresh from a cached refresh token. Fallback for testing only: paste a Spartan token from browser DevTools into `.env` (`HALO_SPARTAN_TOKEN`, short-lived). |
| D2 | Azure app | Register a "Personal Microsoft accounts only" public client (Mobile & desktop) app with redirect `http://localhost`. Put the client ID in `.env`. |
| D3 | Whose account | A personal or dedicated Xbox account that owns Halo Infinite. Other players don't need to sign in. |
| D4 | Snipers out of rotation | Still query its playlist. If data comes back, show it dimmed as `not_in_rotation`. Otherwise show `unavailable`. Keep the column. |
| D5 | Tier icons | At fetch time, download the official icons from the URL pattern above into `public/tiers/` (once, cached). `tierIconUrl` is a local path. Fall back to a simple built-in SVG badge if the download fails. |
| D6 | "Logo" | Xbox gamerpic from `getUsers` (`gamerpic.medium`). Spartan emblem is a stretch goal behind `config.emblemSource = "gamerpic" \| "spartan-emblem"` (needs the economy appearance endpoint, GameCMS lookups, and color compositing). |
| D7 | Image hosting | Download emblems to `data/assets/{xuid}.png` at fetch time. The dashboard never hotlinks and never needs a token. |
| D8 | Scraper | Don't build one. Ship a `StatsSource` interface plus a `ScraperSource` stub that throws `NotImplemented`. Halo Tracker's ToS restricts automated access, and Waypoint leaderboards only list Onyx players. |
| D9 | Scheduler | `node-cron` with an IANA timezone, inside the `npm start` process. Also fetch on boot if `ranks.json` is missing or older than 24h. |
| D10 | Network | Bind to `127.0.0.1` only. |

## 3. Project layout

```
halo-ranked-tracker/
  package.json        # "type":"module", engines node>=20.6, pinned deps
  config.json  .env.example  .gitignore  accounts.txt  ASSUMPTIONS.md  README.md
  src/
    config.js  accounts.js  scheduler.js  server.js
    auth/      msal.js (file-backed MSAL cache)  tokenStore.js (TokenPersister -> .cache/halo-tokens.json, chmod 600)
    sources/   StatsSource.js  HaloApiSource.js  ScraperSource.js (stub)
    fetch/     runFetch.js  normalize.js (pure)  throttle.js  writeAtomic.js  icons.js
    cli/       auth.js  discover.js  fetch.js   # npm run auth | discover | fetch [--dry-run] [--only=gt]
  public/      index.html  styles.css  app.js  tiers/
  data/        ranks.json (committed sample)  xuid-cache.json  assets/
  test/        fixtures/csr-*.json  *.test.js (node:test)
```

Dependencies: `halo-infinite-api@14.3.2`, `@azure/msal-node`, `node-cron`, `open`. Use `node --env-file=.env` (no dotenv), `node:http` (no Express), and `node:test` (no Jest).

## 4. Behavior

**accounts.txt:** trim lines, skip blanks and `#` comments, dedupe case-insensitively, and keep the first spelling for display. Warn on gamertags that don't look valid (1–15 characters, optional `#1234` suffix) but still try them.

**Auth:** `acquireTokenInteractive` once. The MSAL cache lives in `.cache/msal.json`. Later runs use `acquireTokenSilent`. If that fails, log `Run "npm run auth"`, mark the run failed, and keep the old data. Spartan and XSTS tokens are persisted through `TokenPersister`. If `HALO_SPARTAN_TOKEN` is set, use the static provider and skip MSAL.

**Discover (`npm run discover`):** verify the four pre-filled playlist IDs with `getPlaylist(id)` (print the names) and read the current CSR season from the CSR calendar (`getProgressionFile` / `getSeasonCalendar`). Print a table. If an ID fails, set it to `null` with a hint (Waypoint leaderboard URLs contain the GUID). A `null` playlist means that mode is `unavailable` for everyone.

**Fetch run:**
1. Resolve XUIDs from `xuid-cache.json`, calling `getUser` only on a cache miss. A 404 sets `error: "gamertag_not_found"`.
2. For each mode with a playlist ID, call `getPlaylistCsr` in batches of `csrBatchSize` (default 25). Confirm the player ID format the library expects (bare XUID or `xuid(...)`) against a fixture.
3. Call `getUsers(xuids)` in batches to refresh gamertag spelling and gamerpic, and download changed images.
4. Normalize each result (section 5). A per-player or per-mode error never stops the run.
5. Throttle: `concurrency` 2, `delayMs` 500. Retry 429, 5xx, and network errors up to 4 times with exponential backoff and jitter, honoring `Retry-After`. On a 401, refresh the token once and retry.
6. Read the current CSR season ID at the start of every run (CSR calendar) instead of hardcoding it. The Nov 3, 2026 reset will start a new season.
7. Merge with the previous file. Failed players keep their last good modes with `stale: true` plus the error. If every player failed, don't write anything.
8. Write atomically (temp file in the same directory, fsync, rename). Log a summary like `ok=12 placement=3 unranked=5 errors=1 duration=8.2s`.

**Scheduler:** `{ "cron": "0 6 * * *", "timezone": "America/New_York" }`, with a lock file `.cache/fetch.lock` that holds the PID and detects stale locks.

## 5. Data contract (`data/ranks.json`)

```json
{
  "schemaVersion": 1,
  "lastUpdated": "2026-10-10T10:00:04.512Z",
  "lastAttempt": { "at": "...", "ok": true, "errors": 0 },
  "csrSeasonId": "CsrSeason13-3",
  "modes": {
    "arena":   { "label": "Ranked Arena",   "playlistId": "edfef3ac-...", "inRotation": true },
    "doubles": { "label": "Ranked Doubles", "playlistId": "fa5aa2a3-...", "inRotation": true },
    "slayer":  { "label": "Ranked Slayer",  "playlistId": "dcb2e24e-...", "inRotation": true },
    "snipers": { "label": "Ranked Snipers", "playlistId": "6233381c-...", "inRotation": true }
  },
  "players": [{
    "gamertag": "Example", "xuid": "2533274...", "emblemUrl": "/assets/2533274....png",
    "stale": false, "error": null,
    "modes": { "arena": {
      "status": "ranked", "csr": 1512, "tier": "Diamond", "subTier": 1,
      "tierStartCsr": 1500, "nextTier": "Diamond", "nextSubTier": 2, "nextTierCsr": 1550,
      "progressPct": 24, "matchesRemaining": 0,
      "peakCsr": 1580, "peakTier": "Diamond", "peakSubTier": 2, "allTimePeakCsr": 1704,
      "tierIconUrl": "/tiers/diamond_1.png"
    } }
  }]
}
```

- `subTier` / `peakSubTier` / `nextSubTier` are stored **1-indexed** (API value + 1).
- Status enum: `ranked | placement | unranked | not_in_rotation | unavailable | error`.
- `placement`: `MeasurementMatchesRemaining > 0`. Show "Placement · N left" with the `unranked_{InitialMeasurementMatches - MeasurementMatchesRemaining}` icon.
- `unranked`: no CSR value, or the API's unranked sentinel. Capture the real sentinel (`Value: -1` and/or `Tier: "Unranked"`) from a live response into a fixture before finalizing `normalize.js`.
- Onyx: `nextTierCsr` is null, and the UI shows CSR only.
- `progressPct = round((csr - tierStartCsr) / (nextTierCsr - tierStartCsr) * 100)`, clamped to 0–100.

## 6. Dashboard

`npm start` → `http://127.0.0.1:3000`. `GET /api/ranks` returns the file with `Cache-Control: no-cache` and an ETag. The page never contacts Halo services.
- **Layout:** dark esports theme with CSS variables and an accent color from config. On desktop, a semantic table with one row per player: emblem, gamertag, then 4 mode cells (tier icon, "Diamond 3", CSR, and a thin progress bar). Under 720px, rows become cards with a 2×2 mode grid.
- **Controls:** debounced case-insensitive gamertag filter, and sort by gamertag or any mode's CSR (ascending or descending). Unranked and unavailable players always sort last. Sort and filter state is kept in the URL query.
- **Header:** "Last updated 6:00 AM (3h ago)", with a warning badge if the data is over 26h old or the last attempt failed.
- **States:** each non-ranked status gets its own muted style. Stale players get an amber dot with the error in a tooltip. If there's no data yet, show a hint to run `npm run fetch`.
- **Performance and accessibility:** no framework, `app.js` under about 15 KB, no external fonts or CDNs, lazy-loaded images with width and height set, and 200 players rendering in under 50 ms. Alt text is the tier name, focus states are visible, contrast meets AA, and status is never shown by color alone.

## 7. Config (`config.json`)

```json
{
  "port": 3000, "host": "127.0.0.1",
  "schedule": { "cron": "0 6 * * *", "timezone": "America/New_York", "fetchOnBootIfStaleHours": 24 },
  "throttle": { "concurrency": 2, "delayMs": 500, "maxRetries": 4, "baseBackoffMs": 1000, "csrBatchSize": 25 },
  "playlists": {
    "arena": "edfef3ac-9cbe-4fa2-b949-8f29deafd483",
    "doubles": "fa5aa2a3-2428-4912-a023-e1eeea7b877c",
    "slayer": "dcb2e24e-05fb-4390-8076-32a0cdb4326e",
    "snipers": "6233381c-fc96-40b9-b1ff-f6a4de72dd7a"
  },
  "rotation": { "snipers": true },
  "emblemSource": "gamerpic",
  "accountsFile": "accounts.txt",
  "dataFile": "data/ranks.json"
}
```

Validate on startup. Unknown keys produce a warning. Wrong types produce an error that names the key.

## 8. Done when

1. `npm install && npm start` with no `.env` serves the sample `ranks.json`. The sample has 8 or more players and covers every status, Onyx, placement, stale, and a long gamertag.
2. `npm test` passes. It covers accounts parsing, normalizing each fixture into each status, SubTier 0→1 conversion, progress math (including Onyx), the icon filename mapping, retry/backoff (429 then 200, respecting `Retry-After`), atomic write keeping the old file when a write fails, and merging after a player error.
3. `npm run fetch -- --dry-run` runs the full pipeline on fixtures without touching the network.
4. With real credentials, `npm run auth` → `npm run discover` (all four IDs resolve to the right names) → `npm run fetch` produces a valid `ranks.json`. A second fetch needs no browser prompt.
5. A bad gamertag, a null playlist, and a revoked token each degrade gracefully.
6. `git status` after a real run shows no secrets or tokens outside the ignored folders.

## 9. README must cover

Prerequisites (Node 20.6+, an Xbox account that owns Halo Infinite). Azure app registration step by step (personal accounts, Mobile & desktop, redirect `http://localhost`, where to find the client ID). `cp .env.example .env` → `auth` → `discover` → `fetch` → `start`. The DevTools Spartan token shortcut, with warnings (account-bound, short-lived, never share it). The rotation schedule, what `not_in_rotation` means, and the Nov 3, 2026 reset. One example of running it persistently (pm2, Task Scheduler, or a systemd user unit). Troubleshooting for re-auth, 401/403, 429, and a changed playlist ID. Disclaimer: unofficial, undocumented API, personal non-commercial use.

## 10. Before coding, reply with

Any changes to D1–D10, and 3–5 assumptions you still doubt. Then build everything in one pass.
