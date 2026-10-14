import fs from 'node:fs/promises';
import open from 'open';
import { loadConfig, env } from '../config.js';
import { createMsalApp, loginInteractive } from '../auth/msal.js';
import { clearTokenFile } from '../auth/tokenStore.js';

const { paths } = loadConfig();
const { clientId } = env();

if (!clientId) {
  console.error('HALO_AZURE_CLIENT_ID is not set.\n  1. cp .env.example .env\n  2. Paste your Azure app "Application (client) ID" (see README → Azure app registration).');
  process.exit(1);
}

try {
  await fs.mkdir(paths.cacheDir, { recursive: true, mode: 0o700 });
  // Fresh sign-in: drop derived Xbox/Halo tokens so they're re-minted for this account.
  await clearTokenFile(paths.haloTokens);
  const app = createMsalApp({ clientId, cacheFile: paths.msalCache });
  const result = await loginInteractive(app, (url) => open(url));
  console.log(`Signed in as ${result.account?.username ?? 'your Microsoft account'}.`);
  console.log('Tokens are cached in .cache/ (git-ignored). Next: npm run discover');
  process.exit(0);
} catch (e) {
  console.error(`Sign-in failed: ${e.errorCode ? `${e.errorCode}: ` : ''}${e.message}`);
  console.error('Check the Azure app: "Personal Microsoft accounts only", platform "Mobile and desktop applications", redirect URI http://localhost.');
  process.exit(1);
}
