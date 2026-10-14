import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './config.js';
import { startScheduler } from './scheduler.js';

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

async function readJsonSafe(file) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch {
    return null;
  }
}

/** Resolves `rel` inside `dir`, refusing anything that escapes it. */
function safeJoin(dir, rel) {
  const full = path.resolve(dir, `.${path.posix.normalize(`/${rel}`)}`);
  return full.startsWith(path.resolve(dir) + path.sep) ? full : null;
}

export function createServer({ config, paths, log = console }) {
  async function ranksBody() {
    const data = await readJsonSafe(paths.dataFile);
    if (!data) return null;
    // A failed run doesn't rewrite ranks.json, so overlay the newer attempt record for the header badge.
    const attempt = await readJsonSafe(paths.lastAttempt);
    if (attempt?.at && (!data.lastAttempt?.at || Date.parse(attempt.at) > Date.parse(data.lastAttempt.at))) data.lastAttempt = attempt;
    data.ui = { accentColor: config.accentColor };
    return JSON.stringify(data);
  }

  async function serveFile(res, file, cache = 'no-cache') {
    try {
      const body = await fs.readFile(file);
      res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] ?? 'application/octet-stream', 'Cache-Control': cache, 'X-Content-Type-Options': 'nosniff' });
      res.end(body);
    } catch {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not found');
    }
  }

  return http.createServer(async (req, res) => {
    try {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.writeHead(405, { Allow: 'GET, HEAD' });
        return res.end();
      }
      const { pathname } = new URL(req.url, 'http://localhost');

      if (pathname === '/api/ranks') {
        const body = await ranksBody();
        if (!body) {
          res.writeHead(404, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' });
          return res.end(JSON.stringify({ error: 'no_data', hint: 'Run "npm run fetch" to create data/ranks.json' }));
        }
        const etag = `"${crypto.createHash('sha1').update(body).digest('base64url')}"`;
        if (req.headers['if-none-match'] === etag) {
          res.writeHead(304, { ETag: etag, 'Cache-Control': 'no-cache' });
          return res.end();
        }
        res.writeHead(200, { 'Content-Type': TYPES['.json'], 'Cache-Control': 'no-cache', ETag: etag });
        return res.end(req.method === 'HEAD' ? undefined : body);
      }
      if (pathname.startsWith('/assets/')) {
        const file = safeJoin(paths.assetsDir, pathname.slice('/assets/'.length));
        return file ? serveFile(res, file, 'public, max-age=3600') : serveFile(res, '');
      }
      const rel = pathname === '/' ? 'index.html' : pathname.slice(1);
      const file = safeJoin(paths.publicDir, rel);
      return serveFile(res, file ?? '', rel.startsWith('tiers/') ? 'public, max-age=604800' : 'no-cache');
    } catch (e) {
      log.error?.(`[server] ${e.stack || e.message}`);
      res.writeHead(500);
      res.end('Internal error');
    }
  });
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const { config, paths } = loadConfig();
  createServer({ config, paths }).listen(config.port, config.host, () => {
    console.log(`Halo Ranked Tracker → http://${config.host}:${config.port}`);
  });
  startScheduler({ config, paths }).catch((e) => console.error(`[scheduler] ${e.message}`));
}
