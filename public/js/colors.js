/**
 * Assigning a colour to each held passport for the best-passport view.
 *
 * Flags are the obvious source — a German reading a German-coloured map does
 * not need a legend — but flag colours collide constantly: half the world's
 * flags are red, and two passports that look alike on the map make the view
 * useless. So a country's own colours are used when they are distinct enough
 * from everything already assigned, and a spaced fallback palette takes over
 * when they are not.
 *
 * "Distinct enough" is measured in CIELAB rather than RGB, because RGB distance
 * does not match what the eye does: #FF0000 and #00FF00 are as far apart in RGB
 * as #000000 and #0000FF, and obviously not as far apart to look at.
 */

/** Ported from the original page, which had the same idea. */
const FALLBACK = [
  '#E6194B', '#3CB44B', '#4363D8', '#F58231', '#911EB4',
  '#008080', '#F032E6', '#9A6324', '#800000', '#000075',
];

/** Below this ΔE the two colours read as "the same" on a map. */
const MIN_DISTANCE = 26;

/**
 * Brand colours have to survive being a country fill, and the extremes do not.
 *
 * Germany's flag colour is black. Used as a map fill it swallows the borders,
 * turns the hatch into grey noise, and reads as "void" rather than "Germany" —
 * and since Germany wins most destinations for anyone holding it, that is most
 * of the world. White and near-white fail the other way, disappearing into the
 * ocean. Both fall through to the country's secondary colour, then the palette.
 *
 * The band is deliberately narrow at the dark end. A deep navy like the United
 * States' #0A3161 sits at a relative luminance of about 0.031 and works fine;
 * black is 0. Only the genuinely lightless and the near-white are rejected.
 */
const USABLE_LUMINANCE = { min: 0.015, max: 0.85 };

function relativeLuminance(hex) {
  const rgb = hexToRgb(hex);
  if (!rgb) return null;
  const channel = (c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(rgb.r) + 0.7152 * channel(rgb.g) + 0.0722 * channel(rgb.b);
}

/** @returns {boolean} whether this colour works as a country fill. */
export function usableAsFill(hex) {
  const l = relativeLuminance(hex);
  return l !== null && l >= USABLE_LUMINANCE.min && l <= USABLE_LUMINANCE.max;
}

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
 * Give every passport a distinguishable colour.
 *
 * Deterministic: the same passports in the same order always produce the same
 * colours, so a shared link looks identical to whoever opens it.
 *
 * @param {string[]} passports    ISO-2, in the user's chosen order
 * @param {object} meta           countries.json
 * @returns {Record<string, string>}
 */
export function assignColors(passports, meta) {
  const assigned = {};
  const used = [];
  let fallbackIndex = 0;

  const farEnough = (hex) => used.every((taken) => distance(hex, taken) >= MIN_DISTANCE);

  for (const code of passports) {
    const brand = meta?.countries?.[code]?.brand;
    let chosen = null;

    for (const candidate of [brand?.primary, brand?.secondary]) {
      if (candidate && usableAsFill(candidate) && farEnough(candidate)) { chosen = candidate; break; }
    }

    if (!chosen) {
      // Walk the fallback palette for something distinct; if the palette is
      // exhausted take the next entry anyway rather than loop forever.
      const start = fallbackIndex;
      do {
        const candidate = FALLBACK[fallbackIndex % FALLBACK.length];
        fallbackIndex++;
        if (farEnough(candidate)) { chosen = candidate; break; }
      } while (fallbackIndex - start < FALLBACK.length);

      chosen ??= FALLBACK[fallbackIndex++ % FALLBACK.length];
    }

    assigned[code] = chosen;
    used.push(chosen);
  }

  return assigned;
}
