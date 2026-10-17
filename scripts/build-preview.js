// Builds a static, read-only preview of the dashboard (sample data) for Cloudflare Workers static assets.
// The real tracker runs locally (`npm start`); nothing here talks to Halo services or needs tokens.
import fs from 'node:fs/promises';
import path from 'node:path';
import { loadConfig, ROOT } from '../src/config.js';
import { ensureTierIcons } from '../src/fetch/icons.js';

const out = path.join(ROOT, '.preview');
const { config, paths } = loadConfig();

await fs.rm(out, { recursive: true, force: true });
await fs.cp(paths.publicDir, out, { recursive: true });
await fs.cp(paths.assetsDir, path.join(out, 'assets'), { recursive: true, filter: (src) => !path.basename(src).startsWith('.') });

const data = JSON.parse(await fs.readFile(paths.dataFile, 'utf8'));
data.ui = { accentColor: config.accentColor };
await fs.mkdir(path.join(out, 'api'), { recursive: true });
await fs.writeFile(path.join(out, 'api', 'ranks.json'), JSON.stringify(data));

// Workers static assets read these two files (they are not served). The dashboard fetches /api/ranks.
await fs.writeFile(path.join(out, '_redirects'), '/api/ranks /api/ranks.json 200\n');
// Headers from every matching rule are added together. The CSP allows only this site, Cloudflare's Turnstile widget and
// Microsoft's token endpoint (the page redeems its own sign-in code there).
const CSP = [
  "default-src 'none'",
  "script-src 'self' https://challenges.cloudflare.com",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "connect-src 'self' https://login.microsoftonline.com",
  'frame-src https://challenges.cloudflare.com',
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');
await fs.writeFile(
  path.join(out, '_headers'),
  [
    '/*',
    '  X-Content-Type-Options: nosniff',
    '  X-Frame-Options: DENY',
    '  Referrer-Policy: no-referrer',
    '  Permissions-Policy: camera=(), microphone=(), geolocation=(), payment=()',
    `  Content-Security-Policy: ${CSP}`,
    '',
    '/api/*',
    '  Cache-Control: no-cache',
    '',
    '/tiers/*',
    '  Cache-Control: public, max-age=604800',
    '',
  ].join('\n'),
);

// Official tier icons are public; if the download fails the dashboard draws its built-in badges.
await ensureTierIcons({ tiersDir: path.join(out, 'tiers') }).catch((e) => console.warn(`[icons] ${e.message}`));
console.log(`Preview built in ${path.relative(ROOT, out)}/`);
