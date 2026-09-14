import test from 'node:test';
import assert from 'node:assert/strict';

import {
  parseNested,
  parseMatrixCsv,
  cellFor,
  sanityCheck,
  diff,
} from '../worker/src/index.js';

/** A plausible upstream payload, big enough to clear the sanity thresholds. */
function syntheticWorld({ passports = 200, destinations = 200, status = 'visa free' } = {}) {
  const code = (i) => `P${String(i).padStart(3, '0')}`;
  const dest = (i) => `D${String(i).padStart(3, '0')}`;
  const out = {};
  for (let p = 0; p < passports; p++) {
    out[code(p)] = {};
    for (let d = 0; d < destinations; d++) out[code(p)][dest(d)] = cellFor(status);
  }
  return out;
}

// ---------------------------------------------------------------------------

test('parseNested reads the documented JSON shape', () => {
  const data = parseNested({
    us: { gb: { status: 'visa free', days: 180 }, cn: { status: 'visa required' } },
    ie: { fr: { status: 'visa free', days: 90 } },
  });

  assert.equal(data.US.GB.s, 'vf');
  assert.equal(data.US.GB.d, 180);
  assert.equal(data.US.CN.s, 'visa');
  assert.equal(data.IE.FR.d, 90);
  assert.ok(!('d' in data.US.CN), 'a stay length is meaningless when a visa is required');
});

test('parseNested tolerates bare values as well as objects', () => {
  const data = parseNested({ us: { gb: 180, cn: 'visa required', jp: { requirement: 'eta' } } });
  assert.equal(data.US.GB.s, 'vf');
  assert.equal(data.US.GB.d, 180);
  assert.equal(data.US.CN.s, 'visa');
  assert.equal(data.US.JP.s, 'eta');
});

test('parseNested upper-cases codes, since the feed is lowercase', () => {
  const data = parseNested({ us: { gb: 90 } });
  assert.deepEqual(Object.keys(data), ['US']);
  assert.deepEqual(Object.keys(data.US), ['GB']);
});

test('parseMatrixCsv reads the square-matrix shape', () => {
  const csv = [
    'Passport,US,GB,CN',
    'US,-1,180,visa required',
    'GB,90,-1,visa required',
    'CN,visa required,visa required,-1',
  ].join('\n');

  const data = parseMatrixCsv(csv);
  assert.equal(data.US.GB.s, 'vf');
  assert.equal(data.US.GB.d, 180);
  assert.equal(data.US.US.s, 'citizen', '-1 marks the passport\'s own country');
  assert.equal(data.CN.GB.s, 'visa');
});

test('parseMatrixCsv handles quoted fields containing commas', () => {
  const csv = 'Passport,XX\nUS,"visa free, 90 days"';
  assert.equal(parseMatrixCsv(csv).US.XX.s, 'vf');
});

// ---------------------------------------------------------------------------

test('cellFor keeps records small', () => {
  const c = cellFor('visa free', 90);
  assert.deepEqual(Object.keys(c).sort(), ['d', 'l', 's']);
  assert.ok(JSON.stringify(c).length < 45, 'a cell should cost tens of bytes, not hundreds');
});

test('cellFor records the alternative route when the feed names two', () => {
  const c = cellFor('eTA / Visa on arrival');
  assert.equal(c.s, 'eta');
  assert.deepEqual(c.a, ['voa']);
});

// ---------------------------------------------------------------------------

test('sanityCheck accepts a plausible payload', () => {
  const r = sanityCheck(syntheticWorld());
  assert.equal(r.ok, true);
  assert.equal(r.passports, 200);
  assert.equal(r.destinations, 200);
});

test('sanityCheck rejects payloads that would wreck the map', async (t) => {
  await t.test('too few passports — a truncated or partial fetch', () => {
    const r = sanityCheck(syntheticWorld({ passports: 10 }));
    assert.equal(r.ok, false);
    assert.match(r.reason, /passports/);
  });

  await t.test('too few destinations', () => {
    const r = sanityCheck(syntheticWorld({ destinations: 10 }));
    assert.equal(r.ok, false);
    assert.match(r.reason, /destinations/);
  });

  await t.test('mostly unparseable — upstream changed its vocabulary', () => {
    const r = sanityCheck(syntheticWorld({ status: 'schmisa frobnicated' }));
    assert.equal(r.ok, false);
    assert.match(r.reason, /unknown/);
  });

  await t.test('a status we do not recognise at all', () => {
    const data = syntheticWorld();
    data.P000.D000 = { s: 'totally-made-up' };
    const r = sanityCheck(data);
    assert.equal(r.ok, false);
    assert.match(r.reason, /unrecognised/);
  });

  await t.test('empty input', () => {
    assert.equal(sanityCheck({}).ok, false);
    assert.equal(sanityCheck(null).ok, false);
  });
});

// ---------------------------------------------------------------------------

test('diff reports what actually moved', () => {
  const before = { US: { GB: { s: 'vf', d: 180 }, CN: { s: 'visa' } } };
  const after = { US: { GB: { s: 'eta', d: 180 }, CN: { s: 'visa' } } };

  const d = diff(before, after);
  assert.equal(d.changes.length, 1);
  assert.deepEqual(d.changes[0], { passport: 'US', destination: 'GB', from: 'vf', to: 'eta' });
});

test('diff notices a changed duration even when the status holds', () => {
  const d = diff(
    { US: { GB: { s: 'vf', d: 180 } } },
    { US: { GB: { s: 'vf', d: 90 } } },
  );
  assert.equal(d.changes.length, 1);
  assert.deepEqual(d.changes[0].days, [180, 90]);
});

test('diff treats a brand new cell as a change, not a crash', () => {
  const d = diff({ US: {} }, { US: { GB: { s: 'vf' } } });
  assert.equal(d.changes.length, 1);
  assert.equal(d.changes[0].from, null);
});

test('diff against nothing is empty, so a first run is not a churn alarm', () => {
  const d = diff(null, syntheticWorld());
  assert.equal(d.changes.length, 0);
  assert.equal(d.ratio, 0);
});

test('diff ratio is what the churn gate reads', () => {
  const before = syntheticWorld({ passports: 200, destinations: 200, status: 'visa free' });
  const after = syntheticWorld({ passports: 200, destinations: 200, status: 'visa required' });

  const d = diff(before, after);
  assert.equal(d.ratio, 1, 'everything changed');
  assert.ok(d.ratio > 0.25, 'which is exactly what the gate is meant to stop');
});
