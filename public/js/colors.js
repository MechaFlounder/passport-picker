/**
 * Colours for the best-passport view.
 *
 * Slots are assigned in fixed order from a validated categorical palette, by the
 * user's own passport order. Deliberately *not* derived from flags, which was
 * the first design and the direct cause of the worst bug this view had: half the
 * world's flags are red, so holding Canada and China produced #FF0000 and
 * #E6194B — two reds nobody could tell apart. Flag colours are unpredictable,
 * cannot be validated ahead of time, and change meaning depending on what else
 * is selected. Identity is carried instead by the legend, the flag strip and the
 * hover card, all of which name the passport outright.
 *
 * A map is the hardest case for categorical colour: any two countries can share
 * a border, so every pair has to be separable, not just adjacent ones in a
 * legend. Validated with the data-viz palette validator under `--pairs all`:
 *
 *   3 slots  worst CVD ΔE 9.2, normal-vision 24.0   PASS
 *   4 slots  worst normal-vision ΔE 13.7            FAIL (yellow vs orange)
 *   8 slots  worst normal-vision ΔE 7.1             FAIL
 *
 * Which is the honest limit: beyond about three passports no palette can carry
 * identity by colour alone on a choropleth, and none of the re-orderings help.
 * Past that the view leans on its secondary encodings — the tie hatch, the
 * clickable legend that dims everything else, the hover card and the destination
 * list — which is exactly the relief the method requires when separation drops
 * into the floor band.
 */

/**
 * The reference categorical palette, in its validated order. The first three
 * are the strongest pairwise, so the commonest selections get the clearest map.
 */
const PALETTE = [
  '#2a78d6', // blue
  '#eb6834', // orange
  '#1baf7a', // aqua
  '#eda100', // yellow
  '#e87ba4', // magenta
  '#008300', // green
  '#4a3aa7', // violet
  '#e34948', // red
];

function hexToRgb(hex) {
  const h = String(hex).replace('#', '');
  const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
  const n = Number.parseInt(full, 16);
  return Number.isFinite(n) && full.length === 6
    ? { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 }
    : null;
}

function rgbToLab({ r, g, b }) {
  const lin = (v) => {
    const s = v / 255;
    return s > 0.04045 ? ((s + 0.055) / 1.055) ** 2.4 : s / 12.92;
  };

  const R = lin(r) * 100;
  const G = lin(g) * 100;
  const B = lin(b) * 100;

  // sRGB -> XYZ (D65)
  const x = (R * 0.4124 + G * 0.3576 + B * 0.1805) / 95.047;
  const y = (R * 0.2126 + G * 0.7152 + B * 0.0722) / 100;
  const z = (R * 0.0193 + G * 0.1192 + B * 0.9505) / 108.883;

  const f = (t) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  const fx = f(x);
  const fy = f(y);
  const fz = f(z);

  return { l: 116 * fy - 16, a: 500 * (fx - fy), b: 200 * (fy - fz) };
}

/** CIE76 ΔE — crude next to CIEDE2000, but decisive enough for "too similar?". */
export function distance(hexA, hexB) {
  const a = hexToRgb(hexA);
  const b = hexToRgb(hexB);
  if (!a || !b) return Infinity;

  const la = rgbToLab(a);
  const lb = rgbToLab(b);
  return Math.hypot(la.l - lb.l, la.a - lb.a, la.b - lb.b);
}

/** Black or white, whichever stays readable on the given background. */
export function contrastingInk(hex) {
  const rgb = hexToRgb(hex);
  if (!rgb) return '#000000';

  const channel = (c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };

  const luminance = 0.2126 * channel(rgb.r) + 0.7152 * channel(rgb.g) + 0.0722 * channel(rgb.b);
  return luminance > 0.42 ? '#111827' : '#ffffff';
}

/**
 * Give every passport a colour.
 *
 * Deterministic and position-based: the same passports in the same order always
 * produce the same colours, so a shared link looks identical to whoever opens
 * it, and reordering the tray to change a tie-break also repaints predictably.
 *
 * @param {string[]} passports ISO-2, in the user's chosen order
 * @returns {Record<string, string>}
 */
export function assignColors(passports) {
  const assigned = {};
  passports.forEach((code, index) => {
    assigned[code] = PALETTE[index % PALETTE.length];
  });
  return assigned;
}

/** The palette, for anything that needs to show or validate it. */
export const CATEGORICAL_PALETTE = [...PALETTE];

/** Past this many passports, colour alone can no longer carry identity. */
export const COLOUR_SAFE_LIMIT = 3;
