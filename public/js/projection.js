/**
 * Drawing the Natural Earth projection on a renderer that only knows Mercator.
 *
 * MapLibre GL JS ships two projections, mercator and globe. Natural Earth — the
 * pseudocylindrical projection this site used before, and the reason the old map
 * did not have Greenland the size of Africa — is not among them, and the only
 * implementation is an unmerged experimental fork.
 *
 * So the geometry is pre-warped instead. For each point we compute where Natural
 * Earth would put it, then work backwards through the Mercator formula to find
 * the latitude that *would* land there. Feed MapLibre those coordinates and its
 * ordinary Mercator rendering draws a Natural Earth map, exactly, with no
 * patched renderer and no access token.
 *
 * The cost is that the coordinates the map deals in are no longer real. Nothing
 * here needs them to be — popups are positioned from the cursor, and every
 * country is identified by its ISO code through feature-state, never by
 * position. But it is why the warp happens in the browser rather than in the
 * stored file: what R2 holds stays honest, ordinary GeoJSON, and changing
 * projection later is a frontend edit rather than a re-sync.
 *
 * Two things must be set on the map for this to hold:
 *   renderWorldCopies: false   the warped world is not a repeating cylinder
 *   no maxBounds in real degrees, since degrees no longer mean degrees
 */

const DEG = Math.PI / 180;

/**
 * Natural Earth (Patterson, 2007), polynomial form from Šavrič et al.
 * Matches d3-geo-projection's `naturalEarth1Raw`.
 *
 * @param {number} lambda longitude in radians
 * @param {number} phi latitude in radians
 * @returns {[number, number]} projected x, y in projection units
 */
export function naturalEarthRaw(lambda, phi) {
  const phi2 = phi * phi;
  const phi4 = phi2 * phi2;
  return [
    lambda * (0.8707 - 0.131979 * phi2 + phi4 * (-0.013791 + phi4 * (0.003971 * phi2 - 0.001529 * phi4))),
    phi * (1.007226 + phi2 * (0.015085 + phi4 * (-0.044475 + 0.028874 * phi2 - 0.005916 * phi4))),
  ];
}

/** Half-width and half-height of the projection, used to set the aspect ratio. */
const X_MAX = naturalEarthRaw(Math.PI, 0)[0];        // ≈ 2.7355
const Y_MAX = naturalEarthRaw(0, Math.PI / 2)[1];     // ≈ 1.4228

/**
 * Half the map's height, in the same units Mercator measures longitude in.
 *
 * Longitude spans 360 of those units, so the half-width is 180. Scaling the
 * half-height by the projection's own ratio is what keeps the drawn map at
 * Natural Earth's proportions (roughly 1.92:1) rather than stretched to fill.
 */
const HALF_HEIGHT = 180 * (Y_MAX / X_MAX);

/**
 * Latitude whose Mercator y matches a given offset from the equator.
 * The inverse Gudermannian, in degrees.
 */
function latitudeForMercatorOffset(offset) {
  return (Math.atan(Math.exp(offset * DEG)) - Math.PI / 4) / DEG * 2;
}

/**
 * Warp one real coordinate into the pair MapLibre must be given to draw it in
 * the right place.
 *
 * @param {number} lng
 * @param {number} lat
 * @returns {[number, number]}
 */
export function warpPoint(lng, lat) {
  // Mercator cannot represent the poles; clamp before projecting so a polygon
  // that reaches ±90 does not produce an infinity.
  const phi = Math.max(-89.999, Math.min(89.999, lat)) * DEG;
  const [x, y] = naturalEarthRaw(lng * DEG, phi);

  return [
    (x / X_MAX) * 180,
    latitudeForMercatorOffset((y / Y_MAX) * HALF_HEIGHT),
  ];
}

/** The extent the warped world occupies, for framing the initial view. */
export const WARPED_BOUNDS = [
  [-180, -latitudeForMercatorOffset(HALF_HEIGHT)],
  [180, latitudeForMercatorOffset(HALF_HEIGHT)],
];

/**
 * Warp every coordinate in a GeoJSON geometry, in place.
 *
 * Mutates rather than rebuilding: the collection is a megabyte and a half of
 * freshly parsed JSON that nothing else holds a reference to, and copying it
 * would double the peak memory for no benefit.
 */
function warpCoordinates(node) {
  if (typeof node[0] === 'number') {
    const [lng, lat] = warpPoint(node[0], node[1]);
    node[0] = lng;
    node[1] = lat;
    return;
  }
  for (const child of node) warpCoordinates(child);
}

/**
 * @param {object} collection a GeoJSON FeatureCollection in real coordinates
 * @returns {object} the same object, warped
 */
export function warpGeoJson(collection) {
  for (const feature of collection.features ?? []) {
    if (feature.geometry?.coordinates) warpCoordinates(feature.geometry.coordinates);
  }
  return collection;
}
