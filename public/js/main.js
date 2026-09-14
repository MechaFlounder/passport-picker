/**
 * Bootstrap and wiring.
 *
 * The single place that knows about every other module. Nothing else touches
 * the DOM outside its own element, and nothing else knows what a URL looks
 * like — which is what the old 1,388-line single file could not say about any
 * part of itself.
 */

import { STATUSES, STATUS_BY_ID, formatStay } from './statuses.js';
import { resolveAll, indexOverrides, summarise } from './visa.js';
import { createState } from './state.js';
import { assignColors, contrastingInk } from './colors.js';
import { createMap } from './map.js';
import { createPicker } from './picker.js';
import { createLegend } from './legend.js';
import { createList } from './list.js';
import { renderShareImage, offerShareImage } from './share.js';
import * as api from './api.js';

const $ = (id) => document.getElementById(id);

const el = {
  app: $('app'),
  picker: $('picker-view'),
  map: $('map-view'),
  mapContainer: $('map-container'),
  grid: $('flag-grid'),
  search: $('country-search'),
  tray: $('tray'),
  trayEmpty: $('tray-empty'),
  viewMap: $('view-map-btn'),
  back: $('back-btn'),
  share: $('share-btn'),
  toggleVisa: $('visa-view-btn'),
  toggleBest: $('best-view-btn'),
  legend: $('legend'),
  activeFlags: $('active-flags'),
  listPanel: $('list-panel'),
  listToggle: $('list-toggle'),
  list: $('list'),
  listSearch: $('list-search'),
  listSummary: $('list-summary'),
  freshness: $('freshness'),
  notice: $('notice'),
  ad: $('ad-container'),
  loader: $('loader'),
  loaderText: $('loader-text'),
};

let meta = null;
let overrides = null;
let visaData = {};
let passportColors = {};
let resolutions = new Map();
let map = null;
let picker = null;
let legend = null;
let list = null;
let loading = null;

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

let noticeTimer;
function notify(message, ms = 3200) {
  el.notice.textContent = message;
  el.notice.classList.add('is-visible');
  clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => el.notice.classList.remove('is-visible'), ms);
}

function setBusy(busy, message) {
  el.loader.hidden = !busy;
  if (message) el.loaderText.textContent = message;
}

/** Publish the status palette as CSS variables, so the stylesheet has one source. */
function publishStatusColors() {
  const root = document.documentElement.style;
  for (const status of STATUSES) root.setProperty(`--status-${status.id}`, status.color);
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function describeCountry(iso) {
  const resolution = resolutions.get(iso);
  const country = meta.countries[iso];
  const name = country?.name ?? iso;

  if (!resolution || !state.active.length) {
    return `<h3>${name}</h3><p class="popup-empty">Choose a passport to see what you need.</p>`;
  }

  if (resolution.noRegime) {
    return `<h3>${name}</h3><p class="popup-empty">${resolution.note ?? 'No entry rules apply here.'}</p>`;
  }

  const rows = resolution.options.map((option) => {
    const status = STATUS_BY_ID[option.status] ?? STATUS_BY_ID.unknown;
    const best = resolution.tied.includes(option.passport);
    const stay = option.stay != null && option.status !== 'visa' && option.status !== 'banned'
      ? `<span class="popup-stay">${formatStay(option.stay)}</span>`
      : '';

    return `
      <li class="popup-row${best ? ' is-best' : ''}">
        <span class="popup-dot" style="background:${status.color}"></span>
        <img class="popup-flag" src="https://flagcdn.com/w20/${option.passport.toLowerCase()}.png" alt="" width="20" height="15">
        <span class="popup-status">${status.label}</span>
        ${stay}
      </li>`;
  }).join('');

  const note = resolution.note ? `<p class="popup-note">${resolution.note}</p>` : '';
  return `<h3>${name}</h3><ul class="popup-rows">${rows}</ul>${note}`;
}

function renderActiveFlags() {
  el.activeFlags.textContent = '';

  for (const iso of state.selected) {
    const on = state.isActive(iso);
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `active-flag${on ? '' : ' is-off'}`;
    button.dataset.code = iso;
    button.title = `${meta.countries[iso].name} — click to ${on ? 'exclude from' : 'include in'} the map`;
    button.setAttribute('aria-pressed', String(on));

    const color = passportColors[iso];
    button.innerHTML = `
      <img src="https://flagcdn.com/w40/${iso.toLowerCase()}.png" alt="" width="40" height="30">
      ${state.view === 'best' && on && color
        ? `<span class="active-flag-key" style="background:${color};color:${contrastingInk(color)}"></span>`
        : ''}`;
    el.activeFlags.append(button);
  }
}

function renderAll() {
  if (!map || !meta) return;

  resolutions = resolveAll(state.active, visaData, meta, overrides);
  const dimmer = legend.dimmer();

  map.render(resolutions, {
    view: state.view,
    passportColors,
    isDimmed: dimmer ?? undefined,
  });

  legend.render(resolutions, {
    view: state.view,
    active: state.active,
    passportColors,
  });

  list.render(resolutions, { active: state.active });
  renderActiveFlags();

  el.toggleVisa.classList.toggle('is-active', state.view === 'visa');
  el.toggleBest.classList.toggle('is-active', state.view === 'best');
  el.toggleVisa.setAttribute('aria-pressed', String(state.view === 'visa'));
  el.toggleBest.setAttribute('aria-pressed', String(state.view === 'best'));
}

// ---------------------------------------------------------------------------
// Screens
// ---------------------------------------------------------------------------

function showScreen(screen) {
  const onMap = screen === 'map';
  if (!onMap) loadAd();
  el.picker.hidden = onMap;
  el.map.hidden = !onMap;
  el.app.dataset.screen = screen;
  if (onMap) map?.resize();
}

/** Load whatever the current selection needs, then draw. */
async function ensureData() {
  const wanted = state.selected.filter((iso) => !visaData[iso]);
  if (!wanted.length) return;

  const token = Symbol('load');
  loading = token;
  setBusy(true, 'Loading visa data…');

  try {
    const loaded = await api.loadPassports(wanted);
    // A slower earlier request must not overwrite a newer selection.
    if (loading !== token) return;
    visaData = { ...visaData, ...loaded };
  } finally {
    if (loading === token) setBusy(false);
  }
}

async function onStateChange(snapshot, reason) {
  passportColors = assignColors(snapshot.selected, meta);

  if (reason === 'selection' || reason === 'popstate' || reason === 'init') {
    picker?.sync();
  }

  showScreen(snapshot.screen);

  if (!snapshot.selected.length) {
    map?.reset();
    list?.clear();
    el.legend.textContent = '';
    el.activeFlags.textContent = '';
    return;
  }

  if (reason !== 'view') legend?.clear();

  try {
    await ensureData();
    renderAll();
  } catch (error) {
    console.error(error);
    notify(error.message ?? 'Could not load visa data.');
  }
}

const state = createState({
  isPassport: (iso) => Boolean(meta?.countries?.[iso]?.passport),
  onChange: (snapshot, reason) => { onStateChange(snapshot, reason); },
});

// ---------------------------------------------------------------------------
// Advertising
// ---------------------------------------------------------------------------

/**
 * Fill the picker's ad slot, once.
 *
 * Deliberately not called until the page is interactive: the old flow held the
 * map behind a hard-coded 3.5-second delay, apparently to give the ad time to
 * land. Loading it here instead means the ad still gets its impression on the
 * screen it lives on, and nobody waits for it.
 */
let adLoaded = false;
function loadAd() {
  if (adLoaded || !el.ad || el.ad.childElementCount) return;
  adLoaded = true;

  try {
    const ins = document.createElement('ins');
    ins.className = 'adsbygoogle';
    ins.style.display = 'block';
    ins.dataset.adClient = 'ca-pub-6081762145343306';
    ins.dataset.adSlot = '3649588436';
    ins.dataset.adFormat = 'horizontal';
    ins.dataset.fullWidthResponsive = 'true';
    el.ad.append(ins);
    (globalThis.adsbygoogle = globalThis.adsbygoogle || []).push({});
  } catch (error) {
    console.warn('[ads]', error);
    adLoaded = false;
  }
}

// ---------------------------------------------------------------------------
// Freshness
// ---------------------------------------------------------------------------

async function renderFreshness() {
  const info = await api.loadMeta();
  if (!info?.ok || !info.updated) {
    el.freshness.hidden = true;
    return;
  }

  const days = info.ageDays ?? 0;
  const when = days === 0 ? 'today' : days === 1 ? 'yesterday' : `${days} days ago`;

  el.freshness.hidden = false;
  el.freshness.classList.toggle('is-stale', Boolean(info.stale));
  el.freshness.innerHTML = info.stale
    ? `Visa data last updated ${when} — this should refresh weekly, so something has stalled.`
    : `Visa data updated ${when}.`;
}

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

async function start() {
  publishStatusColors();
  setBusy(true, 'Starting up…');

  try {
    const [countries, overridesDoc] = await Promise.all([
      api.loadCountries(),
      api.loadOverrides().catch(() => ({ rules: [] })),
    ]);

    meta = countries;
    overrides = indexOverrides(overridesDoc);

    picker = createPicker({
      grid: el.grid, search: el.search, tray: el.tray, trayEmpty: el.trayEmpty,
      meta, state, notify,
    });

    legend = createLegend({
      container: el.legend,
      meta,
      onFocus: () => renderAll(),
    });

    list = createList({
      container: el.list, search: el.listSearch, summary: el.listSummary, meta,
    });

    map = await createMap({
      container: el.mapContainer,
      boundariesUrl: api.BOUNDARIES_URL,
      describe: (iso) => describeCountry(iso),
    });

    wireControls();
    state.prime();
    renderFreshness();
  } catch (error) {
    console.error(error);
    setBusy(true, '');
    el.loaderText.innerHTML = `
      <strong>The map could not start.</strong>
      <span class="loader-detail">${error.message ?? error}</span>`;
    return;
  }

  setBusy(false);
}

function wireControls() {
  el.viewMap.addEventListener('click', () => {
    if (!state.selected.length) {
      notify('Choose at least one passport first.');
      picker.focusSearch();
      return;
    }
    state.showMap();
  });

  el.back.addEventListener('click', () => state.showPicker());
  el.toggleVisa.addEventListener('click', () => state.setView('visa'));
  el.toggleBest.addEventListener('click', () => state.setView('best'));

  el.activeFlags.addEventListener('click', (event) => {
    const button = event.target.closest('.active-flag');
    if (!button) return;
    if (state.toggleActive(button.dataset.code) === 'last') {
      notify('At least one passport has to stay on.');
    }
  });

  el.listToggle.addEventListener('click', () => {
    const open = el.listPanel.classList.toggle('is-open');
    el.listToggle.setAttribute('aria-expanded', String(open));
    if (open) el.listSearch.focus();
  });

  el.share.addEventListener('click', async () => {
    if (!map) return;
    notify('Building your map image…');
    try {
      const blob = await renderShareImage({
        mapCanvas: map.map.getCanvas(),
        passports: state.active,
        meta,
      });
      const result = await offerShareImage(blob);
      if (result === 'failed') notify('The image could not be created.');
    } catch (error) {
      console.error(error);
      notify('The image could not be created.');
    }
  });

  // This is what makes the browser's back button work — the old page had no
  // history handling at all, so back left the site.
  globalThis.addEventListener('popstate', () => state.adoptUrl());

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && state.screen === 'map') map?.resize();
  });
}

start();
