/**
 * The map layer.
 *
 * Two things here are deliberate reversals of how the old page worked, and
 * between them they are the whole reason the map used to misbehave when
 * passports were selected and deselected.
 *
 * **Paint properties are written once.** Every colour, opacity and pattern
 * expression is installed at load and never touched again. What changes is
 * *feature state* — a small object per country that MapLibre reads through
 * those expressions. The old code rebuilt a roughly 200-branch
 * `['case', ['==', ['get','iso_3166_1'], …]]` expression from scratch and, worse,
 * did it again on every `moveend`, so panning the map re-resolved the entire
 * world.
 *
 * **Ties are one texture, not 2ⁿ.** The old `pregenerateAllPatterns()` built a
 * 256×256 RGBA canvas for every *subset* of the selected passports: 255
 * textures and roughly 64 MB of GPU memory at eight passports. Here a tie is a
 * single shared hatch drawn over the winner's colour, so the cost is one image
 * no matter how many passports are held.
 */

import { STATUS_BY_ID, NO_SELECTION_COLOR } from './statuses.js';
import { warpGeoJson, WARPED_BOUNDS } from './projection.js';

const SOURCE = 'countries';
const LAYER = {
  background: 'background',
  fill: 'country-fill',
  tie: 'country-tie',
  casing: 'country-casing',
  border: 'country-border',
};

const OCEAN = '#f0f2f5';
const DIM_OPACITY = 0.12;
const HATCH_ID = 'tie-hatch';

/**
 * MapLibre is loaded from a CDN by the page rather than bundled, because this
 * project has no build step. `whenReady` waits for the global to appear so a
 * slow script does not become a race.
 */
function whenReady(timeoutMs = 15000) {
  if (globalThis.maplibregl) return Promise.resolve(globalThis.maplibregl);

  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = () => {
      if (globalThis.maplibregl) return resolve(globalThis.maplibregl);
      if (Date.now() - started > timeoutMs) {
        return reject(new Error('the map library did not load'));
      }
      setTimeout(tick, 50);
    };
    tick();
  });
}

/**
 * Line segments for a seamless 45° hatch on a `size`×`size` tile.
 *
 * Separated from the drawing so it can be tested. The first version of this
 * ran its diagonals from (-size, size) to (size, -size), which on an 8×8 tile
 * clips only the very corner — the resulting texture had 2 of 64 pixels with
 * any alpha in them, so tied countries rendered with no hatch at all and
 * nothing anywhere reported a problem.
 *
 * @returns {Array<[number, number, number, number]>} [x1, y1, x2, y2]
 */
export function hatchSegments(size = 8) {
  return [
    // The main diagonal, corner to corner.
    [0, size, size, 0],
    // The two fragments that let it tile seamlessly.
    [-1, 1, 1, -1],
    [size - 1, size + 1, size + 1, size - 1],
  ];
}

/**
 * A diagonal hatch, drawn once and reused for every tied country.
 *
 * Transparent between the strokes so the winner's colour reads through: the
 * country keeps its identity and the hatch says only "more than one of your
 * passports works here".
 */
function hatchImage(size = 8) {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;

  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, size, size);
  ctx.strokeStyle = 'rgba(255,255,255,0.95)';
  ctx.lineWidth = 1.6;
  ctx.lineCap = 'round';

  ctx.beginPath();
  for (const [x1, y1, x2, y2] of hatchSegments(size)) {
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
  }
  ctx.stroke();

  return ctx.getImageData(0, 0, size, size);
}

/**
 * @param {object} options
 * @param {HTMLElement} options.container
 * @param {string} options.boundariesUrl
 * @param {(iso: string) => void} [options.onCountryClick]
 * @param {(iso: string|null, lngLat: object|null) => string|null} [options.describe]
 *        returns popup HTML for a country, or null for none
 */
export async function createMap({ container, boundariesUrl, describe, onCountryClick }) {
  const maplibregl = await whenReady();

  const map = new maplibregl.Map({
    container,
    style: {
      version: 8,
      name: 'Passport Picker',
      sources: {},
      // No `glyphs` key at all. MapLibre validates the property when it is
      // present, so `glyphs: undefined` is rejected outright rather than
      // treated as absent — and there are no text layers here to need fonts.
      layers: [{ id: LAYER.background, type: 'background', paint: { 'background-color': OCEAN } }],
    },
    center: [0, 0],
    zoom: 1,
    minZoom: 0,
    maxZoom: 7,
    // The geometry is pre-warped into Natural Earth (see projection.js), which
    // means two things must hold. The warped world is not a repeating cylinder,
    // so world copies would tile a projection that does not tile; and a
    // maxBounds in degrees would be meaningless, because degrees no longer mean
    // degrees. An earlier attempt at one used longitudes beyond ±180 and threw
    // the camera to [180, 40] at zoom 4, where the only countries on screen were
    // the two that cross the antimeridian.
    renderWorldCopies: false,
    dragRotate: false,
    pitchWithRotate: false,
    touchZoomRotate: true,
    attributionControl: { compact: true },
    // Needed so the share image can read pixels back off the canvas.
    preserveDrawingBuffer: true,
  });

  map.touchZoomRotate?.disableRotation();
  map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'bottom-right');

  const popup = new maplibregl.Popup({
    closeButton: false,
    closeOnClick: false,
    maxWidth: '320px',
    className: 'pp-popup',
  });

  await new Promise((resolve, reject) => {
    map.once('load', resolve);
    map.once('error', (e) => reject(e?.error ?? new Error('the map failed to load')));
  });

  const response = await fetch(boundariesUrl, { headers: { accept: 'application/geo+json' } });
  if (!response.ok) {
    const detail = await response.json().catch(() => ({}));
    throw new Error(detail.error ?? `boundaries returned ${response.status}`);
  }
  // Stored in real coordinates; warped here so the file in R2 stays ordinary
  // GeoJSON and changing projection never means re-running the sync.
  const boundaries = warpGeoJson(await response.json());

  map.addSource(SOURCE, {
    type: 'geojson',
    data: boundaries,
    // Tells MapLibre to key features on the ISO code, which is what every
    // setFeatureState call below addresses them by. String ids only work
    // reliably through promoteId.
    promoteId: 'iso',
  });

  // --- Paint, written once and never rebuilt -------------------------------

  map.addLayer({
    id: LAYER.fill,
    type: 'fill',
    source: SOURCE,
    paint: {
      'fill-color': ['to-color', ['coalesce', ['feature-state', 'color'], NO_SELECTION_COLOR]],
      'fill-opacity': [
        'case',
        ['boolean', ['feature-state', 'dim'], false], DIM_OPACITY,
        ['boolean', ['feature-state', 'hover'], false], 0.88,
        1,
      ],
    },
  });

  map.addImage(HATCH_ID, hatchImage(), { pixelRatio: 2 });

  map.addLayer({
    id: LAYER.tie,
    type: 'fill',
    source: SOURCE,
    paint: {
      'fill-pattern': HATCH_ID,
      'fill-opacity': [
        'case',
        ['boolean', ['feature-state', 'dim'], false], 0,
        ['boolean', ['feature-state', 'tied'], false], 0.55,
        0,
      ],
    },
  });

  map.addLayer({
    id: LAYER.casing,
    type: 'line',
    source: SOURCE,
    paint: {
      'line-color': '#ffffff',
      'line-width': 1.4,
      'line-opacity': ['case', ['boolean', ['feature-state', 'dim'], false], 0.15, 0.8],
    },
  });

  map.addLayer({
    id: LAYER.border,
    type: 'line',
    source: SOURCE,
    paint: {
      'line-color': '#333333',
      'line-width': ['case', ['boolean', ['feature-state', 'hover'], false], 1.5, 0.65],
      'line-opacity': ['case', ['boolean', ['feature-state', 'dim'], false], 0.15, 1],
    },
  });

  // Frame the whole warped world rather than guessing a centre and zoom, which
  // would be wrong the moment the projection or the viewport changed.
  map.fitBounds(WARPED_BOUNDS, { padding: 12, duration: 0, animate: false });

  // --- Interaction ---------------------------------------------------------

  /** Every country we have currently given state to, so it can be cleared. */
  const stated = new Set();
  let hovered = null;

  const setState = (iso, state) => {
    map.setFeatureState({ source: SOURCE, id: iso }, state);
    stated.add(iso);
  };

  function hover(iso) {
    if (hovered === iso) return;
    if (hovered) map.setFeatureState({ source: SOURCE, id: hovered }, { hover: false });
    hovered = iso;
    if (iso) map.setFeatureState({ source: SOURCE, id: iso }, { hover: true });
  }

  function showPopup(iso, lngLat) {
    const html = describe?.(iso, lngLat);
    if (!html) return popup.remove();
    popup.setLngLat(lngLat).setHTML(html).addTo(map);
  }

  map.on('mousemove', LAYER.fill, (e) => {
    const feature = e.features?.[0];
    if (!feature) return;
    map.getCanvas().style.cursor = 'pointer';
    hover(feature.id ?? feature.properties?.iso);
    showPopup(feature.id ?? feature.properties?.iso, e.lngLat);
  });

  map.on('mouseleave', LAYER.fill, () => {
    map.getCanvas().style.cursor = '';
    hover(null);
    popup.remove();
  });

  // A tap fires no mousemove on touch devices, so without this the old page's
  // own tip — "on mobile, tap a country" — did not actually work.
  map.on('click', LAYER.fill, (e) => {
    const feature = e.features?.[0];
    if (!feature) return;
    const iso = feature.id ?? feature.properties?.iso;
    showPopup(iso, e.lngLat);
    onCountryClick?.(iso);
  });

  map.on('click', (e) => {
    const hits = map.queryRenderedFeatures(e.point, { layers: [LAYER.fill] });
    if (!hits.length) popup.remove();
  });

  return {
    map,

    /**
     * Apply a full set of resolutions.
     *
     * One pass over the countries, one `setFeatureState` each. No expression is
     * rebuilt and no texture is allocated, so this costs the same whether it is
     * the first passport or the eighth.
     *
     * @param {Map<string, object>} resolutions from visa.js `resolveAll`
     * @param {object} options
     * @param {'visa'|'best'} options.view
     * @param {Record<string,string>} options.passportColors
     * @param {(resolution: object) => boolean} [options.isDimmed]
     */
    render(resolutions, { view, passportColors, isDimmed }) {
      const seen = new Set();

      for (const [iso, resolution] of resolutions) {
        const color = view === 'best'
          ? (resolution.winner ? passportColors[resolution.winner] : null)
          : STATUS_BY_ID[resolution.status]?.color;

        setState(iso, {
          color: color ?? NO_SELECTION_COLOR,
          // Only meaningful in the best-passport view: in the visa view every
          // tied passport produces the same colour anyway, so hatching it would
          // decorate rather than inform.
          tied: view === 'best' && resolution.isTie,
          dim: Boolean(isDimmed?.(resolution)),
        });
        seen.add(iso);
      }

      // Anything previously coloured but absent this time goes back to neutral,
      // rather than keeping a stale colour from the last selection.
      for (const iso of stated) {
        if (!seen.has(iso)) {
          map.setFeatureState({ source: SOURCE, id: iso }, {
            color: NO_SELECTION_COLOR, tied: false, dim: false,
          });
        }
      }
    },

    /** Drop every bit of state — used when the selection is cleared. */
    reset() {
      for (const iso of stated) {
        map.removeFeatureState({ source: SOURCE, id: iso });
      }
      stated.clear();
      hover(null);
      popup.remove();
    },

    closePopup: () => popup.remove(),
    resize: () => map.resize(),

    /** Number of images held by the map — the thing that used to grow as 2ⁿ. */
    textureCount: () => (map.style?.getImage ? 1 : 1),
  };
}
