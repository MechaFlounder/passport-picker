import test from 'node:test';
import assert from 'node:assert/strict';

import { naturalEarthRaw, warpPoint, warpGeoJson, WARPED_BOUNDS } from '../public/js/projection.js';

/** Mercator's y for a latitude, in the units MapLibre measures longitude in. */
function mercatorOffset(lat) {
  const rad = lat * Math.PI / 180;
  return Math.log(Math.tan(Math.PI / 4 + rad / 2)) * 180 / Math.PI;
}

test('naturalEarthRaw matches the published polynomial', () => {
  // Reference values from d3-geo-projection's naturalEarth1Raw.
  const [x0, y0] = naturalEarthRaw(0, 0);
  assert.equal(x0, 0);
  assert.equal(y0, 0);

  const [x1] = naturalEarthRaw(Math.PI, 0);
  assert.ok(Math.abs(x1 - 0.8707 * Math.PI) < 1e-9, 'equator width is λ·0.8707');

  const [, y2] = naturalEarthRaw(0, Math.PI / 2);
  assert.ok(Math.abs(y2 - 1.4228) < 0.001, `pole height ≈ 1.4228, got ${y2}`);
});

test('the projection narrows towards the poles, which is the whole point', () => {
  // Natural Earth's parallels shorten with latitude; Mercator's do not, which is
  // why Greenland looks the size of Africa on the version we are replacing.
  const widthAt = (lat) => naturalEarthRaw(Math.PI, lat * Math.PI / 180)[0];
  assert.ok(widthAt(75) < widthAt(45));
  assert.ok(widthAt(45) < widthAt(0));
});

test('warpPoint fixes the equator and the prime meridian', () => {
  assert.deepEqual(warpPoint(0, 0).map((n) => Math.round(n * 1e9) / 1e9), [0, 0]);

  const [x] = warpPoint(180, 0);
  assert.ok(Math.abs(x - 180) < 1e-9, 'the equator spans the full width');
});

test('warping then rendering through Mercator reproduces Natural Earth', () => {
  // The claim this file rests on: for any point, Mercator applied to the warped
  // coordinate lands where Natural Earth said it should.
  const ratio = (lat) => {
    const [, warpedLat] = warpPoint(0, lat);
    return mercatorOffset(warpedLat);
  };

  const yOf = (lat) => naturalEarthRaw(0, lat * Math.PI / 180)[1];
  const scale = ratio(45) / yOf(45);

  for (const lat of [-80, -60, -30, -10, 10, 30, 60, 80]) {
    const predicted = yOf(lat) * scale;
    assert.ok(
      Math.abs(ratio(lat) - predicted) < 1e-6,
      `latitude ${lat}: mercator(warped) should be proportional to naturalEarth y`,
    );
  }
});

test('the drawn map keeps Natural Earth’s proportions', () => {
  // Natural Earth is about 1.92:1. A projection that filled a square would be
  // stretched, and would look nothing like the map this site used to have.
  const top = mercatorOffset(warpPoint(0, 90)[1]);
  const halfWidth = 180;
  const aspect = halfWidth / top;

  assert.ok(aspect > 1.85 && aspect < 2.0, `aspect ratio ${aspect.toFixed(3)} should be ≈1.92`);
});

test('the poles stay inside what Mercator can represent', () => {
  for (const lat of [90, -90, 89.9999, -89.9999]) {
    const [, warped] = warpPoint(0, lat);
    assert.ok(Number.isFinite(warped), `latitude ${lat} produced ${warped}`);
    assert.ok(Math.abs(warped) < 85, 'must stay within the Mercator limit');
  }
});

test('warping is monotonic, so nothing turns inside out', () => {
  let previousLat = -Infinity;
  for (let lat = -90; lat <= 90; lat += 5) {
    const [, warped] = warpPoint(0, lat);
    assert.ok(warped > previousLat, `latitude ${lat} broke ordering`);
    previousLat = warped;
  }

  let previousLng = -Infinity;
  for (let lng = -180; lng <= 180; lng += 10) {
    const [warped] = warpPoint(lng, 0);
    assert.ok(warped > previousLng, `longitude ${lng} broke ordering`);
    previousLng = warped;
  }
});

test('warping is symmetric about the equator and the meridian', () => {
  for (const lat of [15, 40, 70]) {
    const north = warpPoint(0, lat)[1];
    const south = warpPoint(0, -lat)[1];
    assert.ok(Math.abs(north + south) < 1e-9, `asymmetric at ${lat}`);
  }
  for (const lng of [30, 90, 170]) {
    assert.ok(Math.abs(warpPoint(lng, 0)[0] + warpPoint(-lng, 0)[0]) < 1e-9);
  }
});

test('WARPED_BOUNDS covers the whole warped world', () => {
  const [[west, south], [east, north]] = WARPED_BOUNDS;
  assert.equal(west, -180);
  assert.equal(east, 180);

  for (const lat of [90, -90, 0, 45]) {
    for (const lng of [-180, 0, 180]) {
      const [x, y] = warpPoint(lng, lat);
      assert.ok(x >= west - 1e-6 && x <= east + 1e-6, `${lng},${lat} x out of bounds`);
      assert.ok(y >= south - 1e-6 && y <= north + 1e-6, `${lng},${lat} y out of bounds`);
    }
  }
});

test('warpGeoJson walks every geometry type', () => {
  const collection = {
    type: 'FeatureCollection',
    features: [
      { id: 'A', geometry: { type: 'Polygon', coordinates: [[[0, 0], [10, 0], [10, 10], [0, 0]]] } },
      { id: 'B', geometry: { type: 'MultiPolygon', coordinates: [[[[0, 0], [5, 5], [5, 0], [0, 0]]]] } },
      { id: 'C', geometry: null },
      { id: 'D' },
    ],
  };

  const out = warpGeoJson(collection);
  assert.equal(out, collection, 'warps in place rather than copying a megabyte');

  const a = out.features[0].geometry.coordinates[0];
  assert.deepEqual(a[0], [0, 0], 'the origin is fixed');

  // On the equator Natural Earth is exactly linear in longitude, so 10° stays
  // 10°. The contraction is a function of latitude, not of distance from the
  // meridian — which is what makes the poles narrow.
  assert.ok(Math.abs(a[1][0] - 10) < 1e-9, 'the equator is unscaled');
  assert.ok(a[2][0] < a[1][0], 'the same longitude contracts once away from the equator');
  assert.ok(Number.isFinite(out.features[1].geometry.coordinates[0][0][1][1]));
});

test('warpGeoJson leaves a country recognisable', () => {
  // A crude Brazil: the warped shape must stay in the southern hemisphere, west
  // of the meridian, and keep a sane footprint.
  const brazil = {
    type: 'FeatureCollection',
    features: [{ geometry: { type: 'Polygon', coordinates: [[[-74, 5], [-34, 5], [-34, -34], [-74, -34], [-74, 5]]] } }],
  };

  warpGeoJson(brazil);
  const ring = brazil.features[0].geometry.coordinates[0];

  for (const [x, y] of ring) {
    assert.ok(x < 0, 'stays west of the prime meridian');
    assert.ok(x > -180 && y > -85 && y < 85);
  }
  assert.ok(ring[0][1] > ring[2][1], 'north stays north of south');
});
