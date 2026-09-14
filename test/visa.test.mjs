import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import {
  indexOverrides,
  normaliseCell,
  resolveCell,
  resolveDestination,
  resolveAll,
  summarise,
  contributionByPassport,
} from '../public/js/visa.js';
import { UNLIMITED } from '../public/js/statuses.js';

const root = path.join(import.meta.dirname, '..');
const meta = JSON.parse(fs.readFileSync(path.join(root, 'public/data/countries.json'), 'utf8'));
const overridesDoc = JSON.parse(fs.readFileSync(path.join(root, 'public/data/overrides.json'), 'utf8'));

/** Compact feed shape, as written by the sync Worker. */
const cell = (s, d = null) => ({ s, d });

/** A small hand-built world, so the unit tests do not depend on a 24 MB file. */
const DATA = {
  US: { FR: cell('vf', 90), GB: cell('eta', 180), CN: cell('visa'), JP: cell('vf', 90), KP: cell('visa'), DK: cell('vf', 90), MA: cell('vf', 90), AU: cell('eta', 90), NZ: cell('eta', 90) },
  IE: { FR: cell('fom', UNLIMITED), GB: cell('vf'), CN: cell('visa'), JP: cell('vf', 90), DK: cell('fom', UNLIMITED), MA: cell('vf', 90), AU: cell('eta', 90), NZ: cell('eta', 90) },
  DE: { FR: cell('fom', UNLIMITED), GB: cell('eta', 180), CN: cell('visa'), JP: cell('vf', 90), DK: cell('fom', UNLIMITED), MA: cell('vf', 90), AU: cell('eta', 90), NZ: cell('eta', 90) },
  CN: { FR: cell('visa'), GB: cell('visa'), JP: cell('visa'), DK: cell('visa'), MA: cell('vf', 90), AU: cell('visa'), NZ: cell('visa') },
  HK: { FR: cell('vf', 90), GB: cell('vf', 180), JP: cell('vf', 90), DK: cell('vf', 90), NZ: cell('vf', 90) },
};

const overrides = indexOverrides(overridesDoc, '2026-09-12');

// ---------------------------------------------------------------------------

test('country metadata is well formed', async (t) => {
  await t.test('every passport is also a destination', () => {
    for (const p of meta.passports) {
      assert.equal(meta.countries[p].destination, true, p);
    }
  });

  await t.test('every territory parent exists and is itself a country', () => {
    for (const c of Object.values(meta.countries)) {
      if (!c.parent) continue;
      assert.ok(meta.countries[c.parent], `${c.iso2} names a parent ${c.parent} that is not in the list`);
    }
  });

  await t.test('inheritance terminates', () => {
    for (const c of Object.values(meta.countries)) {
      const seen = new Set();
      let cur = c;
      while (cur?.parent) {
        assert.ok(!seen.has(cur.iso2), `cycle through ${cur.iso2}`);
        seen.add(cur.iso2);
        cur = meta.countries[cur.parent];
      }
    }
  });

  await t.test('the twelve territories that never rendered are present', () => {
    // These all had data in the feed but were missing from isoA3toA2, so the
    // old render loop never visited them.
    for (const iso of ['AI', 'AW', 'BM', 'KY', 'CW', 'GP', 'MQ', 'MS', 'MF', 'SX', 'TC', 'VG']) {
      assert.ok(meta.countries[iso], `${iso} missing`);
      assert.equal(meta.countries[iso].destination, true, `${iso} not renderable`);
    }
  });

  await t.test('New Caledonia is no longer mapped onto France', () => {
    assert.equal(meta.byIso3.NCL, 'NC');
    assert.equal(meta.countries.NC.iso2, 'NC');
  });
});

// ---------------------------------------------------------------------------

test('free-movement blocs survive a feed that does not model them', async (t) => {
  // The upstream dataset reports intra-EU travel as plain "visa free" and has
  // no freedom-of-movement concept at all. Without the bloc table, the whole
  // EU would flatten into the same colour as a 90-day tourist allowance.
  const feedSaysVisaFree = { DE: { ES: cell('vf', 90) }, IE: { GB: cell('eta', 180) }, AU: { NZ: cell('vf', 90) }, AE: { SA: cell('vf', 90) } };

  await t.test('EU/EEA', () => {
    const c = resolveCell('DE', 'ES', feedSaysVisaFree, meta, overrides);
    assert.equal(c.status, 'fom');
    assert.equal(c.stay, UNLIMITED);
    assert.equal(c.source, 'bloc');
  });

  await t.test('Switzerland and Norway count, despite not being EU members', () => {
    assert.equal(resolveCell('CH', 'DE', {}, meta, overrides).status, 'fom');
    assert.equal(resolveCell('NO', 'ES', {}, meta, overrides).status, 'fom');
  });

  await t.test('Common Travel Area beats the UK ETA', () => {
    // Irish citizens are the one nationality exempt from the ETA; the feed
    // reports the generic rule.
    assert.equal(feedSaysVisaFree.IE.GB.s, 'eta', 'the raw feed says eTA');
    assert.equal(resolveCell('IE', 'GB', feedSaysVisaFree, meta, overrides).status, 'fom');
  });

  await t.test('Trans-Tasman and the GCC', () => {
    assert.equal(resolveCell('AU', 'NZ', feedSaysVisaFree, meta, overrides).status, 'fom');
    assert.equal(resolveCell('AE', 'SA', feedSaysVisaFree, meta, overrides).status, 'fom');
  });

  await t.test('a bloc is not contagious', () => {
    // The UK shares the CTA with Ireland but not the EU with Germany.
    assert.notEqual(resolveCell('GB', 'DE', DATA, meta, overrides).status, 'fom');
    assert.notEqual(resolveCell('US', 'FR', DATA, meta, overrides).status, 'fom');
  });

  await t.test('every bloc member is a real country', () => {
    for (const [name, members] of Object.entries(meta.blocs)) {
      for (const iso of members) {
        assert.ok(meta.countries[iso], `bloc ${name} names ${iso}`);
        assert.ok(meta.countries[iso].blocs.includes(name), `${iso} does not list ${name}`);
      }
    }
  });
});

test('free movement stops at the edge of the free-movement area', async (t) => {
  // An EU citizen may live in Réunion, but is an ordinary visitor in Nouméa.
  // Plain inheritance would grant residence rights in both.
  await t.test('an outermost region keeps it', () => {
    assert.equal(resolveCell('DE', 'RE', DATA, meta, overrides).status, 'fom');
    assert.equal(resolveCell('DE', 'GP', DATA, meta, overrides).status, 'fom');
    assert.equal(resolveCell('DE', 'AX', DATA, meta, overrides).status, 'fom');
  });

  await t.test('an overseas territory does not', () => {
    for (const iso of ['NC', 'PF', 'WF', 'BL', 'PM']) {
      const c = resolveCell('DE', iso, DATA, meta, overrides);
      assert.equal(c.status, 'vf', `${iso} should be visa-free, not free movement`);
    }
  });

  await t.test('Greenland and the Faroes are outside the EU too', () => {
    assert.equal(resolveCell('DE', 'GL', DATA, meta, overrides).status, 'vf');
    assert.equal(resolveCell('DE', 'FO', DATA, meta, overrides).status, 'vf');
  });

  await t.test('but they stay open to people Denmark is open to', () => {
    assert.equal(resolveCell('CN', 'GL', DATA, meta, overrides).status, 'visa');
  });
});

test('resolveCell: your own country', () => {
  const c = resolveCell('US', 'US', DATA, meta, overrides);
  assert.equal(c.status, 'citizen');
  assert.equal(c.stay, UNLIMITED);
  assert.ok(Number.isFinite(c.stay), 'must survive JSON, unlike Infinity');
});

test('resolveCell: territory inheritance', async (t) => {
  await t.test('Puerto Rico follows the United States', () => {
    const c = resolveCell('DE', 'PR', DATA, meta, overrides);
    assert.equal(c.source, 'inherit');
    assert.equal(c.inheritedFrom, 'US');
  });

  await t.test('Réunion follows France', () => {
    const c = resolveCell('US', 'RE', DATA, meta, overrides);
    assert.equal(c.status, 'vf');
    assert.equal(c.inheritedFrom, 'FR');
  });

  await t.test('Western Sahara follows Morocco', () => {
    const c = resolveCell('CN', 'EH', DATA, meta, overrides);
    assert.equal(c.status, 'vf', 'Chinese passports are visa-free to Morocco');
    assert.equal(c.inheritedFrom, 'MA');
  });

  await t.test('a territory with its own data does not inherit', () => {
    const withOwn = { US: { ...DATA.US, AW: cell('vf', 30) } };
    const c = resolveCell('US', 'AW', withOwn, meta, overrides);
    assert.equal(c.source, 'feed');
    assert.equal(c.stay, 30);
  });

  await t.test('a territory with no data falls back to its parent anyway', () => {
    // CK is declared policy 'own', but the feed does not cover it. Falling back
    // beats showing "no data" on the map.
    const c = resolveCell('US', 'CK', DATA, meta, overrides);
    assert.notEqual(c.status, 'unknown');
  });
});

test('resolveCell: special territories', async (t) => {
  await t.test('Svalbard is visa-free to everyone', () => {
    for (const p of ['US', 'CN', 'IE']) {
      const c = resolveCell(p, 'SJ', DATA, meta, overrides);
      assert.equal(c.status, 'vf', p);
      assert.match(c.note, /Svalbard Treaty/);
    }
  });

  await t.test('Greenland is open to those Denmark is open to', () => {
    assert.equal(resolveCell('US', 'GL', DATA, meta, overrides).status, 'vf');
    // A German enters freely but holds no residence right: Greenland is outside
    // the EU, so the free movement they have in Denmark does not follow them.
    assert.equal(resolveCell('DE', 'GL', DATA, meta, overrides).status, 'vf');
  });

  await t.test('Greenland requires a visa from those who need one for Denmark', () => {
    const c = resolveCell('CN', 'GL', DATA, meta, overrides);
    assert.equal(c.status, 'visa');
    assert.match(c.note, /endorsed/, 'a plain Schengen visa is not enough');
  });

  await t.test('Antarctica has no entry regime at all', () => {
    const r = resolveDestination('AQ', ['US'], DATA, meta, overrides);
    assert.equal(r.noRegime, true);
    assert.equal(r.winner, null);
  });
});

test('resolveCell: overrides outrank the feed', async (t) => {
  await t.test('Hong Kong to the mainland is a permit, not a visa', () => {
    const c = resolveCell('HK', 'CN', DATA, meta, overrides);
    assert.equal(c.status, 'permit');
    assert.equal(c.source, 'override');
    assert.match(c.label, /Home Return Permit/);
  });

  await t.test('a US passport is not valid for North Korea', () => {
    // The feed says a visa is issued; the restriction is one the US places on
    // its own passports, so no visa dataset will ever carry it.
    assert.equal(DATA.US.KP.s, 'visa', 'the raw feed says visa');
    const c = resolveCell('US', 'KP', DATA, meta, overrides);
    assert.equal(c.status, 'banned');
  });

  await t.test('a rule dated in the future is inert', () => {
    assert.equal(overrides.pending, 1, 'the ETIAS placeholder is not yet in force');
    const later = indexOverrides(overridesDoc, '2030-01-01');
    assert.equal(later.pending, 0);
    assert.ok(later.applied > overrides.applied);
  });
});

// ---------------------------------------------------------------------------

test('resolveDestination: picks the best status', () => {
  const r = resolveDestination('FR', ['US', 'IE'], DATA, meta, overrides);
  assert.equal(r.status, 'fom', 'freedom of movement beats visa-free');
  assert.equal(r.winner, 'IE');
  assert.equal(r.isTie, false);
});

test('resolveDestination: ties break on the order the user chose', () => {
  const a = resolveDestination('FR', ['IE', 'DE'], DATA, meta, overrides);
  const b = resolveDestination('FR', ['DE', 'IE'], DATA, meta, overrides);

  assert.deepEqual(a.tied, ['IE', 'DE'], 'both passports are equivalent here');
  assert.equal(a.isTie, true);
  assert.equal(a.allTied, true);

  assert.equal(a.winner, 'IE', 'first in the list wins');
  assert.equal(b.winner, 'DE', 'reordering changes the winner');
  assert.deepEqual(a.tied.slice().sort(), b.tied.slice().sort(), 'but not who is tied');
});

test('resolveDestination: a partial tie is not an all-tie', () => {
  const r = resolveDestination('JP', ['US', 'IE', 'CN'], DATA, meta, overrides);
  assert.deepEqual(r.tied, ['US', 'IE'], 'both visa-free for 90 days');
  assert.equal(r.isTie, true);
  assert.equal(r.allTied, false, 'China is not equivalent');
});

test('resolveDestination: longer permitted stay wins a same-status comparison', () => {
  const r = resolveDestination('GB', ['IE', 'US'], DATA, meta, overrides);
  // IE is visa-free (rank 2) and US needs an ETA (rank 3), so IE wins on rank.
  assert.equal(r.winner, 'IE');

  // Same status, different durations: the longer stay wins.
  const data = { A: { X: cell('vf', 30) }, B: { X: cell('vf', 90) } };
  const m = { countries: { X: { iso2: 'X', policy: 'own' } }, destinations: ['X'] };
  assert.equal(resolveDestination('X', ['A', 'B'], data, m).winner, 'B');
});

test('resolveDestination: a stated duration beats an unstated one', () => {
  // The regression that motivated this: 780 visa-free records had no duration
  // in the feed and were stored as 0, which lost every comparison. They are
  // null now, and null must not be treated as zero *or* as a win.
  const data = { A: { X: cell('vf', null) }, B: { X: cell('vf', 90) } };
  const m = { countries: { X: { iso2: 'X', policy: 'own' } }, destinations: ['X'] };

  const r = resolveDestination('X', ['A', 'B'], data, m);
  assert.equal(r.winner, 'B', 'we prefer the answer we can describe');
  assert.equal(r.isTie, false, 'and it is not a tie');

  const bothUnstated = { A: { X: cell('vf', null) }, B: { X: cell('vf', null) } };
  assert.equal(resolveDestination('X', ['A', 'B'], bothUnstated, m).isTie, true);
});

test('resolveDestination: citizenship wins outright', () => {
  const r = resolveDestination('US', ['IE', 'US'], DATA, meta, overrides);
  assert.equal(r.status, 'citizen');
  assert.equal(r.winner, 'US');
  assert.equal(r.isTie, false);
});

test('resolveDestination: no passports selected is not an error', () => {
  const r = resolveDestination('FR', [], DATA, meta, overrides);
  assert.equal(r.winner, null);
  assert.equal(r.status, 'unknown');
  assert.deepEqual(r.options, []);
});

test('resolveDestination: unknown destinations degrade quietly', () => {
  const r = resolveDestination('ZZ', ['US'], DATA, meta, overrides);
  assert.equal(r.status, 'unknown');
  assert.equal(r.winner, 'US', 'still reports which passport it asked about');
});

// ---------------------------------------------------------------------------

test('normaliseCell reads every shape we ingest', async (t) => {
  await t.test('the compact shape written by the Worker', () => {
    assert.deepEqual(
      { status: normaliseCell({ s: 'vf', d: 90 }).status, stay: normaliseCell({ s: 'vf', d: 90 }).stay },
      { status: 'vf', stay: 90 },
    );
  });

  await t.test('a bare value from the upstream matrix', () => {
    assert.equal(normaliseCell(90).status, 'vf');
    assert.equal(normaliseCell(90).stay, 90);
    assert.equal(normaliseCell('visa required').status, 'visa');
  });

  await t.test('a legacy record, trusting the text over the stored status', () => {
    // This is the ESTA bug: the record says ESTA, the stored status says "na".
    const legacy = { visa: 'ESTA', status: 'na', stay_of: '90 days', stay: 90 };
    const c = normaliseCell(legacy);
    assert.equal(c.status, 'eta', 'the text is authoritative');
    assert.equal(c.stay, 90);
  });

  await t.test('a legacy record with no text falls back to the stored status', () => {
    assert.equal(normaliseCell({ status: 'vr' }).status, 'visa');
    assert.equal(normaliseCell({ status: 'ev' }).status, 'evisa');
    assert.equal(normaliseCell({ status: 'denied' }).status, 'banned');
    assert.equal(normaliseCell({ status: 'na' }).status, 'unknown');
  });

  await t.test('null and undefined', () => {
    assert.equal(normaliseCell(null).status, 'unknown');
    assert.equal(normaliseCell(undefined).status, 'unknown');
  });
});

// ---------------------------------------------------------------------------

test('resolveAll covers every renderable destination exactly once', () => {
  const all = resolveAll(['US', 'IE'], DATA, meta, overrides);
  assert.equal(all.size, meta.destinations.length);
  assert.ok(all.size > 205, 'more than the old code rendered');
  for (const iso of ['AI', 'AW', 'BM', 'KY', 'MQ', 'TC']) {
    assert.ok(all.has(iso), `${iso} should now be resolvable`);
  }
});

test('summarise counts what the legend shows', () => {
  const all = resolveAll(['US', 'IE'], DATA, meta, overrides);
  const s = summarise(all);
  assert.equal(s.total, [...all.values()].filter((r) => !r.noRegime).length);
  assert.ok(s.byStatus.citizen >= 2, 'both home countries');
  assert.equal(
    Object.values(s.byStatus).reduce((a, b) => a + b, 0),
    s.total,
    'every destination is counted exactly once',
  );
});

test('contributionByPassport answers "what is this second passport doing for me?"', () => {
  const all = resolveAll(['US', 'IE'], DATA, meta, overrides);
  const c = contributionByPassport(all, ['US', 'IE']);

  assert.ok(c.IE.sole.includes('FR'), 'only the Irish passport gives free movement in France');
  assert.ok(!c.US.sole.includes('FR'));
  assert.ok(c.US.sole.includes('US'), 'and only the US one makes you a US citizen');

  for (const p of ['US', 'IE']) {
    assert.ok(c[p].best.length >= c[p].sole.length, 'sole is a subset of best');
  }
});

// ---------------------------------------------------------------------------

test('resolution is deterministic and free of side effects', () => {
  const passports = ['DE', 'IE', 'US'];
  const before = JSON.stringify(DATA);

  const a = resolveAll(passports, DATA, meta, overrides);
  const b = resolveAll(passports, DATA, meta, overrides);

  assert.equal(JSON.stringify(DATA), before, 'input data is never mutated');
  assert.deepEqual(
    [...a.entries()].map(([k, v]) => [k, v.winner, v.status]),
    [...b.entries()].map(([k, v]) => [k, v.winner, v.status]),
  );
});
