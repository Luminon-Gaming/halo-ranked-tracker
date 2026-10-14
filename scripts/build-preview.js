// Builds a static, read-only preview of the dashboard (sample data) for Netlify.
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
data.imageCdn = true;
await fs.mkdir(path.join(out, 'api'), { recursive: true });
await fs.writeFile(path.join(out, 'api', 'ranks.json'), JSON.stringify(data));

// Official tier icons are public; if the download fails the dashboard draws its built-in badges.
await ensureTierIcons({ tiersDir: path.join(out, 'tiers') }).catch((e) => console.warn(`[icons] ${e.message}`));
console.log(`Preview built in ${path.relative(ROOT, out)}/`);
