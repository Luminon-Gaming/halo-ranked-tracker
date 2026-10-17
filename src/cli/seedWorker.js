// One-time (and re-seeding) setup for the hosted lookup: signs the DEDICATED Xbox account in and uploads its refresh
// token to the Worker as a secret. The token never touches the terminal output, argv or a file that outlives this run.
//   npm run seed:worker -- --name halo-ranked-tracker-staging --expect dedicated@outlook.com
import fs from 'node:fs/promises';
import { spawn } from 'node:child_process';
import open from 'open';
import { loadConfig, env } from '../config.js';
import { createMsalApp, SCOPES } from '../auth/msal.js';
import { extractRefreshToken } from '../auth/refreshToken.js';

const WRANGLER = 'wrangler@4.151.0';
const arg = (name) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : null;
};
const die = (msg) => {
  console.error(msg);
  process.exit(1);
};

const worker = arg('name');
const expect = arg('expect')?.toLowerCase();
if (!worker || !expect) die('Usage: npm run seed:worker -- --name <worker-name> --expect <dedicated-account-email>\n  --expect is the account you intend to upload; the run aborts if you sign in as anyone else.');

const { paths } = loadConfig();
const { clientId } = env();
if (!clientId) die('HALO_AZURE_CLIENT_ID is not set in .env (see README → Azure app registration).');

/** Sends `value` to `wrangler secret put NAME` on stdin: never in argv, never echoed. */
function putSecret(name, value) {
  return new Promise((resolve, reject) => {
    const child = spawn('npx', ['--yes', WRANGLER, 'secret', 'put', name, '--name', worker], { stdio: ['pipe', 'inherit', 'inherit'] });
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`wrangler secret put ${name} exited ${code}`))));
    child.stdin.end(`${value}\n`);
  });
}

// A cache file of its own: the personal sign-in in .cache/msal.json is never touched, and the file is deleted below
// because two holders of one rotating refresh token would invalidate each other.
const cacheFile = `${paths.cacheDir}/worker-msal.json`;
try {
  await fs.mkdir(paths.cacheDir, { recursive: true, mode: 0o700 });
  await fs.rm(cacheFile, { force: true });
  const app = createMsalApp({ clientId, cacheFile });
  console.log(`Sign in with the DEDICATED account (${expect}). Use a private window if your browser is signed in to another Microsoft account.`);
  const result = await app.acquireTokenInteractive({
    scopes: SCOPES,
    prompt: 'select_account',
    openBrowser: async (url) => {
      console.log(`\nOpening your browser. If it doesn't open, visit:\n${url}\n`);
      await open(url).catch(() => {});
    },
    successTemplate: '<!doctype html><meta charset="utf-8"><title>Signed in</title><h1>Signed in. You can close this tab.</h1>',
    errorTemplate: '<h1>Sign-in failed</h1><p>{{error}}</p>',
  });
  const who = result.account?.username?.toLowerCase();
  // Throw, never process.exit, inside this try: the finally below must always delete the cached token.
  if (who !== expect) throw new Error(`Signed in as ${who ?? 'an unknown account'}, not ${expect}. Nothing was uploaded.`);

  const token = extractRefreshToken(await fs.readFile(cacheFile, 'utf8'), result.account.homeAccountId);
  if (!token) throw new Error('Signed in, but no refresh token was cached. Nothing was uploaded.');

  await putSecret('HALO_AZURE_CLIENT_ID', clientId);
  await putSecret('HALO_REFRESH_TOKEN_SEED', token);
  console.log(`\nUploaded HALO_AZURE_CLIENT_ID and HALO_REFRESH_TOKEN_SEED to "${worker}" for ${who}.`);
  console.log('Next: set IP_SALT once (openssl rand -hex 32 | npx wrangler secret put IP_SALT --name ' + worker + '), then test a lookup.');
} catch (e) {
  console.error(`Seeding failed: ${e.errorCode ? `${e.errorCode}: ` : ''}${e.message}`);
  process.exitCode = 1;
} finally {
  await fs.rm(cacheFile, { force: true });
}
process.exit(process.exitCode ?? 0);
