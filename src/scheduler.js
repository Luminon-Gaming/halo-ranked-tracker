import fs from 'node:fs/promises';
import cron from 'node-cron';
import { executeFetch } from './fetch/runFetch.js';
import { hasCredentials } from './config.js';

async function fileAgeHours(file) {
  try {
    const data = JSON.parse(await fs.readFile(file, 'utf8'));
    const t = Date.parse(data.lastUpdated);
    return Number.isFinite(t) ? (Date.now() - t) / 3_600_000 : Infinity;
  } catch {
    return Infinity;
  }
}

/** Daily fetch inside the `npm start` process, plus a boot fetch when data is missing or stale. */
export async function startScheduler({ config, paths, log = console, run = () => executeFetch({ log }) }) {
  const { cron: expr, timezone, fetchOnBootIfStaleHours } = config.schedule;
  if (!hasCredentials()) {
    log.info?.('[scheduler] No credentials in .env; scheduled fetching is off (serving existing data only)');
    return null;
  }
  if (!cron.validate(expr)) throw new Error(`Config key "schedule.cron" is not a valid cron expression: ${expr}`);
  const task = cron.schedule(expr, () => run(), { timezone, name: 'halo-ranks-fetch', noOverlap: true });
  log.info?.(`[scheduler] Fetching on "${expr}" (${timezone})`);

  const age = await fileAgeHours(paths.dataFile);
  if (age > fetchOnBootIfStaleHours) {
    log.info?.(`[scheduler] Data is ${age === Infinity ? 'missing' : `${age.toFixed(1)}h old`}; fetching now`);
    run();
  }
  return task;
}
