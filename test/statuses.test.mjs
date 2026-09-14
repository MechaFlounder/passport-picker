import test from 'node:test';
import assert from 'node:assert/strict';

import {
  STATUSES,
  STATUS_IDS,
  STATUS_BY_ID,
  rankOf,
  isStatus,
  parseStatus,
  parseStay,
  formatStay,
  UNLIMITED,
} from '../public/js/statuses.js';

test('vocabulary is internally consistent', async (t) => {
  await t.test('ranks are unique and contiguous from zero', () => {
    const ranks = STATUSES.map((s) => s.rank);
    assert.deepEqual(ranks, [...ranks].sort((a, b) => a - b), 'declared in rank order');
    assert.deepEqual(ranks, ranks.map((_, i) => i), 'contiguous from 0');
  });

  await t.test('ids are unique', () => {
    assert.equal(new Set(STATUS_IDS).size, STATUS_IDS.length);
  });

  await t.test('every status has a colour and both labels', () => {
    for (const s of STATUSES) {
      assert.match(s.color, /^#[0-9A-Fa-f]{6}$/, `${s.id} colour`);
      assert.ok(s.label && s.short, `${s.id} labels`);
    }
  });

  await t.test('unknown ranks last so bad data sinks rather than wins', () => {
    assert.equal(STATUS_BY_ID.unknown.rank, STATUSES.length - 1);
    for (const s of STATUSES) {
      if (s.id !== 'unknown') assert.ok(s.rank < STATUS_BY_ID.unknown.rank);
    }
  });

  await t.test('unrecognised ids rank last instead of throwing', () => {
    assert.equal(rankOf('not-a-status'), STATUS_BY_ID.unknown.rank);
    assert.equal(rankOf(undefined), STATUS_BY_ID.unknown.rank);
    assert.equal(isStatus('not-a-status'), false);
  });
});

test('parseStatus handles the passport-index vocabulary', () => {
  const cases = {
    'visa free': 'vf',
    'visa on arrival': 'voa',
    'eta': 'eta',
    'e-visa': 'evisa',
    'visa required': 'visa',
    'no admission': 'banned',
  };
  for (const [input, expected] of Object.entries(cases)) {
    assert.equal(parseStatus(input).status, expected, input);
  }
});

test('parseStatus reads numeric values as visa-free days', () => {
  assert.equal(parseStatus(90).status, 'vf');
  assert.equal(parseStatus('180').status, 'vf');
  assert.equal(parseStatus(-1).status, 'citizen', 'the feed marks self-travel as -1');
  assert.equal(parseStatus('-1').status, 'citizen');
});

test('regressions: values the old parser dropped into "no data"', async (t) => {
  // Each of these produced `na` in the shipped data. Counts are the number of
  // affected cells in visa-data.json as of the 2025-07-04 snapshot.
  await t.test('ESTA — 41 cells, every US visa-waiver country', () => {
    assert.equal(parseStatus('ESTA').status, 'eta');
  });

  await t.test('Mainland Travel Permit — 3 cells', () => {
    assert.equal(parseStatus('Mainland Travel Permit').status, 'permit');
  });

  await t.test('leading whitespace no longer defeats the match — 2 cells', () => {
    assert.equal(parseStatus(' Exit-Entry Permit').status, 'permit');
  });

  await t.test('trailing whitespace no longer defeats the match — 2 cells', () => {
    assert.equal(parseStatus('Visa waiver registration ').status, 'eta');
  });

  await t.test('Pre-arrival registration — 2 cells', () => {
    assert.equal(parseStatus('Pre-arrival registration').status, 'eta');
  });
});

test('parseStatus picks the easier of two named routes', () => {
  const eta = parseStatus('eTA / Visa on arrival');
  assert.equal(eta.status, 'eta', 'an online form beats a border queue');
  assert.deepEqual(eta.alternatives, ['voa'], 'the other route is still reported');

  const voa = parseStatus('Visa on arrival / eVisa');
  assert.equal(voa.status, 'voa');
  assert.deepEqual(voa.alternatives, ['evisa']);

  const vf = parseStatus('Visa not required / eVisa');
  assert.equal(vf.status, 'vf');

  // eVisitors is Australia's ETA scheme, so this pair is eTA-or-VOA.
  assert.equal(parseStatus('Visa on arrival / eVisitors').status, 'eta');
});

test('parseStatus is insensitive to case and internal spacing', () => {
  for (const v of ['Visa Required', 'VISA REQUIRED', '  visa   required  ', 'visa required.']) {
    assert.equal(parseStatus(v).status, 'visa', JSON.stringify(v));
  }
});

test('parseStatus falls back on substrings before giving up', () => {
  // Phrasings that are not in the exact table but are unmistakable.
  assert.equal(parseStatus('Electronic Travel Authorization required').status, 'eta');
  assert.equal(parseStatus('ETIAS').status, 'eta', 'the EU scheme, for when it goes live');
  assert.equal(parseStatus('Visa not required for stays under 90 days').status, 'vf');
  assert.equal(parseStatus('Online visa required (7 days)').status, 'evisa');
});

test('parseStatus reports empty input as unmatched rather than guessing', () => {
  for (const v of [null, undefined, '']) {
    const r = parseStatus(v);
    assert.equal(r.status, 'unknown');
    assert.equal(r.matched, false);
  }
  assert.equal(parseStatus('something nobody has ever written').matched, false);
});

test('parseStay distinguishes "not stated" from zero', () => {
  // The bug this exists to prevent: 780 visa-free records whose duration the
  // feed left blank were stored as 0, which lost every tie-break.
  assert.equal(parseStay(''), null, 'blank is not stated');
  assert.equal(parseStay(null), null);
  assert.equal(parseStay(0), null, 'zero days of permitted stay is not a real answer');
  assert.equal(parseStay('90 days'), 90);
  assert.equal(parseStay(90), 90);
});

test('parseStay converts units', () => {
  assert.equal(parseStay('3 months'), 90);
  assert.equal(parseStay('1 year'), 365);
  assert.equal(parseStay('2 weeks'), 14);
  assert.equal(parseStay('30 day'), 30);
});

test('parseStay survives Infinity, which JSON cannot carry', () => {
  // JSON.stringify(Infinity) is null, which is what left all 199 citizen
  // records with a null stay and made the tie-break arithmetic NaN.
  assert.equal(parseStay(Infinity), UNLIMITED);
  assert.equal(parseStay('unlimited'), UNLIMITED);
  assert.equal(JSON.parse(JSON.stringify({ s: parseStay(Infinity) })).s, UNLIMITED);
  assert.ok(Number.isFinite(UNLIMITED));
});

test('formatStay reads naturally', () => {
  assert.equal(formatStay(90), '90 days');
  assert.equal(formatStay(1), '1 day');
  assert.equal(formatStay(365), '1 year');
  assert.equal(formatStay(UNLIMITED), 'unlimited');
  assert.equal(formatStay(null), 'duration not stated');
});
