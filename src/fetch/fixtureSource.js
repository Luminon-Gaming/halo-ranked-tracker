import fs from 'node:fs/promises';
import path from 'node:path';
import { HaloInfiniteClient } from 'halo-infinite-api';
import { ROOT } from '../config.js';
import { HaloApiSource, StaticSpartanTokenProvider } from '../sources/HaloApiSource.js';
import { createThrottledFetch } from './throttle.js';
import { unwrapXuid } from './normalize.js';

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/**
 * Fake Halo services backed by test/fixtures/world.json + csr-*.json, served through the real
 * halo-infinite-api client so --dry-run and tests exercise the same request/response code paths.
 */
export async function createFixtureFetch(fixturesDir = path.join(ROOT, 'test', 'fixtures')) {
  const world = JSON.parse(await fs.readFile(path.join(fixturesDir, 'world.json'), 'utf8'));
  const csr = {};
  for (const f of await fs.readdir(fixturesDir)) {
    const m = /^csr-(.+)\.json$/.exec(f);
    if (m) csr[m[1]] = JSON.parse(await fs.readFile(path.join(fixturesDir, f), 'utf8'));
  }
  const requests = [];
  const findUser = (pred) => world.users.find(pred);

  const fetchFn = async (input) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    requests.push(url.toString());
    const host = url.hostname.split('.')[0];
    const p = decodeURIComponent(url.pathname);

    if (host === 'profile') {
      const gt = /^\/users\/gt\((.+)\)$/.exec(p);
      if (gt) {
        const u = findUser((x) => x.gamertag.toLowerCase() === gt[1].toLowerCase());
        return u ? json(u) : json({}, 404);
      }
      if (p === '/users') {
        const ids = (url.searchParams.get('xuids') ?? '').split(',').filter(Boolean);
        return json(ids.map((id) => findUser((x) => x.xuid === id)).filter(Boolean));
      }
    }
    if (host === 'skill') {
      const m = /^\/hi\/playlist\/([^/]+)\/csrs$/.exec(p);
      const table = m && world.csr[m[1]];
      if (!table) return json({}, 404);
      const ids = (url.searchParams.get('players') ?? '').split(',').filter(Boolean);
      return json({
        Value: ids.map((id) => {
          const name = table[unwrapXuid(id)];
          return name && csr[name] ? { Id: id, ResultCode: 0, Result: csr[name] } : { Id: id, ResultCode: 1, Result: null };
        }),
      });
    }
    if (host.startsWith('gamecms') && /csrseasoncalendar\.json$/i.test(p)) return json(world.csrCalendar);
    return json({}, 404);
  };
  return { fetchFn, world, csr, requests };
}

export async function createFixtureSource({ log = console, fixturesDir } = {}) {
  const fx = await createFixtureFetch(fixturesDir);
  const fetchFn = createThrottledFetch(fx.fetchFn, { concurrency: 4, delayMs: 0, maxRetries: 0, log });
  const client = new HaloInfiniteClient(new StaticSpartanTokenProvider('dry-run'), fetchFn);
  return {
    source: new HaloApiSource({ client, assetFetch: null, log }),
    accounts: fx.world.accounts.map((gamertag) => ({ gamertag })),
    requests: fx.requests,
  };
}
