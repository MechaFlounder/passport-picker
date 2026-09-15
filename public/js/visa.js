/**
 * Visa resolution: given a set of passports and a destination, work out the
 * easiest way in and which passport provides it.
 *
 * Pure functions over plain data — no DOM, no fetch, no globals — so the same
 * code runs in the browser, in the sync Worker, and under `node --test`.
 *
 * The two behaviours worth understanding before reading the code:
 *
 * 1. **Ties are a first-class result, not an edge case.** Holding two EU
 *    passports means nearly every destination is a tie, and the old map tried
 *    to draw that with a striped texture generated per subset of passports —
 *    2ⁿ textures for n passports. Here a tie is just a list, and the caller
 *    decides how to draw it. Ties break on the order the user put their
 *    passports in, so there is always exactly one `winner`.
 *
 * 2. **"Not stated" is not zero.** A duration the feed leaves blank is `null`
 *    and stays `null`. The old pipeline coerced it to `0`, which then lost
 *    every comparison in the sort.
 */

import { UNLIMITED, parseStay, parseStatus, rankOf } from './statuses.js';

/**
 * @typedef {object} Cell         one passport's access to one destination
 * @property {string} status
 * @property {number|null} stay   days, UNLIMITED, or null for "not stated"
 * @property {string} [label]     the upstream phrasing, for display
 * @property {string[]} [alternatives]
 * @property {string} [note]
 * @property {string} [source]    'feed' | 'override' | 'inherit' | 'rule' | 'self'
 */

/**
 * @typedef {object} Option       one passport's resolved option for a destination
 * @property {string} passport
 * @property {string} status
 * @property {number|null} stay
 * @property {number} rank
 * @property {number} order       the passport's position in the user's list
 * @property {string} [label]
 * @property {string} [note]
 * @property {string} [source]
 */

/**
 * @typedef {object} Resolution
 * @property {string} destination
 * @property {string} status      the best status any held passport achieves
 * @property {number|null} stay
 * @property {string|null} winner the single passport to show; null if none held
 * @property {string[]} tied      every passport achieving the same best outcome
 * @property {boolean} isTie      tied.length > 1
 * @property {boolean} allTied    every held passport is equivalent here
 * @property {boolean} noRegime   nowhere you can enter (Antarctica, uninhabited)
 * @property {string|null} note
 * @property {Option[]} options   every passport, best first
 */

const NO_REGIME = Object.freeze({
  status: 'unknown',
  stay: null,
  note: 'No civilian entry regime — visa rules do not apply here.',
  source: 'rule',
});

/** How each bloc describes itself in the popup. */
const BLOC_LABELS = {
  eu: 'Freedom of movement (EU/EEA)',
  cta: 'Common Travel Area',
  tasman: 'Trans-Tasman Travel Arrangement',
  gcc: 'GCC freedom of movement',
};

/**
 * The bloc, if any, that gives this passport a right of residence in this
 * destination. Returns the first shared bloc, or null.
 */
function sharedBloc(passport, destination, meta) {
  const a = meta?.countries?.[passport]?.blocs;
  const b = meta?.countries?.[destination]?.blocs;
  if (!a?.length || !b?.length) return null;
  return a.find((name) => b.includes(name)) ?? null;
}

/**
 * A territory outside its parent's free-movement area inherits the parent's
 * entry rules but not its residence rights.
 *
 * Réunion is an EU outermost region, so an EU citizen may live there; New
 * Caledonia is an overseas territory, where the same citizen is an ordinary
 * visitor. Without this, plain inheritance would promote a stay in Nouméa into
 * a right of residence.
 */
function demoteIfOutsideBloc(cell, country) {
  if (country?.freeMovement !== false) return cell;
  if (cell.status !== 'fom') return cell;
  return {
    ...cell,
    status: 'vf',
    stay: null,
    label: 'Visa not required',
  };
}

// ---------------------------------------------------------------------------
// Overrides
// ---------------------------------------------------------------------------

/**
 * Index an overrides document for O(1) lookup.
 *
 * Rules may wildcard either side with `*`. Specificity beats order: an exact
 * passport+destination rule wins over a wildcard, so a broad rule ("nobody may
 * enter X") can be written once and then contradicted for a single passport.
 *
 * A rule carrying `effectiveFrom` is ignored until that date. This is how a
 * known-but-not-yet-in-force change (ETIAS, say) can sit in the data file ready
 * to go, instead of living in someone's calendar.
 *
 * @param {{rules?: object[]}} doc
 * @param {Date|string} [now] the reference date for `effectiveFrom`
 */
export function indexOverrides(doc, now) {
  const exact = new Map();
  const byDestination = new Map();
  const byPassport = new Map();
  const today = (now ? new Date(now) : new Date()).toISOString().slice(0, 10);

  let pending = 0;
  let applied = 0;

  for (const rule of doc?.rules ?? []) {
    if (rule.effectiveFrom && rule.effectiveFrom > today) { pending++; continue; }

    const p = rule.passport ?? '*';
    const d = rule.destination ?? '*';
    if (p === '*' && d === '*') continue; // meaningless; ignore rather than apply globally

    applied++;
    if (p === '*') byDestination.set(d, rule);
    else if (d === '*') byPassport.set(p, rule);
    else exact.set(`${p}>${d}`, rule);
  }

  return { exact, byDestination, byPassport, applied, pending };
}

/** @returns {object|null} the most specific rule for this pair, if any. */
function findOverride(index, passport, destination) {
  if (!index) return null;
  return index.exact.get(`${passport}>${destination}`)
    ?? index.byDestination.get(destination)
    ?? index.byPassport.get(passport)
    ?? null;
}

/** Turn an override rule into a Cell. */
function cellFromOverride(rule) {
  return {
    status: rule.status,
    stay: rule.stay === undefined ? null : parseStay(rule.stay),
    label: rule.label,
    note: rule.note,
    source: 'override',
  };
}

// ---------------------------------------------------------------------------
// Single passport → single destination
// ---------------------------------------------------------------------------

/**
 * Resolve one passport's access to one destination, following territory
 * inheritance and applying overrides.
 *
 * Replaces the `switch (countryCode)` block that used to sit inside
 * `getBestOptions()`, which hard-coded ten territories and had no answer for
 * the rest.
 *
 * @param {string} passport            ISO-2
 * @param {string} destination         ISO-2
 * @param {object} data                { [passport]: { [destination]: Cell } }
 * @param {object} meta                countries.json
 * @param {object} [overrides]         from indexOverrides()
 * @param {Set<string>} [seen]         internal, guards against inheritance cycles
 * @returns {Cell}
 */
export function resolveCell(passport, destination, data, meta, overrides, seen) {
  const country = meta.countries?.[destination];

  // Overrides outrank everything, including citizenship — that is the point of
  // having them, and it is how a territory rule can be corrected without code.
  const override = findOverride(overrides, passport, destination);
  if (override) return cellFromOverride(override);

  if (passport === destination) {
    return { status: 'citizen', stay: UNLIMITED, label: 'Citizen', source: 'self' };
  }

  if (country?.policy === 'none') {
    return { ...NO_REGIME, note: country.note ?? NO_REGIME.note };
  }

  // Special territories whose rule cannot be expressed as plain inheritance.
  if (country?.policy === 'special') {
    return resolveSpecial(passport, destination, country, data, meta, overrides, seen);
  }

  // A shared free-movement bloc is a legal right, so it outranks whatever the
  // feed reports. The upstream dataset describes intra-EU travel as plain
  // "visa free" — true, but it flattens a right of residence into a 90-day
  // tourist allowance, and it would have wiped out the 1,110 freedom-of-movement
  // pairs the old feed did carry.
  const bloc = sharedBloc(passport, destination, meta);
  if (bloc) {
    return {
      status: 'fom',
      stay: UNLIMITED,
      label: BLOC_LABELS[bloc] ?? 'Freedom of movement',
      source: 'bloc',
      bloc,
    };
  }

  const direct = data?.[passport]?.[destination];
  if (direct) return normaliseCell(direct);

  // No direct data. Inherit from the parent if there is one — this is both the
  // declared 'inherit' policy and the fallback for an 'own' territory the feed
  // happens not to cover.
  if (country?.parent) {
    const guard = seen ?? new Set();
    if (guard.has(destination)) {
      return { status: 'unknown', stay: null, source: 'inherit' };
    }
    guard.add(destination);
    const inherited = resolveCell(passport, country.parent, data, meta, overrides, guard);

    // Your country's territories are not your country. Puerto Rico inheriting
    // the United States would otherwise resolve to `citizen`, and an American
    // holding one passport would be told they are a citizen of six places.
    // Free movement is the honest description: domestic travel, no formality,
    // no time limit — and it holds even for territories outside the parent's
    // wider free-movement area, because a French national may settle in Nouméa
    // whatever an EU citizen from elsewhere may do.
    if (inherited.status === 'citizen') {
      return {
        status: 'fom',
        stay: UNLIMITED,
        label: `Free movement (${meta.countries?.[country.parent]?.name ?? country.parent} territory)`,
        note: country.note,
        source: 'inherit',
        inheritedFrom: country.parent,
      };
    }

    return {
      ...demoteIfOutsideBloc(inherited, country),
      note: country.note ?? inherited.note,
      source: 'inherit',
      inheritedFrom: country.parent,
    };
  }

  return { status: 'unknown', stay: null, source: 'feed' };
}

/**
 * Territories that need a rule of their own.
 *
 * Svalbard is visa-free to everyone under the 1920 treaty. Greenland and the
 * Faroes sit outside Schengen: visa-free if Denmark is, and otherwise needing a
 * visa specifically endorsed for them — a Schengen visa alone will not do.
 */
function resolveSpecial(passport, destination, country, data, meta, overrides, seen) {
  if (destination === 'SJ') {
    return {
      status: 'vf',
      stay: UNLIMITED,
      label: 'Visa free (Svalbard Treaty)',
      note: country.note,
      source: 'rule',
    };
  }

  if (destination === 'GL' || destination === 'FO') {
    const guard = seen ?? new Set();
    guard.add(destination);
    const parent = resolveCell(passport, country.parent, data, meta, overrides, guard);
    const easy = parent.status === 'vf' || parent.status === 'fom' || parent.status === 'citizen';
    return easy
      // Greenland and the Faroes are outside the EU, so an EU citizen enters
      // freely but holds no residence right there.
      ? { ...demoteIfOutsideBloc(parent, country), note: country.note, source: 'rule' }
      : { status: 'visa', stay: null, label: 'Visa required', note: country.note, source: 'rule' };
  }

  return { status: 'unknown', stay: null, note: country.note, source: 'rule' };
}

/**
 * Coerce a feed record into a Cell.
 *
 * Accepts both the shape the sync Worker writes (`{s, d}`) and the legacy shape
 * (a full API response with a free-text `visa` field), so the same resolver can
 * run over the old data for the migration diff.
 *
 * @param {object|string|number} raw
 * @returns {Cell}
 */
export function normaliseCell(raw) {
  if (raw === null || raw === undefined) {
    return { status: 'unknown', stay: null, source: 'feed' };
  }

  // Compact shape written by the sync Worker.
  if (typeof raw === 'object' && 's' in raw) {
    return {
      status: raw.s,
      stay: raw.d === undefined ? null : raw.d,
      label: raw.l,
      alternatives: raw.a,
      source: 'feed',
    };
  }

  // A bare value straight from the upstream matrix.
  if (typeof raw !== 'object') {
    const parsed = parseStatus(raw);
    return {
      status: parsed.status,
      stay: parsed.status === 'vf' ? parseStay(raw) : null,
      label: String(raw),
      alternatives: parsed.alternatives,
      source: 'feed',
    };
  }

  // Legacy record. Prefer the free-text `visa` field over the stored `status`,
  // because the stored status is exactly what the old parser got wrong.
  const text = raw.visa ?? raw.label;
  const parsed = parseStatus(text);
  const status = parsed.matched ? parsed.status : (raw.status ? legacyStatus(raw.status) : 'unknown');

  return {
    status,
    stay: parseStay(raw.stay_of ?? raw.stay),
    label: text ?? undefined,
    alternatives: parsed.alternatives,
    source: 'feed',
  };
}

/** Map the old vocabulary onto the current one. */
function legacyStatus(old) {
  switch (old) {
    case 'vr': return 'visa';
    case 'ev': return 'evisa';
    case 'esta': return 'eta';
    case 'denied': return 'banned';
    case 'na': return 'unknown';
    default: return old;
  }
}

// ---------------------------------------------------------------------------
// Many passports → one destination
// ---------------------------------------------------------------------------

/**
 * Compare two options. Lower is better.
 *
 * Status rank first, then stay length, then the user's own ordering. A `null`
 * stay sorts after any stated duration: given two otherwise identical options,
 * the one we can actually describe to the traveller is the more useful answer.
 */
function compareOptions(a, b) {
  if (a.rank !== b.rank) return a.rank - b.rank;
  const as = a.stay;
  const bs = b.stay;
  if (as !== bs) {
    if (as === null) return 1;
    if (bs === null) return -1;
    return bs - as;
  }
  return a.order - b.order;
}

/** Two options are equivalent when neither status nor stay separates them. */
function equivalent(a, b) {
  return a.rank === b.rank && a.stay === b.stay;
}

/**
 * Resolve a destination against every held passport.
 *
 * @param {string} destination      ISO-2
 * @param {string[]} passports      in the user's chosen order — this is what breaks ties
 * @param {object} data
 * @param {object} meta
 * @param {object} [overrides]
 * @returns {Resolution}
 */
export function resolveDestination(destination, passports, data, meta, overrides) {
  const country = meta.countries?.[destination];

  if (country?.policy === 'none') {
    return {
      destination,
      status: 'unknown',
      stay: null,
      winner: null,
      tied: [],
      isTie: false,
      allTied: false,
      noRegime: true,
      note: country.note ?? NO_REGIME.note,
      options: [],
    };
  }

  if (!passports || passports.length === 0) {
    return {
      destination,
      status: 'unknown',
      stay: null,
      winner: null,
      tied: [],
      isTie: false,
      allTied: false,
      noRegime: false,
      note: country?.note ?? null,
      options: [],
    };
  }

  /** @type {Option[]} */
  const options = passports.map((passport, order) => {
    const cell = resolveCell(passport, destination, data, meta, overrides);
    return {
      passport,
      status: cell.status,
      stay: cell.stay ?? null,
      rank: rankOf(cell.status),
      order,
      label: cell.label,
      note: cell.note,
      source: cell.source,
    };
  });

  options.sort(compareOptions);

  const best = options[0];
  const tied = options.filter((o) => equivalent(o, best)).map((o) => o.passport);

  return {
    destination,
    status: best.status,
    stay: best.stay,
    winner: best.passport,
    tied,
    isTie: tied.length > 1,
    allTied: tied.length === passports.length && passports.length > 1,
    noRegime: false,
    note: best.note ?? country?.note ?? null,
    options,
  };
}

/**
 * Resolve every destination at once.
 *
 * This is the single pass the map uses to populate feature state. The old code
 * ran the equivalent of this inside a Mapbox expression rebuild on every
 * `moveend`, so panning the map re-resolved all 200-odd destinations.
 *
 * @returns {Map<string, Resolution>} keyed by destination ISO-2
 */
export function resolveAll(passports, data, meta, overrides) {
  const out = new Map();
  for (const destination of meta.destinations ?? Object.keys(meta.countries ?? {})) {
    out.set(destination, resolveDestination(destination, passports, data, meta, overrides));
  }
  return out;
}

/**
 * Count destinations by status — the numbers behind the legend and the
 * "your passports get you into N countries" headline.
 *
 * @param {Map<string, Resolution>} resolutions
 */
export function summarise(resolutions) {
  const byStatus = {};
  let ties = 0;
  let total = 0;

  for (const r of resolutions.values()) {
    if (r.noRegime) continue;
    total++;
    byStatus[r.status] = (byStatus[r.status] ?? 0) + 1;
    if (r.isTie) ties++;
  }

  const easy = (byStatus.citizen ?? 0) + (byStatus.fom ?? 0) + (byStatus.vf ?? 0);

  return { total, byStatus, ties, visaFreeish: easy };
}

/**
 * Destinations each passport uniquely unlocks — the answer to "what is this
 * second passport actually doing for me?", which the old UI could not express.
 *
 * @param {Map<string, Resolution>} resolutions
 * @param {string[]} passports
 * @returns {Record<string, {sole: string[], best: string[]}>}
 */
export function contributionByPassport(resolutions, passports) {
  const out = Object.fromEntries(passports.map((p) => [p, { sole: [], best: [] }]));

  for (const r of resolutions.values()) {
    if (r.noRegime || !r.winner) continue;
    if (r.tied.length === 1) out[r.winner]?.sole.push(r.destination);
    for (const p of r.tied) out[p]?.best.push(r.destination);
  }

  return out;
}
