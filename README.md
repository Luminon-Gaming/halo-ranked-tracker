# Halo Ranked Tracker

Tracks Halo Infinite ranked CSR for a list of gamertags. Once a day it fetches every player's rank in **Ranked Arena, Doubles, Slayer and Snipers**, saves the result to `data/ranks.json`, and serves a dark esports-style dashboard on `http://127.0.0.1:3000`. The roster view only ever reads that file. The search box looks up any gamertag on demand through the local server (`/api/player`), which is the only part of the dashboard that triggers a Halo request, and it opens on **DaLuminar** by default. The browser never sees a token.

- Node.js 20.6+, plain ESM JavaScript, no build step
- [`halo-infinite-api@14.3.2`](https://www.npmjs.com/package/halo-infinite-api) for the Halo/Xbox APIs, `@azure/msal-node` for Microsoft sign-in, `node-cron` for the daily run
- `node:http` server, `node:test` tests, no framework on the page (`public/app.js` is about 15 KB)

> **Unofficial.** This uses undocumented Halo Waypoint APIs that can change without notice. It's for personal, non-commercial use only. It isn't affiliated with Halo Studios, Microsoft or Xbox.

## Quick look (no setup)

```bash
npm install
npm start          # → http://127.0.0.1:3000, serving the committed sample data
```

The sample `data/ranks.json` has 10 fictional players and shows every state: Onyx, ranked tiers, placement, unranked, out of rotation, unavailable, error, a stale player and a long gamertag. In the sample, Snipers is marked out of rotation so you can see how that state looks.

A read-only copy of this preview is also deployed on Cloudflare Workers (see [Deploying the preview](#deploying-the-preview)).

## Looking up a player

Type a gamertag in the search box (`Name` or `Name#1234`) and press Enter. The server runs the normal pipeline for that one player, caches the answer for 5 minutes, and never touches `data/ranks.json`. The last player and the 8 most recent lookups are kept in your browser's `localStorage` (key `lookup-prefs`), and a `?player=Name` link wins over the saved one. The **Roster** button switches to the daily `accounts.txt` list, which is optional now.

Locally, lookups use the sign-in from `npm run auth`. On the hosted site they use a dedicated account's token held by the Worker (see [Hosted lookup](#hosted-lookup-dedicated-account)); when that isn't set up, or a host has no lookup endpoint at all, the search box filters the sample roster and says why.

## Prerequisites

- **Node.js 20.6 or newer**
- **An Xbox / Microsoft account that owns Halo Infinite.** This can be your own account or a dedicated one. Only this account signs in. The players you track don't need to do anything.
- **A free Azure app registration** (below). That's how Microsoft lets a desktop app sign you in. No API key or "official Halo Stats API" is involved. That API doesn't exist.

## Azure app registration (one time, about 5 minutes)

> **You need an Azure directory first.** Microsoft no longer lets a personal Microsoft account create app registrations outside a directory (the portal shows *"The ability to create applications outside of a directory has been deprecated"*). The free fix is to sign up at <https://azure.microsoft.com/free> with the same Microsoft account. It asks for a card and phone number to verify identity, but App registrations are part of the free Entra ID tier and aren't billed. If you already admin a Microsoft 365 / Entra tenant, you can register the app there instead.

1. Go to <https://portal.azure.com> → **Microsoft Entra ID** → **App registrations** → **New registration**. A free personal Azure account is enough.
2. **Name:** anything, e.g. `Halo Ranked Tracker`.
3. **Supported account types:** choose **"Personal Microsoft accounts only"**.
4. **Redirect URI:** platform **"Public client/native (mobile & desktop)"**, value `http://localhost`.
5. Click **Register**.
6. On the app's **Overview** page, copy the **Application (client) ID**. That's `HALO_AZURE_CLIENT_ID`.
7. Optional check: under **Authentication**, confirm `http://localhost` is listed under *Mobile and desktop applications* and that **Allow public client flows** is *Yes*.

No client secret is needed. This is a public client.

## Setup

```bash
cp .env.example .env            # paste HALO_AZURE_CLIENT_ID
# edit accounts.txt              # one gamertag per line (# comments ok, Name#1234 ok)
npm run auth                    # opens a browser once; refresh token is cached in .cache/
npm run discover                # checks the 4 playlist IDs + prints the current CSR season
npm run fetch                   # fetches everyone, writes data/ranks.json
npm start                       # dashboard + daily schedule (06:00 America/New_York)
```

After the first `npm run auth`, every later run refreshes silently with no browser prompt.

Other commands:

| Command | What it does |
|---|---|
| `npm run fetch -- --dry-run` | Runs the whole pipeline against `test/fixtures/` with no network access. Writes `data/ranks.dry-run.json`. |
| `npm run fetch -- --only=GamerTag` | Refreshes one or more players (comma-separated) and keeps the rest. |
| `npm test` | Runs the unit and pipeline tests (`node:test`). |

### Shortcut for testing: paste a Spartan token

If you just want to try a fetch without registering an Azure app:

1. Sign in at <https://www.halowaypoint.com>, open DevTools → **Network**, and click any request to `*.svc.halowaypoint.com`.
2. Copy the value of the `x-343-authorization-spartan` request header into `.env` as `HALO_SPARTAN_TOKEN=…`.

⚠️ **The token is bound to your account and works like a password.** Never share or commit it. It also expires after a few hours, so it isn't suitable for the daily schedule. When it's set, MSAL is skipped. Remove it from `.env` to go back to normal sign-in.

## Playlists and rotation

| Mode | Playlist GUID | Rotation |
|---|---|---|
| Ranked Arena | `edfef3ac-9cbe-4fa2-b949-8f29deafd483` | Permanent |
| Ranked Doubles | `fa5aa2a3-2428-4912-a023-e1eeea7b877c` | Permanent |
| Ranked Slayer | `dcb2e24e-05fb-4390-8076-32a0cdb4326e` | Permanent |
| Ranked Snipers | `6233381c-fc96-40b9-b1ff-f6a4de72dd7a` | **Rotates.** Live Sep 1 to Nov 2, 2026, then back Feb 2 to Mar 1, 2027 |

- **Rotation isn't hardcoded.** When Snipers leaves rotation, set `"rotation": { "snipers": false }` in `config.json`. The tracker still queries the playlist. If data comes back, each player's last Snipers rank is shown dimmed and labelled **Out of rotation** (`not_in_rotation`). Otherwise the cell shows **Unavailable**. The column always stays.
- **Dashboard banner.** The page shows a heads-up banner in the 30 days before Snipers leaves rotation, and a warning if the date has passed but `rotation.snipers` in `config.json` hasn't been updated (and again around the Feb 2 / Mar 1, 2027 rotation). The dates live in `CAL` at the top of the banner section in `public/app.js`. Add `?bannerDate=2026-11-02` to the URL to preview a date. Visitors can dismiss it.
- **Rank reset on Nov 3, 2026.** The CSR season is read from the CSR calendar on every run, so the new season is picked up automatically. Expect lots of **Placement · N left** cells for a few days afterwards.
- A playlist set to `null` shows **Unavailable** for everyone.

## Data contract

`data/ranks.json` (schema version 1): `lastUpdated`, `lastAttempt`, `csrSeasonId`, `modes` (label, playlist ID, `inRotation`), and `players[]` with `gamertag`, `xuid`, `emblemUrl`, `stale`, `error` and a per-mode object:

`status` (`ranked | placement | unranked | not_in_rotation | unavailable | error`), `csr`, `tier`, `subTier` (**1-indexed**: the API's 0-indexed `SubTier` + 1), `tierStartCsr`, `nextTier`, `nextSubTier`, `nextTierCsr` (null for Onyx), `progressPct`, `matchesRemaining`, `peakCsr`/`peakTier`/`peakSubTier` (season high), `allTimePeakCsr`, and `tierIconUrl`.

Tier icons are the official public images (`halowaypoint.com/images/halo-infinite/csr/{tier}_{n}.png`), downloaded once into `public/tiers/`. Gamerpics are downloaded to `data/assets/{xuid}.png`. If an icon is missing, the page draws its own badge.

## Running it persistently

**systemd user unit (Linux):** `~/.config/systemd/user/halo-ranked-tracker.service`

```ini
[Unit]
Description=Halo Ranked Tracker

[Service]
WorkingDirectory=%h/halo-ranked-tracker
ExecStart=/usr/bin/env node src/server.js
Restart=on-failure

[Install]
WantedBy=default.target
```

```bash
systemctl --user daemon-reload
systemctl --user enable --now halo-ranked-tracker
loginctl enable-linger "$USER"   # keep it running while logged out
```

Alternatives: `pm2 start src/server.js --name halo-ranks`, or Windows Task Scheduler running `npm start` at log-on. While `npm start` is running, it fetches on its schedule. It also fetches at boot if `ranks.json` is missing or more than 24 hours old.

## Configuration (`config.json`)

| Key | Default | Notes |
|---|---|---|
| `port`, `host` | `3000`, `127.0.0.1` | Binds to localhost only |
| `schedule` | `0 6 * * *`, `America/New_York`, `fetchOnBootIfStaleHours: 24` | Any IANA timezone |
| `throttle` | concurrency 2, 500 ms between requests, 4 retries, 1 s base backoff, 25 players per CSR call | |
| `playlists` | the four GUIDs above | `null` = mode unavailable |
| `rotation.snipers` | `true` | Set `false` when Snipers leaves rotation |
| `emblemSource` | `gamerpic` | `spartan-emblem` is reserved for later and currently falls back to the gamerpic |
| `accentColor` | `#2ee6a6` | Dashboard accent |
| `accountsFile`, `dataFile` | `accounts.txt`, `data/ranks.json` | |

Unknown keys log a warning. A value of the wrong type stops startup with an error that names the key.

## Troubleshooting

- **`Run "npm run auth"`.** The cached refresh token expired or was revoked (password change, or the app was removed at account.live.com/consent). Run `npm run auth` again. Until you do, the old data stays on screen and the header shows **Last fetch failed**.
- **401 / 403.** With `HALO_SPARTAN_TOKEN`, the token has expired, so paste a fresh one or remove it. With MSAL, an XSTS 401 usually means the account has no Xbox profile or doesn't own Halo Infinite. Sign in once at xbox.com and launch the game, then run `npm run auth`.
- **429 Too Many Requests.** The tracker already backs off and honors `Retry-After`. If it keeps happening, raise `throttle.delayMs` or lower `throttle.concurrency`.
- **A playlist ID changed.** `npm run discover` sets IDs that no longer exist to `null`. Find the new GUID in the URL of that mode's leaderboard on <https://www.halowaypoint.com/halo-infinite/leaderboards> and put it back in `config.json`.
- **Gamertag not found.** Check the spelling in `accounts.txt`. Modern gamertags need their `#1234` suffix. Delete `data/xuid-cache.json` to force a fresh lookup.
- **"Another fetch is already running".** Another fetch is holding `.cache/fetch.lock`. If that process died, the lock is detected as stale on the next run.

## Deploying the preview

The hosted copy is the dashboard built from the committed **sample** roster, served by Cloudflare Workers static assets (`wrangler.jsonc`), plus the live player lookup described below. The daily roster fetch and your own sign-in stay on your machine.

```bash
npx wrangler login      # once
npm run deploy          # rebuilds .preview/ (scripts/build-preview.js), then wrangler deploy
npm run deploy:staging  # same, to a separate Worker named halo-ranked-tracker-staging
```

`scripts/build-preview.js` also writes `.preview/_redirects` (`/api/ranks` → `/api/ranks.json`) and `.preview/_headers` (security headers and a CSP on everything, no-cache for `/api/*`, one week for `/tiers/*`). To try it locally first: `node scripts/build-preview.js && npx wrangler dev`.

## Hosted lookup (sign in with your own account)

On the hosted site a visitor can sign in with their own Microsoft account, and lookups are then made as that visitor. The Worker keeps nothing of theirs: the page signs in with the authorization-code flow with PKCE (`public/auth.js`, no library), keeps the tokens in `sessionStorage` only, and sends the short-lived access token to `/api/player` as `Authorization: Bearer`. For that one request the Worker builds a fresh token chain in memory (Xbox user token → XSTS → Halo Spartan token), looks the player up and forgets everything. Tokens are only ever sent to Xbox and Halo hosts. Players that someone has already looked up (cached 30 minutes, 1 hour for "no such gamertag") are also shown to signed-out visitors, since that data is public. A token that Xbox rejects gives a 401 for that visitor alone; it never pauses lookups for anyone else.

**One-time setup (yours; it changes your Azure app):**

1. In the Azure portal open the app → **Authentication** → **Add a platform** → **Single-page application**, and add these redirect URIs (they must match exactly, trailing slash included): `http://localhost:8787/`, your staging URL and your real URL, e.g. `https://halo-ranked-tracker.<account>.workers.dev/`. Microsoft only allows the browser to redeem the code cross-origin for redirect URIs of this platform type. The existing *Mobile and desktop* `http://localhost` entry stays for `npm run auth`.
2. Tell the Worker the client ID (it is public by design; it appears in every sign-in URL): `npx wrangler secret put HALO_AZURE_CLIENT_ID` (add `--name halo-ranked-tracker-staging` for staging). For a local run put `HALO_AZURE_CLIENT_ID=<id>` in `.dev.vars` (git-ignored).
3. Try it locally first: `node scripts/build-preview.js && npx wrangler@4.151.0 dev --port 8787`, open <http://localhost:8787>, click **Sign in with Microsoft** with the account you play Halo on, and look up DaLuminar. Compare the result with `npm start`.

The account must have an Xbox profile. With none, Xbox rejects the token and the page asks for a sign-in again.

**What visitors consent to.** Microsoft's screen says the app can sign in to Xbox as them (`XboxLive.signin`). This app only uses it to read Halo CSR, but the permission is that broad. Halo's terms for automated access are unclear, so a visitor's own account carries that risk.

## Hosted lookup (dedicated account)

Visitors of the hosted site can look up any gamertag. Halo has no public API, so every lookup is made by **one Xbox account that you provide** and that the Worker signs in as. Use a **dedicated account** that you can afford to lose: Microsoft or Halo may rate-limit or ban an account that serves public traffic, and the terms for automated access are not clear.

How it fits together: the Azure app from [Azure app registration](#azure-app-registration-one-time-about-5-minutes) is the OAuth client every sign-in goes through, so the Worker reuses the same client ID and no second app is needed. Its refresh grant needs no client secret because the app is a public client. The refresh token of the dedicated account is stored as a Worker secret. A Durable Object (`HaloVault`) is the only code that uses it: it refreshes and rotates the token, runs the Halo calls, and enforces the limits below.

**One-time setup (you do these; the steps involve your accounts and secrets):**

1. Create a new Microsoft account for this, then create its Xbox profile at <https://www.xbox.com> and open Halo Infinite once (or sign in to Halo Waypoint). Without an Xbox profile the Xbox sign-in step fails with a 401.
2. Deploy a test Worker first: `npm run deploy:staging`.
3. Upload the account's token (a private browser window helps if you are signed in to another Microsoft account):
   ```bash
   npm run seed:worker -- --name halo-ranked-tracker-staging --expect dedicated@outlook.com
   openssl rand -hex 32 | npx wrangler secret put IP_SALT --name halo-ranked-tracker-staging
   ```
   `seed:worker` signs in with a cache of its own (your normal `.cache/` sign-in is not touched), refuses to upload unless the signed-in address equals `--expect`, passes the token to `wrangler secret put` on stdin, and deletes its local copy straight away. Never reuse that token elsewhere: it rotates, so a second copy would be invalidated. To re-seed, run the command again.
4. Open the staging URL and look up a gamertag. When it works, repeat steps 3 and 2 for the real Worker (`--name halo-ranked-tracker`, then `npm run deploy`).
5. Recommended: create a Turnstile widget in the Cloudflare dashboard, add **both** `*.workers.dev` hostnames (staging and real) to it, and set `TURNSTILE_SITE_KEY` and `TURNSTILE_SECRET` with `wrangler secret put`. With both set, every lookup needs a passed challenge.

The staging and real Workers share the two rate-limit counters (`namespace_id` 4101 and 4102 in `wrangler.jsonc`), so heavy testing on staging can use up the same per-visitor allowance. WAF rate-limiting rules are configured per domain on Cloudflare, so they only help once the Worker is on a domain of your own; on `workers.dev` the built-in limits below are what protect it.

**Protections**

| Layer | What it does |
|---|---|
| Input | Only `GET /api/player?gamertag=` with a valid gamertag (400 otherwise). Input is never echoed back. Cross-site requests and foreign `Origin`s are refused, and no CORS headers are sent. |
| Per visitor | Workers rate limits (6 per 10 s and 20 per minute, per Cloudflare location, keyed on the connecting IP), plus 10 fresh lookups per hour per hashed IP in the Durable Object. |
| Global budget | At most 6 fresh lookups a minute, 60 an hour and 300 a day, and 60 upstream requests a minute across all visitors. Answers come from a cache first (30 minutes for a player, 1 hour for "no such gamertag"), so repeats cost nothing. The page opens on DaLuminar for every visitor, which alone is at most 48 fresh lookups a day. Edit the `LIMIT_*` vars in `wrangler.jsonc` to change them. |
| Circuit breaker | A rejected sign-in stops all Halo calls for 30 minutes, a Halo 429 for 5, and a lookup where every playlist failed with a Halo 5xx for 1. A new `seed:worker` clears an open breaker at once. One player's own 401/403 never trips it. |
| Egress | Tokens can only be sent to Microsoft, Xbox and Halo hosts. Avatars are proxied only from URLs that Halo returned, on the Xbox image host. |
| Secrets | Only error codes are kept from Microsoft's replies. Nothing from an upstream error body, no token and no IP address reaches a response or a log. |
| Kill switch | Set `LOOKUP_ENABLED` to `"false"` in `wrangler.jsonc` and redeploy. The page then falls back to the sample roster. |

If lookups stop working with "unavailable", the dedicated account's sign-in was rejected: run `seed:worker` again.

## Security

Secrets live only in `.env` and `.cache/` (MSAL cache, Xbox/Halo tokens, saved with mode 600). Both are git-ignored, as are downloaded gamerpics and the XUID cache. After a real run, `git status` should show only `data/ranks.json` changed.

## Project layout

```
src/            config, accounts, scheduler, server
  auth/         msal.js (file-backed MSAL cache), tokenStore.js (TokenPersister)
  sources/      StatsSource interface, HaloApiSource, ScraperSource (deliberate stub)
  fetch/        runFetch pipeline, normalize (pure), throttle/retry, atomic writes, icons, lock, fixtures
  cli/          auth, discover, fetch
public/         dashboard (index.html, styles.css, app.js, tiers/)
data/           ranks.json (sample committed), xuid-cache.json, assets/
test/           node:test suites + fixtures
scripts/        build-preview.js (static preview for Cloudflare Workers)
worker/         Cloudflare Worker: index.js (routes), guard.js (request checks), vaultCore.js (tokens, budgets, cache)
wrangler.jsonc  Workers config: static assets, the HaloVault Durable Object, rate limits, LIMIT_* vars
```

See `ASSUMPTIONS.md` for the decisions that still need checking against a live response.
