/**
 * Generates public/data/countries.json.
 *
 * Run once (and again whenever the territory table below changes):
 *   node scripts/build-countries.mjs
 *
 * Inputs are lifted from the original single-file app so the country list,
 * ISO mappings, search aliases and brand colours stay byte-identical to what
 * the live site already uses. What this script *adds* is the territory table —
 * the thing the old code handled with a hard-coded `switch` inside
 * `getBestOptions()` that silently dropped a dozen inhabited territories.
 */

import fs from 'node:fs';
import path from 'node:path';

const LEGACY_HTML = process.env.LEGACY_HTML
  ?? '/mnt/user-data/uploads/Visa Map/passport-picker-deploy/public/index.html';
const OUT = path.join(import.meta.dirname, '..', 'public', 'data', 'countries.json');

// ---------------------------------------------------------------------------
// Free-movement blocs
// ---------------------------------------------------------------------------

/**
 * Groups whose citizens hold a *right of residence* in each other's countries,
 * not merely visa-free entry.
 *
 * This has to be modelled here because the upstream dataset does not carry it:
 * it reports intra-EU travel as plain "visa free", which is true but badly
 * understates it — a German in Spain is not a tourist on a 90-day clock. The
 * old feed did carry "Freedom of movement" for 1,110 pairs, and losing that
 * would have been a visible regression, flattening the whole EU bloc into the
 * same colour as a 90-day tourist allowance.
 *
 * Membership is a legal fact that changes rarely and never silently, so a table
 * is a better home for it than a data feed.
 *
 * Deliberately excluded: CARICOM (free movement covers skilled nationals, not
 * everyone), Mercosur (a residence agreement, but entry is ordinary visa-free
 * travel), and the EAC and CIS (partial and unevenly implemented). Those are
 * visa-free, which is what the feed already says.
 */
const BLOCS = {
  // EU + EEA + Switzerland. The right to live and work, not a stay limit.
  eu: [
    'AT', 'BE', 'BG', 'HR', 'CY', 'CZ', 'DK', 'EE', 'FI', 'FR', 'DE', 'GR',
    'HU', 'IE', 'IT', 'LV', 'LT', 'LU', 'MT', 'NL', 'PL', 'PT', 'RO', 'SK',
    'SI', 'ES', 'SE', 'IS', 'LI', 'NO', 'CH',
  ],
  // Common Travel Area. Predates the EU and survived Brexit: Irish citizens are
  // the one nationality exempt from the UK's ETA, and vice versa.
  cta: ['IE', 'GB'],
  // Trans-Tasman Travel Arrangement — indefinite stay and work rights.
  tasman: ['AU', 'NZ'],
  // GCC nationals move freely between member states on an ID card.
  gcc: ['BH', 'KW', 'OM', 'QA', 'SA', 'AE'],
};

// ---------------------------------------------------------------------------
// Territory policy table
// ---------------------------------------------------------------------------

/**
 * Places that appear on a world map but are not passport-issuing states.
 *
 * `inherits` names the country whose visa policy actually applies. The old code
 * expressed a handful of these as `case` labels in `getBestOptions()` — AQ, FO,
 * GF, NC, FK, SJ, PR, VI, EH and GL — and had no answer at all for the rest, so
 * twelve inhabited territories that *did* have data in the feed were never
 * coloured, because the render loop walked `isoA3toA2` and they were not in it.
 *
 *   own       — sets its own entry rules; the feed carries real data for it
 *   inherit   — the parent's rules apply as-is
 *   special   — needs a rule of its own; see `note`
 *   none      — no civilian entry regime worth showing
 *
 * `freeMovement: false` marks a territory that sits *outside* its parent's
 * free-movement area. The distinction is the EU's own: Réunion and Guadeloupe
 * are outermost regions where an EU citizen has full residence rights, while
 * New Caledonia and Greenland are overseas countries and territories, where the
 * same citizen is an ordinary visa-free visitor. Without this, inheritance
 * would quietly promote a 90-day stay in Nouméa into a right to live there.
 */
const TERRITORIES = {
  // --- Sets its own policy; upstream data exists and should be used directly.
  AI: { name: 'Anguilla',                 iso3: 'AIA', policy: 'own', parent: 'GB' },
  AW: { name: 'Aruba',                    iso3: 'ABW', policy: 'own', parent: 'NL',
        freeMovement: false },
  BM: { name: 'Bermuda',                  iso3: 'BMU', policy: 'own', parent: 'GB' },
  KY: { name: 'Cayman Islands',           iso3: 'CYM', policy: 'own', parent: 'GB' },
  CW: { name: 'Curaçao',                  iso3: 'CUW', policy: 'own', parent: 'NL',
        freeMovement: false },
  MS: { name: 'Montserrat',               iso3: 'MSR', policy: 'own', parent: 'GB' },
  SX: { name: 'Sint Maarten',             iso3: 'SXM', policy: 'own', parent: 'NL',
        freeMovement: false },
  TC: { name: 'Turks and Caicos Islands', iso3: 'TCA', policy: 'own', parent: 'GB' },
  VG: { name: 'British Virgin Islands',   iso3: 'VGB', policy: 'own', parent: 'GB' },
  GI: { name: 'Gibraltar',                iso3: 'GIB', policy: 'own', parent: 'GB' },
  BQ: { name: 'Caribbean Netherlands',    iso3: 'BES', policy: 'own', parent: 'NL',
        freeMovement: false },
  CK: { name: 'Cook Islands',             iso3: 'COK', policy: 'own', parent: 'NZ' },
  NU: { name: 'Niue',                     iso3: 'NIU', policy: 'own', parent: 'NZ' },

  // --- Parent's policy applies unchanged.
  GP: { name: 'Guadeloupe',               iso3: 'GLP', policy: 'inherit', parent: 'FR' },
  MQ: { name: 'Martinique',               iso3: 'MTQ', policy: 'inherit', parent: 'FR' },
  MF: { name: 'Saint Martin',             iso3: 'MAF', policy: 'inherit', parent: 'FR' },
  BL: { name: 'Saint Barthélemy',         iso3: 'BLM', policy: 'inherit', parent: 'FR',
        freeMovement: false },
  RE: { name: 'Réunion',                  iso3: 'REU', policy: 'inherit', parent: 'FR' },
  YT: { name: 'Mayotte',                  iso3: 'MYT', policy: 'inherit', parent: 'FR' },
  PM: { name: 'Saint Pierre and Miquelon', iso3: 'SPM', policy: 'inherit', parent: 'FR',
        freeMovement: false },
  GF: { name: 'French Guiana',            iso3: 'GUF', policy: 'inherit', parent: 'FR' },
  AX: { name: 'Åland Islands',            iso3: 'ALA', policy: 'inherit', parent: 'FI' },
  PR: { name: 'Puerto Rico',              iso3: 'PRI', policy: 'inherit', parent: 'US' },
  VI: { name: 'U.S. Virgin Islands',      iso3: 'VIR', policy: 'inherit', parent: 'US' },
  IM: { name: 'Isle of Man',              iso3: 'IMN', policy: 'inherit', parent: 'GB',
        note: 'Part of the Common Travel Area with the UK and Ireland.' },
  JE: { name: 'Jersey',                   iso3: 'JEY', policy: 'inherit', parent: 'GB',
        note: 'Part of the Common Travel Area with the UK and Ireland.' },
  GG: { name: 'Guernsey',                 iso3: 'GGY', policy: 'inherit', parent: 'GB',
        note: 'Part of the Common Travel Area with the UK and Ireland.' },
  CX: { name: 'Christmas Island',         iso3: 'CXR', policy: 'inherit', parent: 'AU' },
  CC: { name: 'Cocos (Keeling) Islands',  iso3: 'CCK', policy: 'inherit', parent: 'AU' },
  NF: { name: 'Norfolk Island',           iso3: 'NFK', policy: 'inherit', parent: 'AU' },
  EH: { name: 'Western Sahara',           iso3: 'ESH', policy: 'inherit', parent: 'MA',
        note: 'Administered by Morocco; entry is handled under Moroccan rules.' },
  SH: { name: 'Saint Helena',             iso3: 'SHN', policy: 'inherit', parent: 'GB' },
  FK: { name: 'Falkland Islands',         iso3: 'FLK', policy: 'inherit', parent: 'GB',
        note: 'Sovereignty is disputed between the United Kingdom and Argentina.' },
  PF: { name: 'French Polynesia',         iso3: 'PYF', policy: 'inherit', parent: 'FR',
        freeMovement: false },
  WF: { name: 'Wallis and Futuna',        iso3: 'WLF', policy: 'inherit', parent: 'FR',
        freeMovement: false },
  NC: { name: 'New Caledonia',            iso3: 'NCL', policy: 'inherit', parent: 'FR',
        note: 'French collectivity; entry rules track France but are set locally.',
        freeMovement: false },
  GU: { name: 'Guam',                     iso3: 'GUM', policy: 'inherit', parent: 'US',
        note: 'A separate visa waiver covers Guam and the Northern Marianas.' },
  MP: { name: 'Northern Mariana Islands', iso3: 'MNP', policy: 'inherit', parent: 'US',
        note: 'A separate visa waiver covers Guam and the Northern Marianas.' },
  AS: { name: 'American Samoa',           iso3: 'ASM', policy: 'inherit', parent: 'US',
        note: 'Runs its own entry permit system, separate from the US visa.' },
  TK: { name: 'Tokelau',                  iso3: 'TKL', policy: 'inherit', parent: 'NZ' },

  // --- Needs its own rule.
  GL: { name: 'Greenland',                iso3: 'GRL', policy: 'special', parent: 'DK',
        note: 'Outside Schengen. Visa-free if Denmark is visa-free; otherwise a visa specifically endorsed for Greenland is required.',
        freeMovement: false },
  FO: { name: 'Faroe Islands',            iso3: 'FRO', policy: 'special', parent: 'DK',
        note: 'Outside Schengen. Visa-free if Denmark is visa-free; otherwise a visa specifically endorsed for the Faroes is required.',
        freeMovement: false },
  SJ: { name: 'Svalbard',                 iso3: 'SJM', policy: 'special', parent: 'NO',
        note: 'Visa-free for every nationality under the Svalbard Treaty — but reaching it means transiting mainland Norway, which is Schengen.' },

  // --- No civilian entry regime.
  AQ: { name: 'Antarctica',               iso3: 'ATA', policy: 'none' },
  BV: { name: 'Bouvet Island',            iso3: 'BVT', policy: 'none' },
  HM: { name: 'Heard and McDonald Islands', iso3: 'HMD', policy: 'none' },
  GS: { name: 'South Georgia',            iso3: 'SGS', policy: 'none' },
  IO: { name: 'British Indian Ocean Territory', iso3: 'IOT', policy: 'none' },
  PN: { name: 'Pitcairn Islands',         iso3: 'PCN', policy: 'none' },
  UM: { name: 'U.S. Minor Outlying Islands', iso3: 'UMI', policy: 'none' },
  TF: { name: 'French Southern Territories', iso3: 'ATF', policy: 'none' },
  EZ: { name: 'Northern Cyprus',          iso3: 'CYN', policy: 'none',
        note: 'Recognised only by Türkiye; no standard visa dataset covers it.' },
};

/**
 * Display names that differ from the feed's. The feed uses long-form official
 * names ("United States of America", "Russian Federation") which are correct
 * but read badly in a flag grid and a popup title.
 */
const SHORT_NAMES = {
  US: 'United States',
  GB: 'United Kingdom',
  RU: 'Russia',
  VN: 'Vietnam',
  KR: 'South Korea',
  KP: 'North Korea',
  CD: 'DR Congo',
  CG: 'Republic of the Congo',
  CZ: 'Czechia',
  VC: 'St. Vincent and the Grenadines',
  PS: 'Palestine',
  TR: 'Türkiye',
  CI: "Côte d'Ivoire",
  ST: 'São Tomé and Príncipe',
  TL: 'Timor-Leste',
  SZ: 'Eswatini',
  MK: 'North Macedonia',
  BN: 'Brunei',
  LA: 'Laos',
  SY: 'Syria',
  IR: 'Iran',
  MD: 'Moldova',
  TZ: 'Tanzania',
  BO: 'Bolivia',
  VE: 'Venezuela',
  VA: 'Vatican City',
  FM: 'Micronesia',
};

// ---------------------------------------------------------------------------
// Extraction from the legacy file
// ---------------------------------------------------------------------------

/** Pull a top-level `const <name> = { ... }` object literal out of the source. */
function extractObject(source, name) {
  const at = source.indexOf(`const ${name} = `);
  if (at < 0) throw new Error(`could not find "const ${name}" in the legacy file`);
  const start = source.indexOf('{', at);
  let depth = 0;
  let i = start;
  for (; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}') {
      depth--;
      if (depth === 0) { i++; break; }
    }
  }
  // These are plain data literals in a file we control; there is no untrusted
  // input here, and the alternative is hand-retyping 199 country names.
  return (0, eval)(`(${source.slice(start, i)})`);
}

const html = fs.readFileSync(LEGACY_HTML, 'utf8');
const passportList = extractObject(html, 'apiPassportList');   // name -> ISO-2
const isoA3toA2 = extractObject(html, 'isoA3toA2');            // ISO-3 -> ISO-2
const aliases = extractObject(html, 'countryAliases');         // ISO-2 -> [alias]
const palette = extractObject(html, 'countryColorPalette');    // ISO-2 -> colours

const a2toA3 = {};
for (const [a3, a2] of Object.entries(isoA3toA2)) {
  // isoA3toA2 maps New Caledonia to France, which is wrong as an ISO mapping
  // even though the visa policy does track France. The territory table carries
  // that relationship properly, so skip the bogus entries here.
  if (a3 === 'NCL' || !a2) continue;
  if (!a2toA3[a2]) a2toA3[a2] = a3;
}

// ---------------------------------------------------------------------------
// Assembly
// ---------------------------------------------------------------------------

/** @type {Record<string, object>} */
const countries = {};

/** iso2 -> the blocs it belongs to. */
const blocsOf = {};
for (const [name, members] of Object.entries(BLOCS)) {
  for (const iso2 of members) (blocsOf[iso2] ??= []).push(name);
}

for (const [officialName, iso2] of Object.entries(passportList)) {
  countries[iso2] = {
    iso2,
    iso3: a2toA3[iso2] ?? null,
    name: SHORT_NAMES[iso2] ?? officialName,
    official: officialName,
    aliases: aliases[iso2] ?? [],
    passport: true,
    destination: true,
    policy: 'own',
    parent: null,
    blocs: blocsOf[iso2] ?? [],
    freeMovement: true,
    note: null,
    brand: palette[iso2] ?? null,
  };
}

// Every bloc member must be a country we actually know about, or the rule
// silently stops applying to it.
for (const [name, members] of Object.entries(BLOCS)) {
  for (const iso2 of members) {
    if (!countries[iso2]) throw new Error(`bloc "${name}" names ${iso2}, which is not a passport`);
  }
}

for (const [iso2, t] of Object.entries(TERRITORIES)) {
  if (countries[iso2]) {
    // A passport-issuing state that also appears in the territory table would
    // be a mistake in one of the two lists; surface it rather than merge it.
    throw new Error(`${iso2} is listed both as a passport and as a territory`);
  }
  countries[iso2] = {
    iso2,
    iso3: t.iso3,
    name: t.name,
    official: t.name,
    aliases: [],
    passport: false,
    destination: t.policy !== 'none',
    policy: t.policy,
    parent: t.parent ?? null,
    blocs: [],
    // Territories inherit their parent's free-movement status unless the table
    // says otherwise — see the note on `freeMovement` above.
    freeMovement: t.freeMovement !== false,
    note: t.note ?? null,
    brand: null,
  };
}

const byIso3 = {};
for (const c of Object.values(countries)) {
  if (c.iso3) byIso3[c.iso3] = c.iso2;
}

const passports = Object.values(countries)
  .filter((c) => c.passport)
  .sort((a, b) => a.name.localeCompare(b.name, 'en'))
  .map((c) => c.iso2);

const destinations = Object.values(countries)
  .filter((c) => c.destination)
  .map((c) => c.iso2)
  .sort();

const output = {
  $comment: 'Generated by scripts/build-countries.mjs — edit that file, not this one.',
  generated: new Date().toISOString().slice(0, 10),
  blocs: BLOCS,
  countries,
  byIso3,
  passports,
  destinations,
};

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(output, null, 1));

const counts = { own: 0, inherit: 0, special: 0, none: 0 };
for (const c of Object.values(countries)) counts[c.policy]++;

console.log(`wrote ${OUT}`);
console.log(`  passports     ${passports.length}`);
console.log(`  destinations  ${destinations.length}`);
console.log(`  territories   ${Object.keys(TERRITORIES).length}`, counts);
console.log(`  iso3 mappings ${Object.keys(byIso3).length}`);
console.log(`  size          ${(fs.statSync(OUT).size / 1024).toFixed(1)} KB`);
