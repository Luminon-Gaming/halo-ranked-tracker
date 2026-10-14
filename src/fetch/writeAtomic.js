import fsp from 'node:fs/promises';
import path from 'node:path';

const defaultOps = {
  open: (...a) => fsp.open(...a),
  rename: (...a) => fsp.rename(...a),
  unlink: (...a) => fsp.unlink(...a),
  mkdir: (...a) => fsp.mkdir(...a),
};

/**
 * Writes a file atomically: temp file in the same directory, fsync, rename.
 * If anything fails the original file is left untouched and the temp file is removed.
 * `ops` is injectable for tests.
 */
export async function writeFileAtomic(file, contents, { mode = 0o644, ops = defaultOps } = {}) {
  const dir = path.dirname(file);
  await ops.mkdir(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.${Date.now()}.tmp`);
  let handle;
  try {
    handle = await ops.open(tmp, 'w', mode);
    await handle.writeFile(contents);
    await handle.sync();
    await handle.close();
    handle = null;
    await ops.rename(tmp, file);
  } catch (err) {
    if (handle) await handle.close().catch(() => {});
    await ops.unlink(tmp).catch(() => {});
    throw err;
  }
}

export function writeJsonAtomic(file, data, opts) {
  return writeFileAtomic(file, `${JSON.stringify(data, null, 2)}\n`, opts);
}

export async function readJson(file, fallback = null) {
  try {
    return JSON.parse(await fsp.readFile(file, 'utf8'));
  } catch (e) {
    if (e.code === 'ENOENT') return fallback;
    throw new Error(`Could not read ${file}: ${e.message}`);
  }
}
