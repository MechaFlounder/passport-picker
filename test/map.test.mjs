import test from 'node:test';
import assert from 'node:assert/strict';

import { hatchSegments } from '../public/js/map.js';

/**
 * The tie hatch is the whole of the new design for equivalent passports, and it
 * fails silently: a texture that draws nothing still renders, still reports the
 * right feature state, and still passes every other check. The first version
 * put 2 of 64 pixels on the tile and looked exactly like no hatch at all.
 *
 * There is no canvas in Node, so these test the geometry instead — which is
 * where the bug actually was.
 */

/** Does a segment cross the tile's interior, rather than clipping a corner? */
function interiorLength(segment, size) {
  const [x1, y1, x2, y2] = segment;
  const steps = 200;
  let inside = 0;

  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const x = x1 + (x2 - x1) * t;
    const y = y1 + (y2 - y1) * t;
    if (x >= 0 && x <= size && y >= 0 && y <= size) inside++;
  }

  return (inside / steps) * Math.hypot(x2 - x1, y2 - y1);
}

test('the hatch actually crosses the tile', () => {
  const size = 8;
  const segments = hatchSegments(size);
  const covered = segments.reduce((sum, s) => sum + interiorLength(s, size), 0);

  // The tile diagonal is ~11.3 units. The broken version covered ~0.
  assert.ok(
    covered > size,
    `hatch covers only ${covered.toFixed(2)} units inside an ${size}×${size} tile`,
  );
});

test('the main diagonal spans corner to corner', () => {
  const size = 8;
  const [main] = hatchSegments(size);
  assert.deepEqual(main, [0, size, size, 0]);
  assert.ok(
    interiorLength(main, size) > size * 1.3,
    'the primary stroke must run the full diagonal',
  );
});

test('the hatch tiles seamlessly', () => {
  // A 45° hatch repeats correctly only if the corners the main diagonal misses
  // are filled by fragments that continue the same line in the next tile.
  const size = 8;
  const segments = hatchSegments(size);
  assert.equal(segments.length, 3, 'main diagonal plus two corner fragments');

  for (const [x1, y1, x2, y2] of segments) {
    const slope = (y2 - y1) / (x2 - x1);
    assert.equal(slope, -1, 'every stroke runs at the same 45° angle');
  }
});

test('the corner fragments sit at opposite corners', () => {
  const size = 8;
  const [, topLeft, bottomRight] = hatchSegments(size);
  const midpoint = ([x1, y1, x2, y2]) => [(x1 + x2) / 2, (y1 + y2) / 2];

  assert.deepEqual(midpoint(topLeft), [0, 0]);
  assert.deepEqual(midpoint(bottomRight), [size, size]);
});

test('the hatch scales with the tile', () => {
  for (const size of [4, 8, 16, 32]) {
    const covered = hatchSegments(size).reduce((sum, s) => sum + interiorLength(s, size), 0);
    assert.ok(covered > size, `size ${size} covers only ${covered.toFixed(2)}`);
  }
});
