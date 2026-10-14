# Assumptions and decisions

Decisions D1–D10 from the build spec were kept as written. This file lists what was added or changed, and what still needs checking against a live response.

## Changes and additions

- **D11. Netlify preview.** The repo is also a Netlify site. `netlify.toml` builds `.preview/` (dashboard + sample `ranks.json` + sample emblems, with tier icons downloaded at build time) and serves it as a static, read-only preview. Real fetching only ever runs locally on `127.0.0.1`.
- **`.env` loading.** The spec asked for `node --env-file=.env`, but that flag exits with an error when `.env` is missing on Node 20, and the spec also requires `npm start` to work without a `.env`. `src/config.js` loads `.env` itself only when the file exists, with no dependency. Existing environment variables take precedence.
- **The `HALO_SPARTAN_TOKEN` fallback uses a small custom `SpartanTokenProvider`.** The library's `StaticXstsTicketTokenSpartanTokenProvider` takes an *XSTS ticket*, not a Spartan token, so it doesn't fit this case. Verified in the 14.3.2 type definitions.
- **CSR season lookup** uses `getCsrSeasonCalendar()`, which exists in 14.3.2. It falls back to `getSeasonCalendar()`. The season ID is the basename of `CsrSeasonFilePath` (`CsrSeason13-3.json` → `CsrSeason13-3`). If both lookups fail, the request leaves out `season` so the API's current season is used.
- **401 handling** is built into the library: on a 401 it clears the Spartan token and retries once (cockatiel policy, verified in the source). The tracker's own retry layer only handles 429, 5xx and network errors, and is injected as the library's `fetchFn`.
- **Orphaned token-cache rejections are ignored.** When a token fetch fails, the library's `ExpiryTokenCache` rethrows the error to the caller *and* rejects an internal `ResolvablePromise` that nothing awaits. Node treats that as an unhandled rejection and exits, which took down `npm start` whenever a fetch hit an auth or token error. `HaloApiSource.create()` installs one `unhandledRejection` listener that drops only rejections of a `ResolvablePromise` and rethrows everything else. Covered by `test/authCrash.test.js`.
- **Gamertags are URL-encoded before `getUser`.** The library puts the gamertag into `/users/gt(...)` without encoding it, so the `#` in a modern `Name#1234` gamertag would turn the rest into a URL fragment. Encoding it is assumed to be what the profile service expects.
- **`accentColor`** was added to `config.json` because the spec asks for an accent color "from config".
- **Error counting.** In the summary log, `errors` counts *players* with an error. Mode-level counts cover statuses.
- **The sample data uses realistic CSR ranges** (Diamond 1200–1499, Onyx 1500+). The spec's example (`1512` = Diamond 2 starting at 1500) contradicts the verified Platinum 2 = 950 example, so it was not copied.
- **`npm run discover`** writes `null` into `config.json` only for IDs that return 404. Network and auth errors leave config untouched.

## Verified live (Oct 14, 2026)

- **Playlist names come from `NameHint`.** `getAsset(AssetKind.Playlist, id)` returns 404 for all four playlist GUIDs, so `PublicName` is never available. The `NameHint` values are internal: `ga_ranked_crossplay` (Arena), `ga_ranked_doubles`, `ga_rankedSlayer`, `ga_ranked_snipers`. `discover` accepts `crossplay` as an Arena match. All four report `HasCsr: true`; the CSR season was `CsrSeason13-3`.
- **MSAL v7 sign-in works** for an app registered as "Personal Microsoft accounts only": `npm run auth` completed interactively, and `getAccessTokenSilent` then refreshed from `.cache/msal.json` without a browser. Exercised via `discover`, which calls the Halo APIs with the resulting tokens.

## Still unverified (check with a live response)

1. **Unranked sentinel shape.** The fixtures assume `Value: -1, Tier: "", MeasurementMatchesRemaining: 5, InitialMeasurementMatches: 5` for someone who hasn't started placements, plus a `Tier: "Unranked"` variant. `normalize.js` accepts either. *Interpretation:* `MeasurementMatchesRemaining > 0` with **zero** matches played and no CSR is reported as `unranked` (no placements started) rather than `placement`. Once at least one placement match is played, it's `placement`. If you'd rather show "Placement · 5 left" for everyone, remove the `played === 0` guard in `normalizeCsr`. **Action:** save a real response for an unplaced player as `test/fixtures/csr-unranked-live.json` and adjust if needed.
2. **Value during placements.** It's unclear whether the API returns `-1`, `0`, or a provisional CSR during placements. The tracker ignores `Value` whenever matches remain, so all three cases display the same way.
3. **Snipers after Nov 2, 2026.** It's assumed the CSR endpoint still answers for an out-of-rotation playlist with the last values. A 404 or 400 while `rotation.snipers` is `false` is shown as `unavailable`.

## Not built (by design)

- **Scraper:** `ScraperSource` throws `NotImplementedError`. Halo Tracker's ToS restricts automated access, and Waypoint leaderboards only list Onyx players.
- **Spartan emblem compositing** (`emblemSource: "spartan-emblem"`): logs a warning and uses the gamerpic.
