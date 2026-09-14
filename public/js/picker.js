/**
 * Choosing passports, and putting them in order.
 *
 * Order is not cosmetic here: it is what decides ties on the map. Two EU
 * passports are equivalent almost everywhere, so whichever the traveller puts
 * first is the one the map shows — and dragging it changes the answer.
 */

import { MAX_PASSPORTS } from './state.js';

const flagUrl = (code, width) => `https://flagcdn.com/w${width}/${code.toLowerCase()}.png`;

/** Everything a country can be found by: name, official name, code, aliases. */
function searchKey(country) {
  return [country.name, country.official, country.iso2, ...(country.aliases ?? [])]
    .join(' ')
    .toLowerCase();
}

/**
 * @param {object} options
 * @param {HTMLElement} options.grid      where the flag buttons go
 * @param {HTMLInputElement} options.search
 * @param {HTMLElement} options.tray      the chosen-passports strip
 * @param {HTMLElement} options.trayEmpty shown while nothing is chosen
 * @param {object} options.meta           countries.json
 * @param {object} options.state
 * @param {(message: string) => void} options.notify
 */
export function createPicker({ grid, search, tray, trayEmpty, meta, state, notify }) {
  const entries = meta.passports.map((iso) => {
    const country = meta.countries[iso];
    return { iso, name: country.name, key: searchKey(country) };
  });

  // --- the grid ------------------------------------------------------------

  const buttons = new Map();
  const fragment = document.createDocumentFragment();

  for (const entry of entries) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'flag-item';
    button.dataset.code = entry.iso;
    button.setAttribute('aria-pressed', 'false');
    button.innerHTML = `
      <img src="${flagUrl(entry.iso, 80)}" alt="" width="80" height="60" loading="lazy" decoding="async">
      <span>${entry.name}</span>`;
    fragment.append(button);
    buttons.set(entry.iso, button);
  }

  grid.append(fragment);

  grid.addEventListener('click', (event) => {
    const button = event.target.closest('.flag-item');
    if (!button) return;

    const result = state.toggleSelected(button.dataset.code);
    if (result === 'full') {
      notify(`That is as many as the map can show — ${MAX_PASSPORTS} passports.`);
      tray.animate(
        [{ transform: 'translateX(0)' }, { transform: 'translateX(-6px)' }, { transform: 'translateX(6px)' }, { transform: 'translateX(0)' }],
        { duration: 300, easing: 'ease-in-out' },
      );
      return;
    }

    search.value = '';
    filter('');
    // Refocusing helps someone typing several countries in a row, but on touch
    // it drags the keyboard back over the grid they are trying to look at.
    if (event.pointerType !== 'touch') search.focus();
  });

  // --- search --------------------------------------------------------------

  function filter(term) {
    const q = term.trim().toLowerCase();
    let visible = 0;

    for (const entry of entries) {
      const match = !q || entry.key.includes(q);
      buttons.get(entry.iso).hidden = !match;
      if (match) visible++;
    }

    grid.classList.toggle('is-empty', visible === 0);
  }

  search.addEventListener('input', (event) => filter(event.target.value));

  search.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    const first = [...buttons.values()].find((b) => !b.hidden);
    first?.click();
  });

  // --- the tray ------------------------------------------------------------

  let dragging = null;

  function renderTray() {
    const selected = state.selected;
    tray.textContent = '';
    trayEmpty.hidden = selected.length > 0;

    for (const iso of selected) {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'tray-chip';
      chip.draggable = true;
      chip.dataset.code = iso;
      chip.title = `${meta.countries[iso].name} — drag to reorder, click to remove`;
      chip.innerHTML = `
        <img src="${flagUrl(iso, 40)}" alt="" width="40" height="30" draggable="false">
        <span class="tray-chip-name">${meta.countries[iso].name}</span>
        <span class="tray-chip-remove" aria-hidden="true">×</span>`;
      chip.setAttribute('aria-label', `Remove ${meta.countries[iso].name}`);
      tray.append(chip);
    }
  }

  tray.addEventListener('click', (event) => {
    const chip = event.target.closest('.tray-chip');
    if (chip) state.toggleSelected(chip.dataset.code);
  });

  // Drag to reorder. Pointer events cover mouse and touch with one code path —
  // the old page carried separate mouse and touch handlers that had drifted
  // apart.
  tray.addEventListener('dragstart', (event) => {
    const chip = event.target.closest('.tray-chip');
    if (!chip) return;
    dragging = chip;
    chip.classList.add('is-dragging');
    event.dataTransfer.effectAllowed = 'move';
    // Firefox will not start a drag without data set.
    event.dataTransfer.setData('text/plain', chip.dataset.code);
  });

  tray.addEventListener('dragend', () => {
    dragging?.classList.remove('is-dragging');
    dragging = null;
    commitOrder();
  });

  tray.addEventListener('dragover', (event) => {
    if (!dragging) return;
    event.preventDefault();

    const after = [...tray.querySelectorAll('.tray-chip:not(.is-dragging)')].find((chip) => {
      const box = chip.getBoundingClientRect();
      return event.clientX < box.left + box.width / 2;
    });

    if (after) tray.insertBefore(dragging, after);
    else tray.append(dragging);
  });

  tray.addEventListener('drop', (event) => event.preventDefault());

  function commitOrder() {
    const order = [...tray.querySelectorAll('.tray-chip')].map((chip) => chip.dataset.code);
    const current = state.selected;
    if (order.length === current.length && order.every((c, i) => c === current[i])) return;
    state.reorder(order);
  }

  // --- syncing -------------------------------------------------------------

  return {
    /** Reflect the current selection. Called on every state change. */
    sync() {
      const selected = new Set(state.selected);
      for (const [iso, button] of buttons) {
        const on = selected.has(iso);
        button.classList.toggle('is-selected', on);
        button.setAttribute('aria-pressed', String(on));
      }
      renderTray();
    },

    focusSearch: () => search.focus(),
  };
}
