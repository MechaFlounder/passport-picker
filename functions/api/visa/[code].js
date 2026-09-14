/**
 * GET /api/visa/:code  —  one passport's destination table.
 *
 * Replaces `POST /api/visa-data`, which took a list of passports and returned a
 * bespoke slice. That could never be cached: a POST is uncacheable by
 * definition, so every visitor's map load went all the way to R2 and paid for a
 * read. Splitting it per passport means the edge serves almost all of it, and a
 * visitor with three passports makes three small requests that are already warm
 * for everyone else holding the same passports.
 *
 * The response is immutable for its version: the `v` query parameter carries
 * the manifest timestamp, so a new sync produces new URLs rather than needing a
 * purge. Without `v` the answer is still correct, just cached for an hour.
 */

const ONE_HOUR = 3600;
const ONE_YEAR = 31536000;

export async function onRequestGet(context) {
  const { params, env, request } = context;
  const code = String(params.code ?? '').toUpperCase().replace(/[^A-Z]/g, '');

  if (code.length !== 2) {
    return json({ error: 'expected a two-letter passport code' }, 400);
  }

  const object = await env.VISA_DATA_BUCKET.get(`v2/passport/${code}.json`);
  if (!object) {
    return json({ error: `no data for passport ${code}` }, 404);
  }

  const versioned = new URL(request.url).searchParams.has('v');

  return new Response(object.body, {
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': versioned
        ? `public, max-age=${ONE_YEAR}, immutable`
        : `public, max-age=${ONE_HOUR}, s-maxage=${ONE_YEAR}, stale-while-revalidate=${ONE_YEAR}`,
      etag: object.httpEtag,
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
