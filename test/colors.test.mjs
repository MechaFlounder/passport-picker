import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { assignColors, distance, contrastingInk, usableAsFill } from '../public/js/colors.js';

const meta = JSON.parse(
  fs.readFileSync(path.join(import.meta.dirname, '..', 'public/data/countries.json'), 'utf8'),
);

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
  const colors = assignColors(eight, meta);

  assert.deepEqual(Object.keys(colors).sort(), [...eight].sort());
  for (const c of Object.values(colors)) {
    assert.match(c, /^#[0-9A-Fa-f]{6}$/);
  }
});

test('assigned colours are distinguishable from one another', () => {
  // The point of the exercise: two passports that look alike on the map make
  // the best-passport view useless, and flag colours collide constantly.
  const eight = ['US', 'GB', 'DE', 'JP', 'AU', 'CA', 'SG', 'BR'];
  const colors = Object.values(assignColors(eight, meta));

  for (let i = 0; i < colors.length; i++) {
    for (let j = i + 1; j < colors.length; j++) {
      assert.ok(
        distance(colors[i], colors[j]) > 18,
        `${colors[i]} and ${colors[j]} are too close to tell apart`,
      );
    }
  }
});

test('assignColors prefers a country’s own colours when it can', () => {
  // The United States has a brand entry; on its own there is nothing to clash
  // with, so it should get it.
  const solo = assignColors(['US'], meta);
  assert.equal(solo.US, meta.countries.US.brand.primary);
});

test('assignColors is deterministic, so a shared link looks the same to everyone', () => {
  const passports = ['US', 'IE', 'DE', 'JP'];
  assert.deepEqual(assignColors(passports, meta), assignColors(passports, meta));
});

test('assignColors reflects order, because order is the tie-break', () => {
  const a = assignColors(['US', 'GB'], meta);
  const b = assignColors(['GB', 'US'], meta);
  // Both get a colour either way; the first pick has priority on collisions.
  assert.ok(a.US && a.GB && b.US && b.GB);
});

test('assignColors terminates even when asked for more than the palette holds', () => {
  const many = meta.passports.slice(0, 20);
  const colors = assignColors(many, meta);
  assert.equal(Object.keys(colors).length, many.length);
});

test('assignColors copes with countries that have no brand colours', () => {
  const noBrand = meta.passports.filter((p) => !meta.countries[p].brand).slice(0, 6);
  assert.ok(noBrand.length >= 4, 'fixture assumption');

  const colors = assignColors(noBrand, meta);
  for (const c of noBrand) assert.match(colors[c], /^#[0-9A-Fa-f]{6}$/);
});

test('assignColors returns nothing for an empty selection', () => {
  assert.deepEqual(assignColors([], meta), {});
});

test('extreme brand colours are rejected as map fills', async (t) => {
  await t.test('black and white are unusable', () => {
    assert.equal(usableAsFill('#000000'), false);
    assert.equal(usableAsFill('#FFFFFF'), false);
    assert.equal(usableAsFill('#0A0A0A'), false);
    assert.equal(usableAsFill('#FAFAFA'), false);
  });

  await t.test('ordinary flag colours are fine', () => {
    for (const hex of ['#B31942', '#0A3161', '#169B62', '#FFCE00', '#009246', '#CF142B']) {
      assert.equal(usableAsFill(hex), true, hex);
    }
  });

  await t.test('Germany does not paint the world black', () => {
    // Germany's brand primary is #000000. It wins most destinations for anyone
    // holding it, so taking it literally turned most of the map black, hid the
    // borders and reduced the tie hatch to grey noise.
    assert.equal(meta.countries.DE.brand.primary, '#000000', 'fixture assumption');

    const assigned = assignColors(['DE'], meta).DE;
    assert.notEqual(assigned, '#000000');
    assert.equal(usableAsFill(assigned), true);
  });

  await t.test('it falls through to the secondary colour first', () => {
    assert.equal(assignColors(['DE'], meta).DE, meta.countries.DE.brand.secondary);
  });

  await t.test('every assigned colour is usable, for every passport', () => {
    for (const iso of meta.passports) {
      const hex = assignColors([iso], meta)[iso];
      assert.equal(usableAsFill(hex), true, `${iso} got ${hex}`);
    }
  });
});
