/**
 * Pulls the refresh token for one account out of a serialized MSAL cache. Pure, so it can be tested without a sign-in.
 * Returns null when there is none.
 */
export function extractRefreshToken(serialized, homeAccountId = null) {
  const cache = typeof serialized === 'string' ? JSON.parse(serialized) : serialized;
  const entries = Object.values(cache?.RefreshToken ?? {});
  const hit = entries.find((e) => e?.secret && (!homeAccountId || e.home_account_id === homeAccountId));
  return hit?.secret ?? null;
}
