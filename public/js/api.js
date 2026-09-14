/**
 * Everything the page loads from the network.
 *
 * Per-passport files rather than one bundle: a visitor with three passports
 * fetches three small documents the edge already has warm, instead of POSTing
 * for a bespoke slice that no cache can ever reuse. Each is memoised for the
 * session, so toggling a passport off and on again costs nothing.
 */

const cache = new Map();

async function getJson(url, { label = url } = {}) {
  if (cache.has(url)) return cache.get(url);

  const promise = (async () => {
    const response = await fetch(url, { headers: { accept: 'application/json' } });
    if (!response.ok) {
      let detail = '';
      try {
        const body = await response.json();
        detail = body.error ? ` — ${body.error}` : '';
      } catch { /* a non-JSON error body tells us nothing useful */ }
      throw new Error(`could not load ${label} (${response.status})${detail}`);
    }
    return response.json();
  })();

  // Cache the promise, not the result, so concurrent callers share one request.
  cache.set(url, promise);
  promise.catch(() => cache.delete(url)); // a failure should be retryable
  return promise;
}

export const loadCountries = () => getJson('/data/countries.json', { label: 'country data' });
export const loadOverrides = () => getJson('/data/overrides.json', { label: 'overrides' });

/** Freshness. Never fatal — the map works whether or not this answers. */
export async function loadMeta() {
  try {
    return await getJson('/api/meta', { label: 'data status' });
  } catch {
    return null;
  }
}

/**
 * Visa data for one passport, in the compact `{ISO: {s, d, l}}` shape.
 * @param {string} code ISO-2
 */
export async function loadPassport(code) {
  const body = await getJson(`/api/visa/${code}`, { label: `visa data for ${code}` });
  return body.destinations ?? {};
}

/**
 * Visa data for several passports at once.
 *
 * Requests run in parallel; one failure fails the set, because a map drawn from
 * a partial answer would quietly understate what someone can do.
 *
 * @param {string[]} codes
 * @returns {Promise<Record<string, object>>}
 */
export async function loadPassports(codes) {
  const rows = await Promise.all(codes.map(async (code) => [code, await loadPassport(code)]));
  return Object.fromEntries(rows);
}

export const BOUNDARIES_URL = '/api/boundaries';
