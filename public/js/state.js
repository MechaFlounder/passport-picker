/**
 * Application state, mirrored to the URL.
 *
 * The old page kept all of this in loose module-scope variables and never
 * touched the History API — not one call to `pushState`, `replaceState`,
 * `popstate` or `hashchange` in 1,388 lines. So the browser's back button left
 * the site entirely, a map could not be bookmarked or linked, and a bug report
 * could not be reproduced without a description of which flags to click.
 *
 * Putting the URL in charge fixes all three at once.
 *
 *   /                      the picker
 *   /?p=US,IE              the map, US first (order decides ties)
 *   /?p=US,IE&v=best       …in the best-passport view
 *   /?p=US,IE&off=IE       …with Ireland toggled off
 *
 * History behaviour is deliberately coarse: moving between the picker and the
 * map pushes an entry, so back goes where a person expects, while adjusting
 * passports or switching views replaces it, so back is not buried under a
 * dozen entries from toggling flags.
 */

export const MAX_PASSPORTS = 8;
export const VIEWS = ['visa', 'best'];

/** @typedef {{selected: string[], active: string[], view: string, screen: 'picker'|'map'}} Snapshot */

const clean = (code) => String(code ?? '').toUpperCase().replace(/[^A-Z]/g, '').slice(0, 2);

/**
 * Parse a URL into a snapshot. Unknown or malformed values fall back rather
 * than throwing — a hand-edited link should degrade, not produce a blank page.
 *
 * @param {string|URL} href
 * @param {(iso: string) => boolean} [isPassport] validity check
 * @returns {Snapshot}
 */
export function fromUrl(href, isPassport = () => true) {
  const url = new URL(href, 'https://passportpicker.com');
  const params = url.searchParams;

  const selected = [];
  for (const raw of (params.get('p') ?? '').split(',')) {
    const code = clean(raw);
    if (code.length === 2 && isPassport(code) && !selected.includes(code)) {
      selected.push(code);
    }
    if (selected.length >= MAX_PASSPORTS) break;
  }

  const off = new Set(
    (params.get('off') ?? '').split(',').map(clean).filter(Boolean),
  );
  // Never let a link switch every passport off: the map would have nothing to
  // say, and the UI has no way back from it.
  let active = selected.filter((code) => !off.has(code));
  if (!active.length) active = [...selected];

  const view = VIEWS.includes(params.get('v')) ? params.get('v') : 'visa';

  return {
    selected,
    active,
    view,
    screen: selected.length ? 'map' : 'picker',
  };
}

/**
 * Render a snapshot back to a query string.
 * Defaults are omitted so the common URL stays short and shareable.
 *
 * The picker is always `/`, even once passports have been chosen. That is what
 * makes Back work: choosing passports would otherwise rewrite the entry the
 * picker lives in, so pressing Back from the map would land on a URL that
 * describes the map, and the page would simply stay where it was. Selections
 * become part of the URL at the moment the map is opened.
 *
 * @param {Snapshot} snapshot
 * @returns {string} e.g. "?p=US,IE&v=best"
 */
export function toUrl(snapshot) {
  const screen = snapshot.screen ?? (snapshot.selected.length ? 'map' : 'picker');
  if (screen === 'picker' || !snapshot.selected.length) return '/';

  const params = new URLSearchParams();
  params.set('p', snapshot.selected.join(','));

  const off = snapshot.selected.filter((code) => !snapshot.active.includes(code));
  if (off.length) params.set('off', off.join(','));
  if (snapshot.view !== 'visa') params.set('v', snapshot.view);

  // URLSearchParams percent-encodes the separator, which makes a perfectly
  // readable URL look like machine output when someone pastes it somewhere.
  return `?${params.toString().replace(/%2C/g, ',')}`;
}

/**
 * The live state object.
 *
 * @param {object} options
 * @param {(iso: string) => boolean} options.isPassport
 * @param {(snapshot: Snapshot, reason: string) => void} options.onChange
 */
export function createState({ isPassport, onChange }) {
  let current = fromUrl(globalThis.location?.href ?? '/', isPassport);
  let notifying = false;

  const snapshot = () => ({
    selected: [...current.selected],
    active: [...current.active],
    view: current.view,
    screen: current.screen,
  });

  function emit(reason) {
    // Guard against a listener that changes state while handling a change.
    if (notifying) return;
    notifying = true;
    try {
      onChange(snapshot(), reason);
    } finally {
      notifying = false;
    }
  }

  function commit(reason, { push = false } = {}) {
    const url = toUrl(current);
    const history = globalThis.history;

    if (history) {
      // Only a change of screen earns a history entry. Selecting passports and
      // switching views replace it, so that one press of back leaves the map
      // rather than unwinding a dozen flag toggles.
      if (push) history.pushState(snapshot(), '', url);
      else history.replaceState(snapshot(), '', url);
    }

    emit(reason);
  }

  return {
    get selected() { return [...current.selected]; },
    get active() { return [...current.active]; },
    get view() { return current.view; },
    get screen() { return current.screen; },
    snapshot,

    /** @returns {boolean} whether the passport is selected. */
    isSelected: (code) => current.selected.includes(code),
    isActive: (code) => current.active.includes(code),

    /**
     * Add or remove a passport.
     * @returns {'added'|'removed'|'full'}
     */
    toggleSelected(code) {
      if (current.selected.includes(code)) {
        current.selected = current.selected.filter((c) => c !== code);
        current.active = current.active.filter((c) => c !== code);
        commit('selection');
        return 'removed';
      }

      if (current.selected.length >= MAX_PASSPORTS) return 'full';

      current.selected = [...current.selected, code];
      current.active = [...current.active, code];
      commit('selection');
      return 'added';
    },

    /**
     * Turn a selected passport on or off for the map without dropping it.
     * @returns {'on'|'off'|'last'} 'last' when it would have emptied the set
     */
    toggleActive(code) {
      if (!current.selected.includes(code)) return 'off';

      if (current.active.includes(code)) {
        if (current.active.length === 1) return 'last';
        current.active = current.active.filter((c) => c !== code);
      } else {
        // Keep the user's chosen order rather than append order.
        current.active = current.selected.filter(
          (c) => c === code || current.active.includes(c),
        );
      }

      commit('active');
      return current.active.includes(code) ? 'on' : 'off';
    },

    /** Reorder the selection — this is what breaks ties on the map. */
    reorder(order) {
      const next = order.filter((c) => current.selected.includes(c));
      for (const c of current.selected) if (!next.includes(c)) next.push(c);
      current.selected = next;
      current.active = next.filter((c) => current.active.includes(c));
      commit('order');
    },

    setView(view) {
      if (!VIEWS.includes(view) || view === current.view) return;
      current.view = view;
      commit('view');
    },

    /** Move to the map. Pushes history, so back returns to the picker. */
    showMap() {
      if (!current.selected.length || current.screen === 'map') return false;
      current.screen = 'map';
      commit('screen', { push: true });
      return true;
    },

    /**
     * Back to the picker, keeping the selection.
     *
     * The URL drops back to `/` because the picker is the site's front door,
     * but the selection survives in memory — a person clicking Back wants to
     * adjust their passports, not start over.
     */
    showPicker() {
      if (current.screen === 'picker') return false;
      current.screen = 'picker';
      globalThis.history?.pushState(snapshot(), '', '/');
      emit('screen');
      return true;
    },

    clear() {
      current.selected = [];
      current.active = [];
      current.screen = 'picker';
      commit('selection');
    },

    /**
     * Adopt whatever the URL now says. Wired to `popstate`, this is what makes
     * the browser's back and forward buttons work.
     */
    adoptUrl(href = globalThis.location?.href) {
      current = fromUrl(href ?? '/', isPassport);
      emit('popstate');
    },

    /** Put the initial state in the history entry so the first back works. */
    prime() {
      globalThis.history?.replaceState(snapshot(), '', toUrl(current));
      emit('init');
    },
  };
}
