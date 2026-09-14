/**
 * Checks that the parser recognises every value a data file actually contains.
 *
 * Coverage of real inputs, not of code paths: an unmatched value is a cell that
 * renders as "no data" on the map. When this was first run against the live
 * file it found 50 such cells — the ESTA countries, the two travel-permit
 * values, and two more defeated by nothing but a stray leading or trailing
 * space.
 *
 *   node scripts/coverage-check.mjs [path/to/visa-data.json]
 */

import fs from 'node:fs';
import { parseStatus } from '../public/js/statuses.js';

const path = process.argv[2];
if (!path) {
  console.error('usage: node scripts/coverage-check.mjs <path to a visa data file>');
  process.exit(2);
}

const data = JSON.parse(fs.readFileSync(path, 'utf8'));

const MISSING = '<<no visa field>>';
const seen = new Map();

for (const passport of Object.keys(data)) {
  for (const destination of Object.keys(data[passport])) {
    const record = data[passport][destination];
    const value = record?.visa ?? record?.l;
    const key = value === undefined ? MISSING : JSON.stringify(value);
    seen.set(key, (seen.get(key) ?? 0) + 1);
  }
}

console.log('input'.padEnd(36), 'parsed'.padEnd(9), 'alternatives'.padEnd(13), 'count');
console.log('-'.repeat(72));

let unmatched = 0;

for (const [key, count] of [...seen].sort((a, b) => b[1] - a[1])) {
  const value = key === MISSING ? undefined : JSON.parse(key);
  const parsed = parseStatus(value);
  const real = value !== null && value !== undefined;

  if (!parsed.matched && real) unmatched++;

  console.log(
    key.slice(0, 35).padEnd(36),
    parsed.status.padEnd(9),
    (parsed.alternatives.join(',') || '—').padEnd(13),
    String(count).padStart(6),
    !parsed.matched && real ? '  ← UNMATCHED' : '',
  );
}

console.log('-'.repeat(72));
console.log(`distinct values ${seen.size}   unmatched ${unmatched}`);

// A value the parser does not recognise becomes a grey country, so fail loudly
// rather than printing a report nobody reads to the end of.
process.exit(unmatched > 0 ? 1 : 0);
