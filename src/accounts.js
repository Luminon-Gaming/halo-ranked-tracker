import fs from 'node:fs/promises';
import { looksLikeGamertag } from './gamertag.js';

export { looksLikeGamertag };

/** Parses accounts.txt content. Returns { accounts: [{ gamertag }], warnings }. */
export function parseAccounts(text) {
  const seen = new Set();
  const accounts = [];
  const warnings = [];
  text.split(/\r?\n/).forEach((line, i) => {
    const gamertag = line.trim();
    if (!gamertag || gamertag.startsWith('#')) return;
    const key = gamertag.toLowerCase();
    if (seen.has(key)) {
      warnings.push(`Line ${i + 1}: duplicate gamertag "${gamertag}" skipped`);
      return;
    }
    seen.add(key);
    if (!looksLikeGamertag(gamertag)) {
      warnings.push(`Line ${i + 1}: "${gamertag}" doesn't look like a valid gamertag (trying anyway)`);
    }
    accounts.push({ gamertag });
  });
  return { accounts, warnings };
}

export async function loadAccounts(file, log = console) {
  let text;
  try {
    text = await fs.readFile(file, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') {
      log.warn?.(`Accounts file not found: ${file}`);
      return [];
    }
    throw e;
  }
  const { accounts, warnings } = parseAccounts(text);
  for (const w of warnings) log.warn?.(`[accounts] ${w}`);
  return accounts;
}
