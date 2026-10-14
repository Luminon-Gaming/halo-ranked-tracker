import fs from 'node:fs/promises';

// Classic gamertags are up to 15 chars (letters, digits, spaces); modern ones may add a #1234 suffix.
const GAMERTAG_RE = /^[A-Za-z0-9][A-Za-z0-9 ]{0,14}(#\d{1,4})?$/;

export function looksLikeGamertag(gt) {
  return GAMERTAG_RE.test(gt);
}

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
