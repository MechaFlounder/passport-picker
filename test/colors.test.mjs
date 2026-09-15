import test from 'node:test';
import assert from 'node:assert/strict';
import { assignColors, distance, contrastingInk, CATEGORICAL_PALETTE, COLOUR_SAFE_LIMIT } from '../public/js/colors.js';

test('distance ranks colours the way the eye does', () => {
  assert.ok(distance('#FF0000', '#FE0101') < 3, 'near-identical reds');
  assert.ok(distance('#FF0000', '#0000FF') > 50, 'red and blue are far apart');
  assert.ok(
    distance('#FF0000', '#00FF00') > distance('#FF0000', '#FF8800'),
    'red is further from green than from orange',
  );
});

test('distance survives malformed input', () => {
  assert.equal(distance('not-a-colour', '#FFF'), Infinity);
  assert.equal(distance(undefined, '#FFF'), Infinity);
});

test('contrastingInk picks readable text', () => {
  assert.equal(contrastingInk('#FFFFFF'), '#111827');
  assert.equal(contrastingInk('#FFE119'), '#111827', 'dark text on yellow');
  assert.equal(contrastingInk('#000075'), '#ffffff', 'light text on navy');
  assert.equal(contrastingInk('#B31942'), '#ffffff');
});

test('assignColors gives every passport a colour', () => {
  const eight = ['US', 'GB', 'DE', 'JP', 'AU', 'CA', 'SG', 'BR'];
  const colors = assignColors(eight);

  assert.deepEqual(Object.keys(colors).sort(), [...eight].sort());
  for (const c of Object.values(colors)) assert.match(c, /^#[0-9A-Fa-f]{6}$/);
});

test('slots are assigned by position, not by country', () => {
  // Colour follows the user's ordering, so reordering the tray to change a
  // tie-break repaints predictably instead of reshuffling the whole map.
  assert.equal(assignColors(['CA', 'CN']).CA, assignColors(['CN', 'CA']).CN);
  assert.equal(assignColors(['CA']).CA, CATEGORICAL_PALETTE[0]);
});

test('Canada and China are no longer two reds', () => {
  // The reported bug: flag-derived colours gave #FF0000 and #E6194B, which on a
  // map are the same colour. Both orderings must now be clearly separable.
  for (const order of [['CA', 'CN'], ['CN', 'CA']]) {
    const c = assignColors(order);
    assert.ok(
      distance(c.CA, c.CN) > 60,
      `${order.join('+')} gave ${c.CA} and ${c.CN}`,
    );
  }
});

test('the palette is the validated one, in its validated order', () => {
  // Re-ordering silently would undo the validation these were chosen under.
  assert.deepEqual(CATEGORICAL_PALETTE, [
    '#2a78d6', '#eb6834', '#1baf7a', '#eda100',
    '#e87ba4', '#008300', '#4a3aa7', '#e34948',
  ]);
});

test('the first slots — the common selections — are the strongest', () => {
  // A choropleth needs every pair separable, not just adjacent ones, and only
  // the first three clear that bar. Most people hold one or two passports, so
  // the ordering spends its best separation where it is most used.
  const three = CATEGORICAL_PALETTE.slice(0, COLOUR_SAFE_LIMIT);
  for (let i = 0; i < three.length; i++) {
    for (let j = i + 1; j < three.length; j++) {
      assert.ok(distance(three[i], three[j]) > 45, `${three[i]} vs ${three[j]}`);
    }
  }
});

test('colours repeat rather than degrade past the palette', () => {
  const many = Array.from({ length: 12 }, (_, i) => `P${i}`);
  const colors = assignColors(many);
  assert.equal(colors.P0, colors[`P${CATEGORICAL_PALETTE.length}`], 'slot 9 reuses slot 1');
  for (const c of Object.values(colors)) assert.ok(CATEGORICAL_PALETTE.includes(c));
});

test('assignColors is deterministic, so a shared link looks the same to everyone', () => {
  const passports = ['US', 'IE', 'DE', 'JP'];
  assert.deepEqual(assignColors(passports), assignColors(passports));
});

test('assignColors returns nothing for an empty selection', () => {
  assert.deepEqual(assignColors([]), {});
});

test('every palette colour takes readable text', () => {
  for (const hex of CATEGORICAL_PALETTE) {
    assert.match(contrastingInk(hex), /^#(111827|ffffff)$/);
  }
});
