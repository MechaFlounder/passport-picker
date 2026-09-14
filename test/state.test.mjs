import test from 'node:test';
import assert from 'node:assert/strict';

import { fromUrl, toUrl, createState, MAX_PASSPORTS } from '../public/js/state.js';

const KNOWN = new Set(['US', 'IE', 'DE', 'GB', 'JP', 'AU', 'CA', 'SG', 'BR', 'FR']);
const isPassport = (c) => KNOWN.has(c);

/** A state object with history and location stubbed, as in a browser. */
function harness(initial = '/') {
  const entries = [{ url: initial }];
  let index = 0;
  const changes = [];

  const location = { get href() { return `https://x${entries[index].url}`; }, get search() { return entries[index].url.startsWith('?') ? entries[index].url : ''; } };
  const history = {
    pushState(_s, _t, url) { entries.splice(index + 1); entries.push({ url }); index = entries.length - 1; },
    replaceState(_s, _t, url) { entries[index] = { url }; },
    get length() { return entries.length; },
  };

  const saved = { location: globalThis.location, history: globalThis.history };
  globalThis.location = location;
  globalThis.history = history;

  const state = createState({ isPassport, onChange: (snap, reason) => changes.push({ snap, reason }) });

  return {
    state,
    changes,
    url: () => entries[index].url,
    entryCount: () => entries.length,
    back() {
      if (index > 0) index--;
      state.adoptUrl(`https://x${entries[index].url}`);
    },
    restore() { globalThis.location = saved.location; globalThis.history = saved.history; },
  };
}

// ---------------------------------------------------------------------------

test('fromUrl reads a link', () => {
  const s = fromUrl('/?p=US,IE&v=best', isPassport);
  assert.deepEqual(s.selected, ['US', 'IE']);
  assert.deepEqual(s.active, ['US', 'IE']);
  assert.equal(s.view, 'best');
  assert.equal(s.screen, 'map');
});

test('fromUrl treats a bare URL as the picker', () => {
  const s = fromUrl('/', isPassport);
  assert.deepEqual(s.selected, []);
  assert.equal(s.screen, 'picker');
  assert.equal(s.view, 'visa');
});

test('fromUrl preserves order, because order breaks ties', () => {
  assert.deepEqual(fromUrl('/?p=IE,US', isPassport).selected, ['IE', 'US']);
  assert.deepEqual(fromUrl('/?p=US,IE', isPassport).selected, ['US', 'IE']);
});

test('fromUrl is robust against a hand-edited link', async (t) => {
  await t.test('drops unknown codes', () => {
    assert.deepEqual(fromUrl('/?p=US,ZZ,IE', isPassport).selected, ['US', 'IE']);
  });

  await t.test('drops duplicates', () => {
    assert.deepEqual(fromUrl('/?p=US,US,IE', isPassport).selected, ['US', 'IE']);
  });

  await t.test('normalises case and junk characters', () => {
    assert.deepEqual(fromUrl('/?p=us,%20ie', isPassport).selected, ['US', 'IE']);
  });

  await t.test('caps the selection', () => {
    const many = fromUrl(`/?p=${[...KNOWN].join(',')}`, isPassport);
    assert.equal(many.selected.length, MAX_PASSPORTS);
  });

  await t.test('falls back on an unknown view', () => {
    assert.equal(fromUrl('/?p=US&v=nonsense', isPassport).view, 'visa');
  });

  await t.test('never leaves every passport switched off', () => {
    // Otherwise the map has nothing to show and the UI offers no way back.
    const s = fromUrl('/?p=US,IE&off=US,IE', isPassport);
    assert.deepEqual(s.active, ['US', 'IE']);
  });
});

test('toUrl round-trips', () => {
  for (const href of ['/?p=US,IE', '/?p=US,IE&v=best', '/?p=US,IE&off=IE']) {
    const there = fromUrl(href, isPassport);
    const back = fromUrl(toUrl(there), isPassport);
    assert.deepEqual(back, there, href);
  }
});

test('toUrl stays readable and omits defaults', () => {
  assert.equal(toUrl({ selected: ['US', 'IE'], active: ['US', 'IE'], view: 'visa' }), '?p=US,IE');
  assert.ok(!toUrl({ selected: ['US'], active: ['US'], view: 'visa' }).includes('%2C'));
  assert.equal(toUrl({ selected: [], active: [], view: 'visa' }), '/');
});

// ---------------------------------------------------------------------------

test('the picker stays at / while you choose', () => {
  // Selections must not rewrite the picker's own history entry, or Back from
  // the map lands on a URL that still describes the map and nothing happens.
  const h = harness();
  try {
    h.state.toggleSelected('US');
    assert.equal(h.url(), '/');
    h.state.toggleSelected('IE');
    assert.equal(h.url(), '/');
    assert.deepEqual(h.state.selected, ['US', 'IE'], 'the selection is still held');
  } finally { h.restore(); }
});

test('opening the map puts the selection in the URL', () => {
  const h = harness();
  try {
    h.state.toggleSelected('US');
    h.state.toggleSelected('IE');
    h.state.showMap();
    assert.equal(h.url(), '?p=US,IE');

    h.state.toggleSelected('US');
    assert.equal(h.url(), '?p=IE', 'and tracks changes made from the map');
  } finally { h.restore(); }
});

test('the selection is capped', () => {
  const h = harness();
  try {
    for (const c of KNOWN) h.state.toggleSelected(c);
    assert.equal(h.state.selected.length, MAX_PASSPORTS);
    assert.equal(h.state.toggleSelected('FR'), 'full');
  } finally { h.restore(); }
});

test('toggling a passport off keeps it selected', () => {
  const h = harness('/?p=US,IE');
  try {
    assert.equal(h.state.toggleActive('IE'), 'off');
    assert.deepEqual(h.state.selected, ['US', 'IE'], 'still chosen');
    assert.deepEqual(h.state.active, ['US'], 'but not counted');
    assert.equal(h.url(), '?p=US,IE&off=IE');
  } finally { h.restore(); }
});

test('the last active passport cannot be switched off', () => {
  const h = harness('/?p=US');
  try {
    assert.equal(h.state.toggleActive('US'), 'last');
    assert.deepEqual(h.state.active, ['US']);
  } finally { h.restore(); }
});

test('re-activating restores the chosen order, not click order', () => {
  const h = harness('/?p=US,IE,DE');
  try {
    h.state.toggleActive('US');
    h.state.toggleActive('US');
    assert.deepEqual(h.state.active, ['US', 'IE', 'DE']);
  } finally { h.restore(); }
});

test('reordering is what decides ties', () => {
  const h = harness('/?p=US,IE');
  try {
    h.state.reorder(['IE', 'US']);
    assert.deepEqual(h.state.selected, ['IE', 'US']);
    assert.equal(h.url(), '?p=IE,US');
  } finally { h.restore(); }
});

test('reordering ignores codes that are not selected', () => {
  const h = harness('/?p=US,IE');
  try {
    h.state.reorder(['IE', 'JP', 'US']);
    assert.deepEqual(h.state.selected, ['IE', 'US']);
  } finally { h.restore(); }
});

// ---------------------------------------------------------------------------

test('the back button returns to the picker', () => {
  // The complaint that started this: the old page never called pushState, so
  // back left the site altogether.
  const h = harness();
  try {
    h.state.toggleSelected('US');
    h.state.showMap();
    assert.equal(h.state.screen, 'map');
    assert.ok(h.entryCount() > 1, 'entering the map must add a history entry');

    h.back();
    assert.equal(h.state.screen, 'picker', 'back returns to the picker');
    assert.deepEqual(h.state.selected, [], 'and the base URL has no passports');
  } finally { h.restore(); }
});

test('adjusting passports does not bury the back button', () => {
  const h = harness();
  try {
    h.state.toggleSelected('US');
    h.state.showMap();
    const afterMap = h.entryCount();

    for (const c of ['IE', 'DE', 'GB']) h.state.toggleSelected(c);
    h.state.setView('best');
    h.state.toggleActive('IE');

    assert.equal(h.entryCount(), afterMap, 'six changes, still one press of back');
  } finally { h.restore(); }
});

test('popstate adopts whatever the URL now says', () => {
  const h = harness('/?p=US,IE&v=best');
  try {
    h.state.adoptUrl('https://x/?p=DE');
    assert.deepEqual(h.state.selected, ['DE']);
    assert.equal(h.state.view, 'visa');
    assert.equal(h.changes.at(-1).reason, 'popstate');
  } finally { h.restore(); }
});

test('listeners are told what changed', () => {
  const h = harness();
  try {
    h.state.toggleSelected('US');
    h.state.setView('best');
    assert.deepEqual(h.changes.map((c) => c.reason), ['selection', 'view']);
  } finally { h.restore(); }
});

test('a listener that changes state does not recurse', () => {
  const saved = { location: globalThis.location, history: globalThis.history };
  globalThis.location = { href: 'https://x/', search: '' };
  globalThis.history = { pushState() {}, replaceState() {} };
  try {
    let depth = 0;
    let max = 0;
    const state = createState({
      isPassport,
      onChange() {
        depth++; max = Math.max(max, depth);
        if (depth < 3) state.setView(state.view === 'visa' ? 'best' : 'visa');
        depth--;
      },
    });
    state.toggleSelected('US');
    assert.equal(max, 1, 'reentrant changes must not stack');
  } finally { globalThis.location = saved.location; globalThis.history = saved.history; }
});

test('snapshots are copies, not live references', () => {
  const h = harness('/?p=US,IE');
  try {
    const snap = h.state.snapshot();
    snap.selected.push('DE');
    assert.deepEqual(h.state.selected, ['US', 'IE'], 'mutating a snapshot must not affect state');
  } finally { h.restore(); }
});
