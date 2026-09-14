/**
 * The destination list.
 *
 * A map answers "where can I go?" at a glance but is poor at "what exactly do I
 * need for Brazil?" — you have to find Brazil first, and on a phone that means
 * pinching around a world map. The list answers the second question directly,
 * is searchable, and is the only view that works properly with a screen reader.
 */

import { STATUSES, STATUS_BY_ID, formatStay } from './statuses.js';

/**
 * @param {object} options
 * @param {HTMLElement} options.container
 * @param {HTMLInputElement} options.search
 * @param {HTMLElement} options.summary
 * @param {object} options.meta
 */
export function createList({ container, search, summary, meta }) {
  let rows = [];
  let term = '';

  function paint() {
    const q = term.trim().toLowerCase();
    const matching = q ? rows.filter((row) => row.key.includes(q)) : rows;

    container.textContent = '';

    if (!matching.length) {
      const empty = document.createElement('p');
      empty.className = 'list-empty';
      empty.textContent = q ? `Nothing matches “${term}”.` : 'Choose a passport to see destinations.';
      container.append(empty);
      return;
    }

    // Group by status, in rank order, so the list reads best-first like the map.
    const byStatus = new Map();
    for (const row of matching) {
      if (!byStatus.has(row.status)) byStatus.set(row.status, []);
      byStatus.get(row.status).push(row);
    }

    const fragment = document.createDocumentFragment();

    for (const status of STATUSES) {
      const group = byStatus.get(status.id);
      if (!group) continue;

      const section = document.createElement('section');
      section.className = 'list-group';
      section.innerHTML = `
        <h3 class="list-group-head">
          <span class="list-swatch" style="background:${status.color}"></span>
          ${status.label}
          <span class="list-group-count">${group.length}</span>
        </h3>`;

      const table = document.createElement('ul');
      table.className = 'list-rows';

      for (const row of group) {
        const li = document.createElement('li');
        li.className = 'list-row';
        li.innerHTML = `
          <img class="list-flag" src="https://flagcdn.com/w40/${row.iso.toLowerCase()}.png"
               alt="" width="40" height="30" loading="lazy" decoding="async">
          <span class="list-name">${row.name}</span>
          <span class="list-detail">${row.detail}</span>`;
        table.append(li);
      }

      section.append(table);
      fragment.append(section);
    }

    container.append(fragment);
  }

  search?.addEventListener('input', (event) => {
    term = event.target.value;
    paint();
  });

  return {
    /**
     * @param {Map<string, object>} resolutions
     * @param {object} options
     * @param {string[]} options.active
     */
    render(resolutions, { active }) {
      rows = [];

      for (const [iso, resolution] of resolutions) {
        if (resolution.noRegime) continue;
        const country = meta.countries[iso];
        if (!country) continue;

        const status = STATUS_BY_ID[resolution.status] ?? STATUS_BY_ID.unknown;

        // Name the passport only when it actually distinguishes anything —
        // saying "on your German passport" when you hold one passport is noise.
        const viaMany = active.length > 1 && resolution.winner;
        const via = viaMany
          ? (resolution.isTie
            ? `${resolution.tied.length} of your passports`
            : meta.countries[resolution.winner]?.name ?? resolution.winner)
          : '';

        const stay = resolution.stay != null && resolution.status !== 'visa' && resolution.status !== 'banned'
          ? formatStay(resolution.stay)
          : '';

        rows.push({
          iso,
          name: country.name,
          status: resolution.status,
          detail: [stay, via].filter(Boolean).join(' · ') || status.short,
          key: `${country.name} ${country.official} ${iso} ${(country.aliases ?? []).join(' ')}`.toLowerCase(),
        });
      }

      rows.sort((a, b) => a.name.localeCompare(b.name, 'en'));

      if (summary) {
        const reachable = rows.filter((r) => ['citizen', 'fom', 'vf', 'eta'].includes(r.status)).length;
        summary.textContent = rows.length
          ? `${reachable} of ${rows.length} destinations with little or no paperwork`
          : '';
      }

      paint();
    },

    clear() {
      rows = [];
      paint();
    },
  };
}
