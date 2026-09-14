import test from 'node:test';
import assert from 'node:assert/strict';

import { resolveIso, thinGeometry, buildCollection } from '../worker/src/boundaries.js';

/** A Natural Earth-shaped feature, with only the properties we read. */
function feature(props, geometry) {
  return {
    type: 'Feature',
    properties: props,
    geometry: geometry ?? {
      type: 'Polygon',
      coordinates: [[[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]]],
    },
  };
}

// ---------------------------------------------------------------------------

test('resolveIso reads the straightforward cases', () => {
  assert.equal(resolveIso({ ISO_A2: 'DE', ADM0_A3: 'DEU', NAME_EN: 'Germany' }), 'DE');
  assert.equal(resolveIso({ ISO_A2_EH: 'JP', ADM0_A3: 'JPN' }), 'JP');
});

test('resolveIso survives the -99 codes Natural Earth uses for contested status', async (t) => {
  // This is the trap: Natural Earth writes -99 into the ISO fields for anything
  // whose status is unusual, and has historically done so for France and
  // Norway. Reading ISO_A2 alone silently loses them.
  await t.test('falls back to alpha-3', () => {
    assert.equal(resolveIso({ ISO_A2: '-99', ISO_A2_EH: '-99', ADM0_A3: 'FRA', NAME_EN: 'France' }), 'FR');
    assert.equal(resolveIso({ ISO_A2: '-99', ADM0_A3: 'NOR', NAME_EN: 'Norway' }), 'NO');
  });

  await t.test('falls back to the name when every code is unusable', () => {
    assert.equal(resolveIso({ ISO_A2: '-99', ADM0_A3: '-99', NAME_EN: 'Kosovo' }), 'XK');
    assert.equal(resolveIso({ ISO_A2: '-99', ADM0_A3: '-99', NAME_EN: 'Somaliland' }), 'SO');
  });

  await t.test('never returns the sentinel itself', () => {
    const r = resolveIso({ ISO_A2: '-99', ADM0_A3: 'ZZZ', NAME_EN: 'Nowhere At All' });
    assert.notEqual(r, '-99');
    assert.equal(r, null);
  });
});

test('resolveIso maps the names Natural Earth spells differently', () => {
  const cases = {
    'United States of America': 'US',
    'Republic of the Congo': 'CG',
    'Democratic Republic of the Congo': 'CD',
    'United Republic of Tanzania': 'TZ',
    'Republic of Serbia': 'RS',
    'Ivory Coast': 'CI',
    'East Timor': 'TL',
    'The Bahamas': 'BS',
    'Hong Kong S.A.R.': 'HK',
    'Western Sahara': 'EH',
  };
  for (const [name, iso] of Object.entries(cases)) {
    assert.equal(resolveIso({ ISO_A2: '-99', ADM0_A3: '-99', NAME_EN: name }), iso, name);
  }
});

// ---------------------------------------------------------------------------

test('thinGeometry rounds coordinates', () => {
  const g = thinGeometry({
    type: 'Polygon',
    coordinates: [[[1.23456789, 2.3456789], [3.1111111, 4.2222222], [5.5, 6.5], [1.23456789, 2.3456789]]],
  });
  assert.deepEqual(g.coordinates[0][0], [1.235, 2.346]);
  assert.deepEqual(g.coordinates[0][1], [3.111, 4.222]);
});

test('thinGeometry drops points that collapse onto their neighbour', () => {
  // Rounding makes nearby vertices identical, which is free simplification —
  // as long as the duplicates are actually removed.
  const dense = [[0, 0], [0.00001, 0.00001], [0.00002, 0], [1, 0], [1, 1], [0, 0]];
  const g = thinGeometry({ type: 'Polygon', coordinates: [dense] });
  assert.ok(g.coordinates[0].length < dense.length, 'should be shorter');
});

test('thinGeometry keeps rings closed', () => {
  const g = thinGeometry({ type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 1]]] });
  const ring = g.coordinates[0];
  assert.deepEqual(ring[0], ring[ring.length - 1], 'first and last point must match');
});

test('thinGeometry discards rings too small to be a shape', () => {
  assert.equal(thinGeometry({ type: 'Polygon', coordinates: [[[0, 0], [0, 0], [0, 0]]] }), null);
  assert.equal(thinGeometry(null), null);
});

test('thinGeometry collapses a single-part multipolygon', () => {
  const g = thinGeometry({
    type: 'MultiPolygon',
    coordinates: [[[[0, 0], [1, 0], [1, 1], [0, 0]]]],
  });
  assert.equal(g.type, 'Polygon', 'a multipolygon of one is just a polygon');
});

test('thinGeometry keeps a genuine multipolygon intact', () => {
  const g = thinGeometry({
    type: 'MultiPolygon',
    coordinates: [
      [[[0, 0], [1, 0], [1, 1], [0, 0]]],
      [[[5, 5], [6, 5], [6, 6], [5, 5]]],
    ],
  });
  assert.equal(g.type, 'MultiPolygon');
  assert.equal(g.coordinates.length, 2);
});

// ---------------------------------------------------------------------------

test('buildCollection produces what MapLibre feature-state needs', () => {
  const { collection } = buildCollection({
    features: [
      feature({ ISO_A2: 'DE', ADM0_A3: 'DEU', NAME_EN: 'Germany' }),
      feature({ ISO_A2: 'FR', ADM0_A3: 'FRA', NAME_EN: 'France' }),
    ],
  });

  for (const f of collection.features) {
    assert.ok(f.id, 'a top-level id is required for feature-state on a GeoJSON source');
    assert.equal(f.id, f.properties.iso, 'and it must match what the resolver keys on');
    assert.deepEqual(Object.keys(f.properties).sort(), ['iso', 'name']);
  }
});

test('buildCollection uses our country names, not Natural Earth’s', () => {
  const { collection } = buildCollection({
    features: [feature({ ISO_A2: 'US', ADM0_A3: 'USA', NAME_EN: 'United States of America' })],
  });
  assert.equal(collection.features[0].properties.name, 'United States');
});

test('buildCollection flags disputed territories', () => {
  const { collection } = buildCollection({
    features: [feature({ ISO_A2: 'EH', ADM0_A3: 'SAH', NAME_EN: 'Western Sahara', TYPE: 'Indeterminate' })],
  });
  assert.equal(collection.features[0].properties.disputed, 1);
});

test('buildCollection reports what it could not place rather than dropping it silently', () => {
  const { collection, stats } = buildCollection({
    features: [
      feature({ ISO_A2: 'DE', ADM0_A3: 'DEU', NAME_EN: 'Germany' }),
      feature({ ISO_A2: '-99', ADM0_A3: '-99', NAME_EN: 'Somewhere Unmappable' }),
    ],
  });

  assert.equal(collection.features.length, 1);
  assert.deepEqual(stats.unresolved, ['Somewhere Unmappable']);
});

test('buildCollection lists destinations it has no shape for', () => {
  // A destination we can colour but cannot draw would otherwise just be absent
  // from the map — the exact failure this project exists to stop repeating.
  const { stats } = buildCollection({
    features: [feature({ ISO_A2: 'DE', ADM0_A3: 'DEU', NAME_EN: 'Germany' })],
  });

  assert.ok(stats.missing.length > 200, 'almost everything is missing from a one-feature input');
  assert.ok(stats.missing.includes('FR'));
  assert.ok(!stats.missing.includes('DE'));
});

test('buildCollection is stable when given nothing', () => {
  const { collection, stats } = buildCollection({});
  assert.deepEqual(collection.features, []);
  assert.equal(stats.resolved, 0);
});
