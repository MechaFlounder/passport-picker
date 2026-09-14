/**
 * GET /api/boundaries  —  the country geometry the map draws.
 *
 * Roughly a megabyte of GeoJSON that changes perhaps once a year, so it is
 * served `immutable` and answered by the edge for all but the first visitor in
 * each location. That is the whole reason this replaces a Mapbox vector
 * tileset: no access token, no token round-trip on page load, and no per-map-load
 * billing — just a static file Cloudflare is already good at serving.
 */

const ONE_YEAR = 31536000;

export async function onRequestGet(context) {
  const { env, request } = context;

  // Pages keeps Production and Preview configuration separate, so a binding
  // that exists in one is routinely missing from the other.
  if (!env.VISA_DATA_BUCKET) {
    return json({
      error: 'R2 binding VISA_DATA_BUCKET is not configured for this environment',
      fix: 'Pages → Settings → Bindings → add VISA_DATA_BUCKET for Preview as well as Production, then redeploy',
    }, 503);
  }

  const object = await env.VISA_DATA_BUCKET.get('v2/boundaries.geojson');
  if (!object) {
    return json({
      error: 'boundaries have not been published yet',
      fix: 'POST /boundaries on the sync Worker with the SYNC_SECRET',
    }, 503);
  }

  // Let the browser skip the download entirely when it already has this version.
  const etag = object.httpEtag;
  if (request.headers.get('if-none-match') === etag) {
    return new Response(null, { status: 304, headers: { etag, 'cache-control': `public, max-age=${ONE_YEAR}, immutable` } });
  }

  return new Response(object.body, {
    headers: {
      'content-type': 'application/geo+json; charset=utf-8',
      'cache-control': `public, max-age=${ONE_YEAR}, immutable`,
      etag,
      'access-control-allow-origin': '*',
    },
  });
}

function json(body, status) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}
