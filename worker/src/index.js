/**
 * Passport Picker data sync.
 *
 * A standalone Worker — not a Pages Function — because only Workers have a real
 * `scheduled()` handler. The previous attempt lived at
 * `functions/update.js` and exported `onScheduled`, which Pages does not
 * support and never called: the data it was meant to refresh sat untouched from
 * July 2025 onward.
 *
 * Each run:
 *   1. pulls the upstream matrix (with fallbacks, because a single raw URL is a
 *      single point of failure),
 *   2. normalises it through the same parser the browser uses,
 *   3. applies public/data/overrides.json,
 *   4. refuses to publish anything that fails the sanity gate,
 *   5. writes per-passport files, a manifest and a dated changelog to R2.
 *
 * Endpoints:
 *   GET  /status          public; what the freshness indicator reads
 *   POST /sync            requires SYNC_SECRET; runs a sync now
 *   POST /sync?dry=1      requires SYNC_SECRET; reports what would change
 *
 * Bindings expected (see wrangler.toml):
 *   VISA_DATA_BUCKET   R2
 *   SYNC_SECRET        secret
 */

import { parseStatus, parseStay, STATUS_IDS } from '../../public/js/statuses.js';
import { indexOverrides } from '../../public/js/visa.js';

import overridesDoc from '../../public/data/overrides.json' with { type: 'json' };
import { syncBoundaries, BOUNDARY_META_KEY } from './boundaries.js';

/**
 * Candidate sources, tried in order.
 *
 * The canonical dataset (ilyankou) was archived in early 2026 and points at a
 * successor; the visualpharm fork tracks official corrections on top. Listing
 * all three means one repository going away does not stop the pipeline — and
 * whichever one answers, the shape is validated before anything is published.
 */
const SOURCES = [
  {
    name: 'imorte/passport-index-data',
    url: 'https://raw.githubusercontent.com/imorte/passport-index-data/main/passport-index.json',
    shape: 'nested',
  },
  {
    name: 'imorte/passport-index-data (master)',
    url: 'https://raw.githubusercontent.com/imorte/passport-index-data/master/passport-index.json',
    shape: 'nested',
  },
  {
    name: 'visualpharm/visa-free-dataset',
    url: 'https://raw.githubusercontent.com/visualpharm/visa-free-dataset/master/passport-index-matrix-iso2.csv',
    shape: 'matrix-csv',
  },
  {
    name: 'ilyankou/passport-index-dataset (archived)',
    url: 'https://raw.githubusercontent.com/ilyankou/passport-index-dataset/master/passport-index-matrix-iso2.csv',
    shape: 'matrix-csv',
  },
];

const KEYS = {
  manifest: 'v2/manifest.json',
  passport: (code) => `v2/passport/${code}.json`,
  changelog: (stamp) => `v2/changes/${stamp}.json`,
  latestChanges: 'v2/changes/latest.json',
};

/** Below this, assume the fetch or the parse went wrong and publish nothing. */
const SANITY = {
  minPassports: 150,
  minDestinations: 150,
  minCells: 25000,
  maxUnknownRatio: 0.05,
  maxChurnRatio: 0.25, // more than a quarter of cells changing is a red flag, not an update
};

// ---------------------------------------------------------------------------
// Parsing upstream shapes
// ---------------------------------------------------------------------------

/** `{ "us": { "gb": { "status": "visa free", "days": 180 } } }` */
export function parseNested(json) {
  const out = {};
  for (const [passport, row] of Object.entries(json)) {
    if (!row || typeof row !== 'object') continue;
    const p = passport.toUpperCase();
    out[p] = {};
    for (const [destination, value] of Object.entries(row)) {
      const d = destination.toUpperCase();
      // Accept {status, days}, a bare string, or a bare number.
      const raw = value && typeof value === 'object'
        ? (value.status ?? value.requirement ?? value.value)
        : value;
      const days = value && typeof value === 'object' ? value.days : undefined;
      out[p][d] = cellFor(raw, days);
    }
  }
  return out;
}

/** A square CSV: first column is the passport, header row is the destinations. */
export function parseMatrixCsv(text) {
  const rows = text.trim().split(/\r?\n/).map(splitCsvLine);
  const header = rows[0].slice(1).map((s) => s.trim().toUpperCase());
  const out = {};

  for (const row of rows.slice(1)) {
    const passport = row[0]?.trim().toUpperCase();
    if (!passport) continue;
    out[passport] = {};
    header.forEach((destination, i) => {
      if (!destination) return;
      out[passport][destination] = cellFor(row[i + 1]?.trim());
    });
  }
  return out;
}

/** Minimal CSV splitter — the upstream files quote any field containing a comma. */
function splitCsvLine(line) {
  const out = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') { field += '"'; i++; }
      else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { out.push(field); field = ''; }
    else field += ch;
  }
  out.push(field);
  return out;
}

/**
 * Build the compact cell we store: `{s: status, d: days, l: label}`.
 * Twenty-odd bytes instead of the nineteen-field API response the old pipeline
 * kept, which is most of why that file reached 24 MB.
 */
export function cellFor(raw, explicitDays) {
  const parsed = parseStatus(raw);
  const days = explicitDays !== undefined ? parseStay(explicitDays) : parseStay(raw);
  const cell = { s: parsed.status };
  if (days !== null && parsed.status !== 'visa' && parsed.status !== 'banned') cell.d = days;
  if (typeof raw === 'string' && raw.trim()) cell.l = raw.trim();
  if (parsed.alternatives.length) cell.a = parsed.alternatives;
  return cell;
}

// ---------------------------------------------------------------------------
// Fetching
// ---------------------------------------------------------------------------

async function fetchUpstream() {
  const attempts = [];

  for (const source of SOURCES) {
    try {
      const res = await fetch(source.url, {
        headers: { 'user-agent': 'passportpicker.com data sync' },
        cf: { cacheTtl: 0 },
      });
      if (!res.ok) {
        attempts.push({ source: source.name, ok: false, detail: `HTTP ${res.status}` });
        continue;
      }

      const body = await res.text();
      const data = source.shape === 'nested'
        ? parseNested(JSON.parse(body))
        : parseMatrixCsv(body);

      const check = sanityCheck(data);
      if (!check.ok) {
        attempts.push({ source: source.name, ok: false, detail: check.reason });
        continue;
      }

      attempts.push({ source: source.name, ok: true, detail: check.summary });
      return { data, source: source.name, attempts };
    } catch (err) {
      attempts.push({ source: source.name, ok: false, detail: String(err?.message ?? err) });
    }
  }

  return { data: null, source: null, attempts };
}

/**
 * Refuse obviously-broken input.
 *
 * A sync that publishes garbage is worse than a sync that does not run, because
 * the freshness indicator would go green while the map went wrong.
 */
export function sanityCheck(data) {
  const passports = Object.keys(data ?? {});
  if (passports.length < SANITY.minPassports) {
    return { ok: false, reason: `only ${passports.length} passports` };
  }

  const destinations = new Set();
  let cells = 0;
  let unknown = 0;

  for (const row of Object.values(data)) {
    for (const [d, cell] of Object.entries(row)) {
      destinations.add(d);
      cells++;
      if (cell.s === 'unknown') unknown++;
      if (!STATUS_IDS.includes(cell.s)) {
        return { ok: false, reason: `unrecognised status "${cell.s}"` };
      }
    }
  }

  if (destinations.size < SANITY.minDestinations) {
    return { ok: false, reason: `only ${destinations.size} destinations` };
  }
  if (cells < SANITY.minCells) {
    return { ok: false, reason: `only ${cells} cells` };
  }
  const ratio = unknown / cells;
  if (ratio > SANITY.maxUnknownRatio) {
    return { ok: false, reason: `${(ratio * 100).toFixed(1)}% of cells parsed as unknown` };
  }

  return {
    ok: true,
    summary: `${passports.length} passports × ${destinations.size} destinations, ${cells} cells, ${(ratio * 100).toFixed(2)}% unknown`,
    passports: passports.length,
    destinations: destinations.size,
    cells,
  };
}

// ---------------------------------------------------------------------------
// Overrides and diffing
// ---------------------------------------------------------------------------

function applyOverrides(data) {
  const index = indexOverrides(overridesDoc);
  let applied = 0;

  for (const rule of overridesDoc.rules ?? []) {
    if (rule.effectiveFrom && rule.effectiveFrom > new Date().toISOString().slice(0, 10)) continue;
    if (rule.passport === '*' || rule.destination === '*') continue; // resolved at read time
    if (!data[rule.passport]) continue;

    data[rule.passport][rule.destination] = {
      s: rule.status,
      ...(rule.stay != null ? { d: parseStay(rule.stay) } : {}),
      ...(rule.label ? { l: rule.label } : {}),
      o: 1, // marks the cell as overridden, for the popup
    };
    applied++;
  }

  return { applied, pending: index.pending };
}

/** What changed since the last published version. */
export function diff(previous, next) {
  const changes = [];
  if (!previous) return { changes, cells: 0, ratio: 0 };

  let cells = 0;
  for (const [passport, row] of Object.entries(next)) {
    for (const [destination, cell] of Object.entries(row)) {
      cells++;
      const was = previous[passport]?.[destination];
      if (!was) { changes.push({ passport, destination, from: null, to: cell.s }); continue; }
      if (was.s !== cell.s || was.d !== cell.d) {
        changes.push({
          passport,
          destination,
          from: was.s,
          to: cell.s,
          ...(was.d !== cell.d ? { days: [was.d ?? null, cell.d ?? null] } : {}),
        });
      }
    }
  }

  return { changes, cells, ratio: cells ? changes.length / cells : 0 };
}

// ---------------------------------------------------------------------------
// Publishing
// ---------------------------------------------------------------------------

async function readPrevious(bucket) {
  const out = {};
  const manifest = await bucket.get(KEYS.manifest);
  if (!manifest) return null;

  const parsed = await manifest.json();
  const codes = parsed.passports ?? [];
  const chunks = await Promise.all(
    codes.map(async (code) => {
      const obj = await bucket.get(KEYS.passport(code));
      return obj ? [code, await obj.json()] : null;
    }),
  );

  for (const entry of chunks) {
    if (entry) out[entry[0]] = entry[1].destinations ?? {};
  }
  return Object.keys(out).length ? out : null;
}

async function publish(bucket, data, meta) {
  const codes = Object.keys(data).sort();
  const stamp = new Date().toISOString();

  // One file per passport. A visitor with three passports downloads three small
  // files that the edge can cache, instead of POSTing for a bespoke slice —
  // a POST is uncacheable by definition, so the old endpoint hit R2 every time.
  await Promise.all(codes.map((code) => bucket.put(
    KEYS.passport(code),
    JSON.stringify({ passport: code, updated: stamp, destinations: data[code] }),
    { httpMetadata: { contentType: 'application/json', cacheControl: 'public, max-age=3600' } },
  )));

  await bucket.put(KEYS.manifest, JSON.stringify({ ...meta, updated: stamp, passports: codes }), {
    httpMetadata: { contentType: 'application/json', cacheControl: 'public, max-age=300' },
  });

  return { stamp, files: codes.length + 1 };
}

// ---------------------------------------------------------------------------
// The sync itself
// ---------------------------------------------------------------------------

async function runSync(env, { dryRun = false, trigger = 'manual' } = {}) {
  const started = Date.now();
  const { data, source, attempts } = await fetchUpstream();

  if (!data) {
    return {
      ok: false,
      error: 'every upstream source failed the fetch or the sanity gate',
      attempts,
    };
  }

  const overrides = applyOverrides(data);
  const previous = await readPrevious(env.VISA_DATA_BUCKET);
  const delta = diff(previous, data);

  // A huge change set means the upstream shape moved under us, not that the
  // world's visa policy changed overnight. Stop and let a human look.
  if (previous && delta.ratio > SANITY.maxChurnRatio) {
    return {
      ok: false,
      error: `refusing to publish: ${(delta.ratio * 100).toFixed(1)}% of cells changed`,
      hint: 'if this is legitimate, raise SANITY.maxChurnRatio or publish once with ?force=1',
      source,
      changes: delta.changes.length,
    };
  }

  if (dryRun) {
    return {
      ok: true,
      dryRun: true,
      source,
      attempts,
      overrides,
      changes: delta.changes.length,
      sample: delta.changes.slice(0, 50),
    };
  }

  const published = await publish(env.VISA_DATA_BUCKET, data, {
    source,
    trigger,
    overridesApplied: overrides.applied,
    overridesPending: overrides.pending,
    changes: delta.changes.length,
  });

  const changelog = {
    generated: published.stamp,
    source,
    trigger,
    total: delta.changes.length,
    changes: delta.changes.slice(0, 5000),
  };
  const body = JSON.stringify(changelog);
  await env.VISA_DATA_BUCKET.put(KEYS.changelog(published.stamp.slice(0, 10)), body, {
    httpMetadata: { contentType: 'application/json' },
  });
  await env.VISA_DATA_BUCKET.put(KEYS.latestChanges, body, {
    httpMetadata: { contentType: 'application/json', cacheControl: 'public, max-age=300' },
  });

  return {
    ok: true,
    source,
    trigger,
    ...published,
    changes: delta.changes.length,
    overrides,
    ms: Date.now() - started,
  };
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

const json = (body, status = 200) => new Response(JSON.stringify(body, null, 2), {
  status,
  headers: { 'content-type': 'application/json; charset=utf-8' },
});

export default {
  /** Cron. Configure the schedule in wrangler.toml, not here. */
  async scheduled(event, env, ctx) {
    ctx.waitUntil(
      runSync(env, { trigger: `cron:${event.cron}` }).then((result) => {
        // Worker logs are the only record a cron run leaves, so make it useful.
        console.log('[sync]', JSON.stringify(result));
      }),
    );
  },

  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/status') {
      const manifest = await env.VISA_DATA_BUCKET.get(KEYS.manifest);
      if (!manifest) return json({ ok: false, error: 'no data published yet' }, 503);

      const parsed = await manifest.json();
      const ageMs = Date.now() - Date.parse(parsed.updated);
      const ageDays = Math.floor(ageMs / 86400000);

      const boundaryMeta = await env.VISA_DATA_BUCKET.get(BOUNDARY_META_KEY);
      const boundaries = boundaryMeta ? await boundaryMeta.json() : null;

      return json({
        ok: true,
        updated: parsed.updated,
        ageDays,
        boundaries: boundaries
          ? { version: boundaries.version, features: boundaries.features, bytes: boundaries.bytes }
          : null,
        // The cron silently stopping is a documented Cloudflare failure mode,
        // so say plainly when the data has gone stale rather than only
        // reporting a timestamp nobody reads.
        stale: ageDays > 14,
        source: parsed.source,
        passports: parsed.passports?.length ?? 0,
        changes: parsed.changes ?? null,
      });
    }

    const authorised = () => {
      const auth = request.headers.get('authorization') ?? '';
      const token = auth.startsWith('Bearer ') ? auth.slice(7) : url.searchParams.get('key');
      return Boolean(env.SYNC_SECRET) && token === env.SYNC_SECRET;
    };

    if (url.pathname === '/sync') {
      if (request.method !== 'POST') return json({ error: 'POST required' }, 405);
      if (!authorised()) return json({ error: 'unauthorised' }, 401);

      const result = await runSync(env, {
        dryRun: url.searchParams.get('dry') === '1',
        trigger: 'manual',
      });
      return json(result, result.ok ? 200 : 500);
    }

    if (url.pathname === '/boundaries') {
      if (request.method !== 'POST') return json({ error: 'POST required' }, 405);
      if (!authorised()) return json({ error: 'unauthorised' }, 401);

      const result = await syncBoundaries(env, {
        force: url.searchParams.get('force') === '1',
        dryRun: url.searchParams.get('dry') === '1',
      });
      return json(result, result.ok ? 200 : 500);
    }

    return json({
      error: 'not found',
      endpoints: ['GET /status', 'POST /sync', 'POST /boundaries'],
    }, 404);
  },
};
