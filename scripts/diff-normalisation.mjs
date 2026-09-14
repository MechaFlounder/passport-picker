/**
 * Compares the status stored in the live data file against what the new
 * pipeline produces for the same record, and prints every difference.
 *
 * This is the safety net for the migration: before any of this ships, the whole
 * list of changes should be readable in one sitting and every line should be an
 * improvement. Run it against the current production file:
 *
 *   node scripts/diff-normalisation.mjs [path/to/visa-data.json]
 */

import fs from 'node:fs';
import path from 'node:path';

import { normaliseCell, resolveAll, indexOverrides, summarise } from '../public/js/visa.js';
import { STATUS_BY_ID } from '../public/js/statuses.js';

const root = path.join(import.meta.dirname, '..');
const DATA_PATH = process.argv[2];
if (!DATA_PATH) {
  console.error('usage: node scripts/diff-normalisation.mjs <path to the old visa-data.json>');
  process.exit(2);
}

const meta = JSON.parse(fs.readFileSync(path.join(root, 'public/data/countries.json'), 'utf8'));
const overridesDoc = JSON.parse(fs.readFileSync(path.join(root, 'data/overrides.json'), 'utf8'));
const overrides = indexOverrides(overridesDoc);
const legacy = JSON.parse(fs.readFileSync(DATA_PATH, 'utf8'));

/** The old vocabulary, so old and new can be compared on equal terms. */
const LEGACY_NAMES = {
  vr: 'visa', ev: 'evisa', esta: 'eta', denied: 'banned', na: 'unknown',
  vf: 'vf', fom: 'fom', voa: 'voa', eta: 'eta', citizen: 'citizen', permit: 'permit',
};

const bar = (n, max, width = 28) => '█'.repeat(Math.max(1, Math.round((n / max) * width)));

// ---------------------------------------------------------------------------
// Cell-level differences
// ---------------------------------------------------------------------------

const changes = new Map();   // "old→new" -> {count, examples[]}
const stayFixes = { zeroToNull: 0, nullToUnlimited: 0 };
let total = 0;
let unchanged = 0;

for (const [passport, row] of Object.entries(legacy)) {
  for (const [destination, raw] of Object.entries(row)) {
    total++;

    const oldStatus = LEGACY_NAMES[raw.status] ?? raw.status ?? 'unknown';
    const fresh = normaliseCell(raw);

    if (raw.status === 'vf' && raw.stay === 0) stayFixes.zeroToNull++;
    if (raw.status === 'citizen' && raw.stay === null) stayFixes.nullToUnlimited++;

    if (fresh.status === oldStatus) { unchanged++; continue; }

    const key = `${oldStatus} → ${fresh.status}`;
    if (!changes.has(key)) changes.set(key, { count: 0, examples: [] });
    const entry = changes.get(key);
    entry.count++;
    if (entry.examples.length < 4) {
      entry.examples.push(`${passport}→${destination} ${JSON.stringify(raw.visa ?? null)}`);
    }
  }
}

const changed = total - unchanged;

console.log('='.repeat(72));
console.log('CELL-LEVEL CHANGES');
console.log('='.repeat(72));
console.log(`records examined   ${total.toLocaleString()}`);
console.log(`unchanged          ${unchanged.toLocaleString()}  (${((unchanged / total) * 100).toFixed(2)}%)`);
console.log(`changed            ${changed.toLocaleString()}  (${((changed / total) * 100).toFixed(2)}%)`);
console.log();

const sorted = [...changes.entries()].sort((a, b) => b[1].count - a[1].count);
const max = sorted[0]?.[1].count ?? 1;

for (const [key, { count, examples }] of sorted) {
  console.log(`${key.padEnd(22)} ${String(count).padStart(5)}  ${bar(count, max)}`);
  for (const ex of examples) console.log(`${' '.repeat(24)}${ex}`);
  console.log();
}

console.log('STAY-DURATION REPAIRS');
console.log(`  visa-free stored as 0 days, now "not stated"   ${stayFixes.zeroToNull}`);
console.log(`  citizen stored as null, now unlimited          ${stayFixes.nullToUnlimited}`);
console.log();

// ---------------------------------------------------------------------------
// Map-level impact
// ---------------------------------------------------------------------------

console.log('='.repeat(72));
console.log('MAP-LEVEL IMPACT');
console.log('='.repeat(72));
console.log('How many countries change colour, for a few representative selections.');
console.log();

/** Reproduce what the old code put on the map, bugs and all. */
function legacyResolution(destination, passports) {
  const priority = { citizen: 0, fom: 1, permit: 2, vf: 3, esta: 4, eta: 4, ev: 4, voa: 5, vr: 6, denied: 7, na: 8 };
  let best = null;
  for (const p of passports) {
    const raw = legacy[p]?.[destination];
    if (!raw) continue;
    const s = raw.status ?? 'na';
    const cand = { status: s, rank: priority[s] ?? 8, stay: raw.stay ?? 0 };
    if (!best || cand.rank < best.rank || (cand.rank === best.rank && cand.stay > best.stay)) best = cand;
  }
  return best ? (LEGACY_NAMES[best.status] ?? best.status) : 'unknown';
}

const SELECTIONS = [
  ['US'],
  ['DE'],
  ['IN'],
  ['US', 'IE'],
  ['GB', 'AU'],
  ['CN', 'HK'],
  ['DE', 'FR', 'IT'],
  ['US', 'GB', 'DE', 'JP', 'AU', 'CA', 'SG', 'BR'],
];

for (const passports of SELECTIONS) {
  const fresh = resolveAll(passports, legacy, meta, overrides);
  let diff = 0;
  let newlyResolved = 0;
  const samples = [];

  for (const [destination, r] of fresh) {
    if (r.noRegime) continue;
    const before = legacyResolution(destination, passports);

    // Destinations the old render loop never visited at all.
    const wasRendered = Object.values(meta.byIso3).includes(destination);
    if (before === 'unknown' && r.status !== 'unknown') newlyResolved++;

    if (before !== r.status) {
      diff++;
      if (samples.length < 3) {
        samples.push(`${destination} ${before}→${r.status}`);
      }
    }
  }

  const s = summarise(fresh);
  const ties = s.ties;
  console.log(
    `${passports.join('+').padEnd(26)} ${String(diff).padStart(3)} countries change` +
    `   ${String(newlyResolved).padStart(3)} newly resolved` +
    `   ${String(ties).padStart(3)} ties` +
    (samples.length ? `   e.g. ${samples.join(', ')}` : ''),
  );
}

// ---------------------------------------------------------------------------
// Tie behaviour — the thing the old map drew with 2ⁿ textures
// ---------------------------------------------------------------------------

console.log();
console.log('='.repeat(72));
console.log('TIE LOAD  (textures the old map allocated vs the new one)');
console.log('='.repeat(72));

for (const n of [2, 3, 4, 5, 6, 7, 8]) {
  const passports = ['US', 'GB', 'DE', 'JP', 'AU', 'CA', 'SG', 'BR'].slice(0, n);
  const fresh = resolveAll(passports, legacy, meta, overrides);

  // The old pregenerateAllPatterns() built one 256x256 RGBA canvas per subset
  // of size >= 2, plus one solid per passport.
  let oldTextures = n; // solids
  for (let size = 2; size <= n; size++) {
    let c = 1;
    for (let i = 0; i < size; i++) c = (c * (n - i)) / (i + 1);
    oldTextures += Math.round(c);
  }
  const oldBytes = oldTextures * 256 * 256 * 4;

  // The new map needs one solid per passport plus a single shared hatch.
  const newTextures = n + 1;
  const newBytes = newTextures * 256 * 256 * 4;

  const ties = summarise(fresh).ties;
  console.log(
    `${n} passports   old ${String(oldTextures).padStart(4)} textures (${(oldBytes / 1048576).toFixed(0).padStart(3)} MB)` +
    `   new ${String(newTextures).padStart(2)} (${(newBytes / 1048576).toFixed(1)} MB)` +
    `   ${String(ties).padStart(3)} tied countries`,
  );
}
