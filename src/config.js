import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

import { MODES, MODE_KEYS } from './modes.js';

export { MODES, MODE_KEYS };

/** Shape used for validation: every leaf is a type spec. */
const SCHEMA = {
  port: 'integer',
  host: 'string',
  schedule: { cron: 'string', timezone: 'string', fetchOnBootIfStaleHours: 'number' },
  throttle: { concurrency: 'integer', delayMs: 'number', maxRetries: 'integer', baseBackoffMs: 'number', csrBatchSize: 'integer' },
  playlists: { arena: 'string|null', doubles: 'string|null', slayer: 'string|null', snipers: 'string|null' },
  rotation: { snipers: 'boolean' },
  emblemSource: ['gamerpic', 'spartan-emblem'],
  accentColor: 'string',
  accountsFile: 'string',
  dataFile: 'string',
};

export const DEFAULTS = {
  port: 3000,
  host: '127.0.0.1',
  schedule: { cron: '0 6 * * *', timezone: 'America/New_York', fetchOnBootIfStaleHours: 24 },
  throttle: { concurrency: 2, delayMs: 500, maxRetries: 4, baseBackoffMs: 1000, csrBatchSize: 25 },
  playlists: { arena: null, doubles: null, slayer: null, snipers: null },
  rotation: { snipers: true },
  emblemSource: 'gamerpic',
  accentColor: '#2ee6a6',
  accountsFile: 'accounts.txt',
  dataFile: 'data/ranks.json',
};

function typeOk(spec, value) {
  if (Array.isArray(spec)) return spec.includes(value);
  return spec.split('|').some((t) => {
    if (t === 'null') return value === null;
    if (t === 'integer') return Number.isInteger(value);
    if (t === 'number') return typeof value === 'number' && Number.isFinite(value);
    return typeof value === t;
  });
}

/** Validates a parsed config object. Returns { config, warnings, errors }; never throws. */
export function validateConfig(raw, schema = SCHEMA, defaults = DEFAULTS, prefix = '') {
  const warnings = [];
  const errors = [];
  const config = {};
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    errors.push(`${prefix || 'config'} must be an object`);
    return { config: structuredClone(defaults), warnings, errors };
  }
  for (const key of Object.keys(raw)) {
    if (!(key in schema)) warnings.push(`Unknown config key "${prefix}${key}" (ignored)`);
  }
  for (const [key, spec] of Object.entries(schema)) {
    const name = `${prefix}${key}`;
    const value = raw[key];
    if (value === undefined) {
      config[key] = structuredClone(defaults[key]);
      continue;
    }
    if (spec && typeof spec === 'object' && !Array.isArray(spec)) {
      const nested = validateConfig(value, spec, defaults[key], `${name}.`);
      warnings.push(...nested.warnings);
      errors.push(...nested.errors);
      config[key] = nested.config;
    } else if (!typeOk(spec, value)) {
      const expected = Array.isArray(spec) ? `one of ${spec.map((s) => JSON.stringify(s)).join(', ')}` : spec;
      errors.push(`Config key "${name}" must be ${expected}, got ${JSON.stringify(value)}`);
      config[key] = structuredClone(defaults[key]);
    } else {
      config[key] = value;
    }
  }
  return { config, warnings, errors };
}

/**
 * Loads .env without requiring the file to exist (`node --env-file` fails on a missing file in Node 20).
 * Values already present in process.env win.
 */
export function loadEnvFile(file = path.join(ROOT, '.env')) {
  if (!fs.existsSync(file)) return false;
  const text = fs.readFileSync(file, 'utf8');
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
    if (!m) continue;
    let value = m[2];
    if (/^(['"]).*\1$/.test(value)) value = value.slice(1, -1);
    else value = value.replace(/\s+#.*$/, '');
    if (process.env[m[1]] === undefined) process.env[m[1]] = value;
  }
  return true;
}

export function resolvePaths(config) {
  const dataFile = path.resolve(ROOT, config.dataFile);
  const cacheDir = path.join(ROOT, '.cache');
  return {
    root: ROOT,
    dataFile,
    dataDir: path.dirname(dataFile),
    accountsFile: path.resolve(ROOT, config.accountsFile),
    xuidCache: path.join(path.dirname(dataFile), 'xuid-cache.json'),
    assetsDir: path.join(path.dirname(dataFile), 'assets'),
    publicDir: path.join(ROOT, 'public'),
    tiersDir: path.join(ROOT, 'public', 'tiers'),
    cacheDir,
    msalCache: path.join(cacheDir, 'msal.json'),
    haloTokens: path.join(cacheDir, 'halo-tokens.json'),
    lockFile: path.join(cacheDir, 'fetch.lock'),
    lastAttempt: path.join(cacheDir, 'last-attempt.json'),
  };
}

/** Loads + validates config.json and .env. Throws with every error listed if the config is invalid. */
export function loadConfig({ file = path.join(ROOT, 'config.json'), log = console } = {}) {
  loadEnvFile();
  let raw = {};
  if (fs.existsSync(file)) {
    try {
      raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (e) {
      throw new Error(`config.json is not valid JSON: ${e.message}`);
    }
  } else {
    log.warn?.('config.json not found; using defaults');
  }
  const { config, warnings, errors } = validateConfig(raw);
  for (const w of warnings) log.warn?.(`[config] ${w}`);
  if (errors.length) throw new Error(`Invalid config.json:\n  - ${errors.join('\n  - ')}`);
  return { config, paths: resolvePaths(config) };
}

export function env() {
  return {
    clientId: process.env.HALO_AZURE_CLIENT_ID?.trim() || null,
    spartanToken: process.env.HALO_SPARTAN_TOKEN?.trim() || null,
  };
}

export function hasCredentials() {
  const e = env();
  return Boolean(e.clientId || e.spartanToken);
}
