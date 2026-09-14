/**
 * The legend, which doubles as a filter.
 *
 * Every entry carries a count, because the count is often the answer people
 * actually came for — "how many countries can I just turn up to?" — and
 * clicking an entry dims everything else so a single category can be read off
 * the map.
 */

import { STATUSES, STATUS_BY_ID } from './statuses.js';
import { contrastingInk } from './colors.js';

/**
 * @param {object} options
 * @param {HTMLElement} options.container
 * @param {object} options.meta
 * @param {(focus: object|null) => void} options.onFocus
 */
export function createLegend({ container, meta, onFocus }) {
  /** @type {{kind: 'status'|'passport'|'tie', value: string}|null} */
  let focus = null;

  function setFocus(next) {
    const same = focus && next && focus.kind === next.kind && focus.value === next.value;
    focus = same ? null : next;
    onFocus(focus);
    paint();
  }

  function paint() {
    for (const button of container.querySelectorAll('.legend-item')) {
      const active = Boolean(focus)
        && button.dataset.kind === focus.kind
        && button.dataset.value === focus.value;
      button.classList.toggle('is-focused', active);
      button.setAttribute('aria-pressed', String(active));
    }
    container.classList.toggle('has-focus', Boolean(focus));
  }

  function item({ kind, value, label, color, count, ink }) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'legend-item';
    button.dataset.kind = kind;
    button.dataset.value = value;
    button.setAttribute('aria-pressed', 'false');
    button.innerHTML = `
      <span class="legend-swatch" style="background:${color}${ink ? `;color:${ink}` : ''}"></span>
      <span class="legend-label">${label}</span>
      <span class="legend-count">${count}</span>`;
    button.addEventListener('click', () => setFocus({ kind, value }));
    return button;
  }

  return {
    get focus() { return focus; },

    clear() {
      focus = null;
      onFocus(null);
      paint();
    },

    /**
     * @param {Map<string, object>} resolutions
     * @param {object} options
     * @param {'visa'|'best'} options.view
     * @param {string[]} options.active
     * @param {Record<string,string>} options.passportColors
     */
    render(resolutions, { view, active, passportColors }) {
      container.textContent = '';

      if (view === 'visa') {
        const counts = new Map();
        for (const r of resolutions.values()) {
          if (r.noRegime) continue;
          counts.set(r.status, (counts.get(r.status) ?? 0) + 1);
        }

        // Walk STATUSES rather than the counts, so the legend always reads in
        // rank order — easiest entry first — however the data falls.
        for (const status of STATUSES) {
          const count = counts.get(status.id);
          if (!count) continue;
          container.append(item({
            kind: 'status',
            value: status.id,
            label: status.short,
            color: status.color,
            count,
          }));
        }
      } else {
        const wins = new Map();
        let ties = 0;

        for (const r of resolutions.values()) {
          if (r.noRegime || !r.winner) continue;
          if (r.isTie) ties++;
          wins.set(r.winner, (wins.get(r.winner) ?? 0) + 1);
        }

        for (const iso of active) {
          const color = passportColors[iso] ?? STATUS_BY_ID.unknown.color;
          container.append(item({
            kind: 'passport',
            value: iso,
            label: meta.countries[iso]?.name ?? iso,
            color,
            ink: contrastingInk(color),
            count: wins.get(iso) ?? 0,
          }));
        }

        if (ties) {
          const button = item({
            kind: 'tie',
            value: 'tie',
            label: 'More than one works',
            color: 'transparent',
            count: ties,
          });
          button.querySelector('.legend-swatch').classList.add('legend-swatch-hatch');
          container.append(button);
        }
      }

      paint();
    },

    /**
     * Should this country be dimmed under the current focus?
     * Returned as a predicate so the map can apply it without knowing the rules.
     */
    dimmer() {
      if (!focus) return null;
      if (focus.kind === 'status') return (r) => r.status !== focus.value;
      if (focus.kind === 'tie') return (r) => !r.isTie;
      return (r) => r.winner !== focus.value;
    },
  };
}
