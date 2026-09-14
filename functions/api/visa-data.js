/**
 * POST /api/visa-data  —  compatibility shim for the old frontend.
 *
 * The current site posts `{passports: [...]}` here and expects the legacy
 * record shape back. Keeping it alive means the data migration can ship on its
 * own, ahead of the frontend rebuild, and that a cached copy of the old page
 * in someone's browser keeps working afterwards.
 *
 * New code should use `GET /api/visa/:code`, which the edge can actually cache.
 * Delete this file once the old page is no longer being served anywhere.
 */

export async function onRequestPost(context) {
  const { request, env } = context;

  // Pages keeps Production and Preview configuration separate, so a binding
  // that exists in one is routinely missing from the other.
  if (!env.VISA_DATA_BUCKET) {
    return json({
      error: 'R2 binding VISA_DATA_BUCKET is not configured for this environment',
      fix: 'Pages → Settings → Bindings → add VISA_DATA_BUCKET for Preview as well as Production, then redeploy',
    }, 503);
  }

  let passports;
  try {
    ({ passports } = await request.json());
  } catch {
    return json({ error: 'expected a JSON body' }, 400);
  }

  if (!Array.isArray(passports)) {
    return json({ error: 'missing or invalid passports array' }, 400);
  }

  // Bound the work: the UI caps selection at eight, and an unbounded list here
  // would let anyone turn one request into hundreds of R2 reads.
  const codes = [...new Set(
    passports
      .map((c) => String(c).toUpperCase().replace(/[^A-Z]/g, ''))
      .filter((c) => c.length === 2),
  )].slice(0, 12);

  const entries = await Promise.all(codes.map(async (code) => {
    const object = await env.VISA_DATA_BUCKET.get(`v2/passport/${code}.json`);
    if (!object) return null;
    const { destinations } = await object.json();
    return [code, toLegacyShape(destinations, code)];
  }));

  const out = {};
  for (const entry of entries) if (entry) out[entry[0]] = entry[1];

  return json(out, 200, 'public, max-age=300');
}

/**
 * Free-movement blocs, inlined.
 *
 * Normally this would be imported from `public/js/` so there is exactly one
 * copy — that single-source rule is why the old codebase's two disagreeing
 * parsers could not happen again. The exception is deliberate and bounded: this
 * file is a temporary shim with a delete-by date, and a Pages Function that
 * imports across directories is a build-time risk on a deploy that otherwise
 * carries none. When this file goes, the duplicate goes with it.
 *
 * It has to be here at all because the synced data does not carry freedom of
 * movement — the upstream feed calls intra-EU travel "visa free" — and the
 * current page has no way to apply the rule itself. Without this, deploying
 * would turn the whole EU bloc from light green to ordinary visa-free green for
 * every European visitor.
 */
const BLOCS = {
  eu: new Set(['AT', 'BE', 'BG', 'HR', 'CY', 'CZ', 'DK', 'EE', 'FI', 'FR', 'DE', 'GR', 'HU', 'IE', 'IT', 'LV', 'LT', 'LU', 'MT', 'NL', 'PL', 'PT', 'RO', 'SK', 'SI', 'ES', 'SE', 'IS', 'LI', 'NO', 'CH']),
  cta: new Set(['IE', 'GB']),
  tasman: new Set(['AU', 'NZ']),
  gcc: new Set(['BH', 'KW', 'OM', 'QA', 'SA', 'AE']),
};

/** Do these two share a bloc that confers a right of residence? */
function sharesBloc(passport, destination) {
  for (const members of Object.values(BLOCS)) {
    if (members.has(passport) && members.has(destination)) return true;
  }
  return false;
}

/** Translate the compact v2 cell back into what the old page expects. */
export function toLegacyShape(destinations, passport) {
  const LEGACY = {
    visa: 'vr', evisa: 'ev', banned: 'denied', unknown: 'na',
    vf: 'vf', fom: 'fom', voa: 'voa', eta: 'eta', citizen: 'citizen', permit: 'permit',
  };

  const out = {};
  for (const [code, cell] of Object.entries(destinations ?? {})) {
    if (passport && code === passport) {
      out[code] = { status: 'citizen', stay: 0, visa: 'Citizen' };
      continue;
    }

    if (passport && sharesBloc(passport, code)) {
      out[code] = { status: 'fom', stay: 0, visa: 'Freedom of movement' };
      continue;
    }

    out[code] = {
      status: LEGACY[cell.s] ?? 'na',
      stay: cell.d ?? 0,
      visa: cell.l ?? undefined,
    };
  }
  return out;
}

function json(body, status = 200, cacheControl = 'no-store') {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': cacheControl,
    },
  });
}
