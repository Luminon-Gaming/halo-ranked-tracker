import fs from 'node:fs/promises';
import path from 'node:path';

export class LockedError extends Error {
  constructor(pid) {
    super(`Another fetch is already running (pid ${pid})`);
    this.name = 'LockedError';
    this.pid = pid;
  }
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

/**
 * Acquires an exclusive lock file holding this PID. A lock whose PID is gone (or older than maxAgeMs) is stale and replaced.
 * Returns release().
 */
export async function acquireLock(file, { maxAgeMs = 2 * 60 * 60 * 1000 } = {}) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const handle = await fs.open(file, 'wx');
      await handle.writeFile(JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
      await handle.close();
      return async () => {
        await fs.unlink(file).catch(() => {});
      };
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      let info = {};
      try {
        info = JSON.parse(await fs.readFile(file, 'utf8'));
      } catch {
        /* unreadable lock = stale */
      }
      const age = info.at ? Date.now() - Date.parse(info.at) : Infinity;
      if (info.pid && info.pid !== process.pid && isAlive(info.pid) && age < maxAgeMs) throw new LockedError(info.pid);
      await fs.unlink(file).catch(() => {});
    }
  }
  throw new Error(`Could not acquire lock ${file}`);
}
