import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const IMPORT_RE = /^\s*(?:import|export)\s[^'"]*?from\s+['"]([^'"]+)['"]|^\s*import\s+['"]([^'"]+)['"]/gm;

/** Every file reachable through relative imports, plus every bare/`node:` specifier met on the way. */
function graph(entry) {
  const seen = new Set();
  const external = new Map();
  const walk = (file) => {
    if (seen.has(file)) return;
    seen.add(file);
    const text = fs.readFileSync(file, 'utf8');
    for (const m of text.matchAll(IMPORT_RE)) {
      const spec = m[1] ?? m[2];
      if (spec.startsWith('.')) walk(path.resolve(path.dirname(file), spec));
      else external.set(spec, path.relative(root, file));
    }
  };
  walk(path.resolve(root, entry));
  return { files: [...seen].map((f) => path.relative(root, f)), external };
}

// The Cloudflare Worker bundles these entries, so nothing they reach may need Node's filesystem or MSAL.
const WORKER_REACHABLE = ['src/fetch/pipeline.js', 'src/sources/HaloClientSource.js', 'src/gamertag.js'];
if (fs.existsSync(path.join(root, 'worker/index.js'))) WORKER_REACHABLE.push('worker/index.js');

for (const entry of WORKER_REACHABLE) {
  test(`${entry} only reaches Worker-safe modules`, () => {
    const { files, external } = graph(entry);
    const bad = [...external].filter(([spec]) => spec.startsWith('node:') || spec.startsWith('@azure/') || spec === 'node-cron');
    assert.deepEqual(bad, [], `Node-only imports reachable from ${entry} (via ${files.join(', ')})`);
  });
}
