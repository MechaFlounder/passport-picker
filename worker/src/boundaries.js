/**
 * Country boundary geometry for the map.
 *
 * This lives in the Worker for one reason: the Worker has unrestricted network
 * access and the build sandbox does not. It fetches Natural Earth's admin-0
 * countries, resolves each feature to an ISO-2 code, strips it down to what the
 * map actually needs, and writes the result to R2 once. The frontend then loads
 * it from an edge-cached route — no Mapbox tileset, no access token, and no
 * per-map-load billing.
 *
 * Owning the geometry is also what fixes the twelve territories that had visa
 * data but never appeared: Mapbox's tileset was never the problem, the
 * hard-coded ISO lookup in the old page was, and now the mapping is derived
 * from the same countries.json the rest of the app uses.
 */

import countries from '../../public/data/countries.json' with { type: 'json' };

export const BOUNDARY_KEY = 'v2/boundaries.geojson';
export const BOUNDARY_META_KEY = 'v2/boundaries.meta.json';

/**
 * Natural Earth at 1:50m: detailed enough that small island states survive,
 * coarse enough to ship. The 110m set drops too many countries to be usable
 * here, and 10m is roughly 25 MB.
 */
const SOURCES = [
  'https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_50m_admin_0_countries.geojson',
  'https://raw.githubusercontent.com/nvkelso/natural-earth-vector/main/geojson/ne_50m_admin_0_countries.geojson',
  'https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_110m_admin_0_countries.geojson',
];

/**
 * Coordinate precision, in decimal places.
 *
 * Three places is about 110 m at the equator — far finer than a single screen
 * pixel at the zoom levels a world map is viewed at, and it roughly halves the
 * file. Rounding also makes neighbouring points collapse, which removes
 * redundant vertices for free.
 */
const PRECISION = 3;

const SANITY = {
  minFeatures: 180,
  minResolved: 150,
  maxBytes: 8 * 1024 * 1024,
};

// ---------------------------------------------------------------------------
// ISO resolution
// ---------------------------------------------------------------------------

/** Lowercased name -> ISO-2, for features whose codes are unusable. */
const byName = new Map();
for (const c of Object.values(countries.countries)) {
  byName.set(c.name.toLowerCase(), c.iso2);
  byName.set(c.official.toLowerCase(), c.iso2);
}

/** Natural Earth names that do not match ours. */
const NAME_FIXES = {
  'united states of america': 'US',
  'republic of the congo': 'CG',
  'democratic republic of the congo': 'CD',
  'republic of serbia': 'RS',
  'united republic of tanzania': 'TZ',
  'czechia': 'CZ',
  'eswatini': 'SZ',
  'macedonia': 'MK',
  'north macedonia': 'MK',
  'ivory coast': 'CI',
  'cabo verde': 'CV',
  'east timor': 'TL',
  'myanmar': 'MM',
  'the bahamas': 'BS',
  'the gambia': 'GM',
  'guinea bissau': 'GW',
  'sao tome and principe': 'ST',
  'são tomé and principe': 'ST',
  'vatican': 'VA',
  'turkey': 'TR',
  'türkiye': 'TR',
  'south sudan': 'SS',
  'somaliland': 'SO',
  'northern cyprus': 'EZ',
  'western sahara': 'EH',
  'falkland islands': 'FK',
  'french southern and antarctic lands': 'TF',
  'hong kong s.a.r.': 'HK',
  'macao s.a.r': 'MO',
  'macao s.a.r.': 'MO',
  'palestine': 'PS',
  'brunei': 'BN',
  'laos': 'LA',
  'south korea': 'KR',
  'north korea': 'KP',
  'russia': 'RU',
  'iran': 'IR',
  'syria': 'SY',
  'bolivia': 'BO',
  'venezuela': 'VE',
  'moldova': 'MD',
  'vietnam': 'VN',
  'united kingdom': 'GB',
  'saint martin': 'MF',
  'sint maarten': 'SX',
  'curaçao': 'CW',
  'curacao': 'CW',
  'aland': 'AX',
  'åland': 'AX',
};

/**
 * Work out which country a Natural Earth feature is.
 *
 * Natural Earth writes `-99` into the ISO fields for anything whose status is
 * contested or non-standard — France and Norway among them, historically — so
 * the code fields alone are not enough. The alpha-3 route is the reliable one,
 * because our own countries.json carries the same mapping the rest of the app
 * uses; the name table is the last resort.
 */
export function resolveIso(props) {
  const usable = (v) => (typeof v === 'string' && v.length === 2 && v !== '-9' && v !== '-99' ? v.toUpperCase() : null);

  const direct = usable(props.ISO_A2_EH) ?? usable(props.ISO_A2) ?? usable(props.WB_A2);
  if (direct && countries.countries[direct]) return direct;

  for (const key of ['ADM0_A3', 'ISO_A3_EH', 'ISO_A3', 'SOV_A3', 'GU_A3', 'BRK_A3']) {
    const a3 = props[key];
    if (typeof a3 === 'string' && a3.length === 3) {
      const iso = countries.byIso3[a3.toUpperCase()];
      if (iso) return iso;
    }
  }

  for (const key of ['NAME_EN', 'NAME', 'NAME_LONG', 'ADMIN', 'BRK_NAME', 'FORMAL_EN']) {
    const name = props[key];
    if (typeof name !== 'string') continue;
    const k = name.toLowerCase().trim();
    if (NAME_FIXES[k]) return NAME_FIXES[k];
    if (byName.has(k)) return byName.get(k);
  }

  return direct ?? null;
}

// ---------------------------------------------------------------------------
// Geometry slimming
// ---------------------------------------------------------------------------

const round = (n) => Math.round(n * 10 ** PRECISION) / 10 ** PRECISION;

/**
 * Round a ring's coordinates and drop points that collapse onto their
 * neighbour. Rings shorter than four points after that are degenerate and are
 * dropped by the caller.
 */
function thinRing(ring) {
  const out = [];
  let prevX = NaN;
  let prevY = NaN;

  for (const point of ring) {
    const x = round(point[0]);
    const y = round(point[1]);
    if (x === prevX && y === prevY) continue;
    out.push([x, y]);
    prevX = x;
    prevY = y;
  }

  // A ring has to close on itself.
  if (out.length > 1) {
    const first = out[0];
    const last = out[out.length - 1];
    if (first[0] !== last[0] || first[1] !== last[1]) out.push([first[0], first[1]]);
  }

  return out;
}

function thinPolygon(rings) {
  return rings.map(thinRing).filter((r) => r.length >= 4);
}

/** @returns {object|null} the slimmed geometry, or null if nothing survived. */
export function thinGeometry(geometry) {
  if (!geometry) return null;

  if (geometry.type === 'Polygon') {
    const coordinates = thinPolygon(geometry.coordinates);
    return coordinates.length ? { type: 'Polygon', coordinates } : null;
  }

  if (geometry.type === 'MultiPolygon') {
    const coordinates = geometry.coordinates.map(thinPolygon).filter((p) => p.length);
    if (!coordinates.length) return null;
    // A multipolygon of one is just a polygon, and costs less to describe.
    return coordinates.length === 1
      ? { type: 'Polygon', coordinates: coordinates[0] }
      : { type: 'MultiPolygon', coordinates };
  }

  return geometry;
}

// ---------------------------------------------------------------------------
// Build
// ---------------------------------------------------------------------------

/**
 * Turn raw Natural Earth into the file the map loads.
 *
 * Features keep two properties: `iso` (what feature-state is keyed on) and
 * `name`. Everything else Natural Earth ships — population estimates, economy
 * classifications, a dozen name translations — is dropped.
 */
export function buildCollection(raw) {
  const features = [];
  const unresolved = [];
  const seen = new Set();

  for (const feature of raw.features ?? []) {
    const props = feature.properties ?? {};
    const iso = resolveIso(props);
    const geometry = thinGeometry(feature.geometry);
    if (!geometry) continue;

    if (!iso) {
      unresolved.push(props.NAME_EN ?? props.NAME ?? props.ADMIN ?? '(unnamed)');
      continue;
    }

    seen.add(iso);
    const known = countries.countries[iso];
    const disputed = props.TYPE === 'Disputed' || props.TYPE === 'Indeterminate';

    features.push({
      type: 'Feature',
      // MapLibre needs a top-level id for feature-state on a GeoJSON source,
      // and the ISO code is the natural key — the same one the resolver uses.
      id: iso,
      properties: {
        iso,
        name: known?.name ?? props.NAME_EN ?? props.NAME ?? iso,
        ...(disputed ? { disputed: 1 } : {}),
      },
      geometry,
    });
  }

  // Which destinations we can colour but have no shape for. Not fatal — they
  // simply will not appear — but worth reporting, because a silently missing
  // country is exactly the failure mode this whole exercise is about.
  const missing = (countries.destinations ?? []).filter((iso) => !seen.has(iso));

  return {
    collection: { type: 'FeatureCollection', features },
    stats: { features: features.length, resolved: seen.size, unresolved, missing },
  };
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Fetch, transform and publish the boundaries.
 * @param {object} env
 * @param {{force?: boolean, dryRun?: boolean}} [options]
 */
export async function syncBoundaries(env, { force = false, dryRun = false } = {}) {
  const started = Date.now();

  if (!force && !dryRun) {
    const existing = await env.VISA_DATA_BUCKET.head(BOUNDARY_KEY);
    if (existing) {
      return { ok: true, skipped: 'boundaries already published; pass force=1 to rebuild' };
    }
  }

  const attempts = [];
  let raw = null;
  let source = null;

  for (const url of SOURCES) {
    try {
      const res = await fetch(url, {
        headers: { 'user-agent': 'passportpicker.com boundary sync' },
        cf: { cacheTtl: 0 },
      });
      if (!res.ok) { attempts.push({ url, ok: false, detail: `HTTP ${res.status}` }); continue; }

      const text = await res.text();
      if (text.length > SANITY.maxBytes) {
        attempts.push({ url, ok: false, detail: `${(text.length / 1048576).toFixed(1)} MB is larger than expected` });
        continue;
      }

      raw = JSON.parse(text);
      if (!Array.isArray(raw.features) || raw.features.length < SANITY.minFeatures) {
        attempts.push({ url, ok: false, detail: `only ${raw.features?.length ?? 0} features` });
        raw = null;
        continue;
      }

      source = url;
      attempts.push({ url, ok: true, detail: `${raw.features.length} features, ${(text.length / 1048576).toFixed(1)} MB` });
      break;
    } catch (err) {
      attempts.push({ url, ok: false, detail: String(err?.message ?? err) });
    }
  }

  if (!raw) return { ok: false, error: 'no boundary source could be fetched', attempts };

  const fetched = Date.now();
  const { collection, stats } = buildCollection(raw);

  if (stats.resolved < SANITY.minResolved) {
    return {
      ok: false,
      error: `only ${stats.resolved} features resolved to a country — refusing to publish`,
      stats,
    };
  }

  const body = JSON.stringify(collection);
  const built = Date.now();

  if (dryRun) {
    return {
      ok: true, dryRun: true, source, attempts, stats,
      bytes: body.length,
      timing: { fetchMs: fetched - started, buildMs: built - fetched },
    };
  }

  const version = new Date().toISOString();
  await env.VISA_DATA_BUCKET.put(BOUNDARY_KEY, body, {
    httpMetadata: { contentType: 'application/geo+json', cacheControl: 'public, max-age=31536000, immutable' },
  });
  await env.VISA_DATA_BUCKET.put(BOUNDARY_META_KEY, JSON.stringify({ version, source, bytes: body.length, ...stats }), {
    httpMetadata: { contentType: 'application/json', cacheControl: 'public, max-age=300' },
  });

  return {
    ok: true,
    source,
    version,
    bytes: body.length,
    mb: +(body.length / 1048576).toFixed(2),
    stats,
    timing: { fetchMs: fetched - started, buildMs: built - fetched, totalMs: Date.now() - started },
  };
}
