/**
 * Canonical visa-status vocabulary for Passport Picker.
 *
 * This module is the single source of truth for what a visa status *is*, how
 * statuses rank against each other, and how free-text from upstream data feeds
 * maps onto them. It is imported unchanged by both the browser app and the
 * sync Worker, which is what stops the two-parsers-that-disagree problem the
 * old code had (`update-data.js:getVisaStatus` vs
 * `index.html:getVisaStatusFromString` classified the same strings differently).
 *
 * No imports, no DOM, no platform APIs — so it runs in a Worker, in a browser,
 * and under `node --test` without modification.
 */

/**
 * @typedef {'citizen'|'fom'|'vf'|'eta'|'voa'|'evisa'|'permit'|'visa'|'banned'|'unknown'} StatusId
 */

/**
 * Statuses in rank order, easiest entry first.
 *
 * `rank` is what the "best passport" comparison sorts on. The ordering encodes
 * friction for the traveller:
 *
 *   citizen  no formality at all
 *   fom      freedom of movement — unlimited stay, no paperwork
 *   vf       visa free — no paperwork, but a capped stay
 *   eta      online authorisation, minutes, small fee, before travel
 *   voa      nothing in advance, but pay and queue at the border, refusable
 *   evisa    online application, days, fee, supporting documents
 *   permit   a special travel document must be obtained
 *   visa     embassy or consulate visa in advance
 *   banned   no admission
 *   unknown  no data
 *
 * Two of these are judgement calls worth revisiting if the ordering ever looks
 * wrong on the map: `eta` before `voa` (a five-minute web form beats a border
 * queue that can refuse you), and `voa` before `evisa` (showing up beats
 * applying in advance). Both are single-line edits here and nowhere else.
 *
 * `color` values are carried over unchanged from the original site so the map
 * keeps its existing palette. Colours encode *category*, not rank.
 */
export const STATUSES = [
  { id: 'citizen', rank: 0, color: '#8E44AD', label: 'Citizen',              short: 'Citizen' },
  { id: 'fom',     rank: 1, color: '#81C784', label: 'Freedom of Movement',  short: 'Free movement' },
  { id: 'vf',      rank: 2, color: '#4CAF50', label: 'Visa Not Required',    short: 'Visa free' },
  { id: 'eta',     rank: 3, color: '#2196F3', label: 'Travel Authorisation', short: 'eTA / ESTA' },
  { id: 'voa',     rank: 4, color: '#FFC107', label: 'Visa on Arrival',      short: 'On arrival' },
  { id: 'evisa',   rank: 5, color: '#3F51B5', label: 'e-Visa / Online Visa', short: 'e-Visa' },
  { id: 'permit',  rank: 6, color: '#3498DB', label: 'Travel Permit Required', short: 'Permit' },
  { id: 'visa',    rank: 7, color: '#F44336', label: 'Visa Required',        short: 'Visa required' },
  { id: 'banned',  rank: 8, color: '#5D4037', label: 'Not Admitted',         short: 'Not admitted' },
  { id: 'unknown', rank: 9, color: '#BDBDBD', label: 'No Data',              short: 'No data' },
];

/** Colour used when no passport is selected at all. */
export const NO_SELECTION_COLOR = '#E0E0E0';

/** @type {Record<StatusId, typeof STATUSES[number]>} */
export const STATUS_BY_ID = Object.fromEntries(STATUSES.map((s) => [s.id, s]));

/** @type {StatusId[]} */
export const STATUS_IDS = STATUSES.map((s) => s.id);

/**
 * Rank of a status. Unrecognised input ranks last rather than throwing, so a
 * new upstream vocabulary can never blank the map.
 * @param {string} id
 * @returns {number}
 */
export function rankOf(id) {
  const s = STATUS_BY_ID[id];
  return s ? s.rank : STATUS_BY_ID.unknown.rank;
}

/**
 * @param {string} id
 * @returns {boolean} whether `id` is a status this module knows about.
 */
export function isStatus(id) {
  return Object.prototype.hasOwnProperty.call(STATUS_BY_ID, id);
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/**
 * Exact-match table for the vocabularies we ingest.
 *
 * Keys are lowercased and whitespace-collapsed (see `canonicalise`), which is
 * deliberate: the legacy feed contains `' Exit-Entry Permit'` with a leading
 * space and `'Visa waiver registration '` with a trailing one, and both landed
 * in the "no data" bucket purely because of that whitespace.
 *
 * Where a value names two routes ("eTA / Visa on arrival"), the entry records
 * both and `parseStatus` reports the easier one as the status with the other
 * kept as an alternative — the traveller is not obliged to take the worse path.
 */
const EXACT = new Map(Object.entries({
  // --- passport-index vocabulary (the feed we sync from) ---
  'visa free': ['vf'],
  'visa on arrival': ['voa'],
  'eta': ['eta'],
  'e-visa': ['evisa'],
  'visa required': ['visa'],
  'no admission': ['banned'],
  'covid ban': ['banned'],
  '-1': ['citizen'],

  // --- legacy travel-buddy vocabulary (kept so we can diff old vs new) ---
  'visa not required': ['vf'],
  'visa not required (entry fee)': ['vf'],
  'visa not required (ease)': ['vf'],
  'freedom of movement': ['fom'],
  'citizen': ['citizen'],
  'free visa on arrival': ['voa'],
  'visa on arrival (ease)': ['voa'],
  'entry permit on arrival': ['voa'],
  'evisa': ['evisa'],
  'online visa required': ['evisa'],
  'pre-enrollment': ['evisa'],
  'visa prior to arrival': ['visa'],
  'not admitted': ['banned'],
  'evisitors': ['eta'],
  'esta': ['eta'],
  'pre-arrival registration': ['eta'],
  'visa waiver registration': ['eta'],
  'mainland travel permit': ['permit'],
  'exit-entry permit': ['permit'],

  // --- two-route values: easier route first ---
  'eta / visa on arrival': ['eta', 'voa'],
  'visa on arrival / evisa': ['voa', 'evisa'],
  'visa on arrival / e-voa': ['voa', 'evisa'],
  'visa on arrival / evisitors': ['eta', 'voa'],
  'visa not required / e-voa': ['vf', 'evisa'],
  'visa not required / evisa': ['vf', 'evisa'],
}));

/**
 * Ordered substring fallbacks, most specific first.
 *
 * Only consulted when `EXACT` misses, so an unfamiliar phrasing degrades to a
 * sensible category instead of "no data". Order matters: 'visa not required'
 * must be tested before 'visa required', and the authorisation schemes before
 * the generic 'visa' catch-alls.
 */
const FUZZY = [
  ['freedom of movement', 'fom'],
  ['not admitted', 'banned'],
  ['no admission', 'banned'],
  ['visa not required', 'vf'],
  ['visa free', 'vf'],
  ['esta', 'eta'],
  ['evisitor', 'eta'],
  ['e-ta', 'eta'],
  ['eta', 'eta'],
  ['electronic travel auth', 'eta'],
  ['travel authoriz', 'eta'],
  ['travel authoris', 'eta'],
  ['etias', 'eta'],
  ['visa waiver', 'eta'],
  ['pre-arrival registration', 'eta'],
  ['visa on arrival', 'voa'],
  ['e-voa', 'voa'],
  ['on arrival', 'voa'],
  ['evisa', 'evisa'],
  ['e-visa', 'evisa'],
  ['online visa', 'evisa'],
  ['pre-enrol', 'evisa'],
  ['permit', 'permit'],
  ['visa required', 'visa'],
  ['visa prior to arrival', 'visa'],
  ['citizen', 'citizen'],
];

/**
 * Lowercase, collapse internal whitespace, trim, and strip a trailing period.
 * @param {string} s
 * @returns {string}
 */
function canonicalise(s) {
  return String(s).toLowerCase().replace(/\s+/g, ' ').replace(/\.$/, '').trim();
}

/**
 * @typedef {object} ParsedStatus
 * @property {StatusId} status      the easiest route available
 * @property {StatusId[]} alternatives  other routes named by the same value
 * @property {boolean} matched      false when nothing matched and we fell back to 'unknown'
 */

/**
 * Classify a free-text visa value from an upstream feed.
 *
 * Numbers (and numeric strings) mean visa-free for that many days, which is how
 * the passport-index feed expresses its most common case; `-1` is the
 * passport's own country.
 *
 * @param {unknown} value
 * @returns {ParsedStatus}
 */
export function parseStatus(value) {
  if (value === null || value === undefined || value === '') {
    return { status: 'unknown', alternatives: [], matched: false };
  }

  if (typeof value === 'number' || /^-?\d+$/.test(String(value).trim())) {
    const n = Number(value);
    if (n === -1) return { status: 'citizen', alternatives: [], matched: true };
    if (n > 0) return { status: 'vf', alternatives: [], matched: true };
    return { status: 'unknown', alternatives: [], matched: false };
  }

  const key = canonicalise(value);

  const exact = EXACT.get(key);
  if (exact) {
    return { status: exact[0], alternatives: exact.slice(1), matched: true };
  }

  for (const [needle, status] of FUZZY) {
    if (key.includes(needle)) {
      return { status, alternatives: [], matched: true };
    }
  }

  return { status: 'unknown', alternatives: [], matched: false };
}

/**
 * Parse a maximum-stay value into whole days.
 *
 * Returns `null` for "permitted, but the duration is not stated", which is a
 * genuinely different thing from zero. The old pipeline collapsed both to `0`
 * across 780 visa-free records, and because the comparison sorted on stay
 * length descending, every one of those records lost its tie-break to any
 * destination that happened to publish a number.
 *
 * `UNLIMITED` covers citizenship and freedom of movement, where any finite
 * number would be wrong. It is a large finite integer rather than `Infinity`
 * because `JSON.stringify(Infinity)` is `null` — the bug that left all 199
 * `citizen` records with a null stay and made the tie-break arithmetic `NaN`.
 *
 * @param {unknown} value
 * @returns {number|null} days, `UNLIMITED`, or null when not stated
 */
export function parseStay(value) {
  if (value === null || value === undefined || value === '') return null;
  if (value === Infinity) return UNLIMITED;

  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return UNLIMITED;
    return value > 0 ? Math.round(value) : null;
  }

  const text = String(value).toLowerCase();
  if (/unlimited|indefinite|permanent/.test(text)) return UNLIMITED;

  const match = text.match(/(\d+)\s*(year|month|week|day)?/);
  if (!match) return null;

  const n = parseInt(match[1], 10);
  if (!Number.isFinite(n) || n <= 0) return null;

  switch (match[2]) {
    case 'year': return n * 365;
    case 'month': return n * 30;
    case 'week': return n * 7;
    default: return n;
  }
}

/** Sentinel for "no meaningful limit". Large, finite, and JSON-safe. */
export const UNLIMITED = 36500; // 100 years

/**
 * Human-readable stay duration.
 * @param {number|null} days
 * @returns {string}
 */
export function formatStay(days) {
  if (days === null || days === undefined) return 'duration not stated';
  if (days >= UNLIMITED) return 'unlimited';
  if (days % 365 === 0 && days >= 365) {
    const y = days / 365;
    return `${y} year${y === 1 ? '' : 's'}`;
  }
  return `${days} day${days === 1 ? '' : 's'}`;
}
