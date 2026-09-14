import test from 'node:test';
import assert from 'node:assert/strict';

import { toLegacyShape } from '../functions/api/visa-data.js';

/**
 * The live page reads this shape. Until it is replaced, a mistake here breaks
 * production silently — the map would render, just in the wrong colours.
 */

test('the compatibility shim speaks the old vocabulary', () => {
  const out = toLegacyShape({
    FR: { s: 'vf', d: 90, l: 'Visa not required' },
    CN: { s: 'visa' },
    GB: { s: 'eta', d: 180, l: 'eTA' },
    XX: { s: 'unknown' },
    KP: { s: 'banned' },
    IN: { s: 'evisa' },
  });

  assert.equal(out.FR.status, 'vf');
  assert.equal(out.CN.status, 'vr', 'the old code calls this "vr"');
  assert.equal(out.GB.status, 'eta');
  assert.equal(out.XX.status, 'na');
  assert.equal(out.KP.status, 'denied');
  assert.equal(out.IN.status, 'ev');
});

test('the shim emits every status the old page can colour', () => {
  // These are the keys of the old statusColors object. Anything outside it
  // would fall through to the default colour and look like missing data.
  const OLD_KEYS = ['citizen', 'fom', 'permit', 'vf', 'voa', 'esta', 'eta', 'ev', 'vr', 'denied', 'na'];
  const NEW = ['citizen', 'fom', 'vf', 'eta', 'voa', 'evisa', 'permit', 'visa', 'banned', 'unknown'];

  const out = toLegacyShape(Object.fromEntries(NEW.map((s, i) => [`C${i}`, { s }])));
  for (const v of Object.values(out)) {
    assert.ok(OLD_KEYS.includes(v.status), `"${v.status}" is not a colour the old page knows`);
  }
});

test('the shim keeps the old zero-for-unknown convention', () => {
  // The old page does arithmetic on `stay`, so it must get a number even though
  // null is the honest answer. Confining the lie to the shim is the point.
  const out = toLegacyShape({ FR: { s: 'vf' } });
  assert.equal(out.FR.stay, 0);
  assert.equal(typeof out.FR.stay, 'number');
});

test('the shim survives an empty or missing table', () => {
  assert.deepEqual(toLegacyShape({}), {});
  assert.deepEqual(toLegacyShape(undefined), {});
  assert.deepEqual(toLegacyShape(null), {});
});

test('the shim restores freedom of movement the feed does not carry', async (t) => {
  // The current page has no way to apply the bloc rule itself, so the shim has
  // to do it — otherwise shipping the new data turns the entire EU from light
  // green into ordinary visa-free green for every European visitor.
  await t.test('EU/EEA', () => {
    const out = toLegacyShape({ ES: { s: 'vf', d: 90 }, FR: { s: 'vf', d: 90 }, US: { s: 'eta', d: 90 } }, 'DE');
    assert.equal(out.ES.status, 'fom');
    assert.equal(out.FR.status, 'fom');
    assert.equal(out.US.status, 'eta', 'and leaves everything else alone');
  });

  await t.test('Common Travel Area beats the UK ETA', () => {
    const out = toLegacyShape({ GB: { s: 'eta', d: 180 } }, 'IE');
    assert.equal(out.GB.status, 'fom');
  });

  await t.test('Trans-Tasman and the GCC', () => {
    assert.equal(toLegacyShape({ NZ: { s: 'vf' } }, 'AU').NZ.status, 'fom');
    assert.equal(toLegacyShape({ SA: { s: 'vf' } }, 'AE').SA.status, 'fom');
  });

  await t.test('a bloc is not contagious', () => {
    assert.notEqual(toLegacyShape({ DE: { s: 'vf' } }, 'GB').DE.status, 'fom');
    assert.notEqual(toLegacyShape({ FR: { s: 'vf' } }, 'US').FR.status, 'fom');
  });

  await t.test('the self-cell reads as citizenship', () => {
    // The upstream feed has no self-cells at all, so without this the old page
    // would colour your own country as "no data".
    assert.equal(toLegacyShape({ US: { s: 'unknown' } }, 'US').US.status, 'citizen');
  });

  await t.test('omitting the passport leaves the old behaviour untouched', () => {
    assert.equal(toLegacyShape({ ES: { s: 'vf', d: 90 } }).ES.status, 'vf');
  });
});
