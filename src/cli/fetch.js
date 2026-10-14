import { executeFetch } from '../fetch/runFetch.js';

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const only = args
  .filter((a) => a.startsWith('--only='))
  .flatMap((a) => a.slice('--only='.length).split(','))
  .map((s) => s.trim())
  .filter(Boolean);

const result = await executeFetch({ dryRun, only: only.length ? only : null });
process.exit(result.ok ? 0 : 1);
