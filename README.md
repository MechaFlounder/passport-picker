# Passport Picker

Visa requirements for every passport you hold, on one map. Live at
[passportpicker.com](https://passportpicker.com), hosted on Cloudflare Pages.

There are no runtime dependencies and no bundler. The app is native ES modules,
the tests use Node's built-in runner, and the only npm command in the project is
`npx wrangler` to deploy the sync Worker.

```
npm test                  # no install step
npm run build:countries   # regenerate public/data/countries.json
npm run diff:data         # what the new pipeline changes vs the old file
```

## How the data gets here

```
  upstream dataset (passport-index, MIT)
            │
            │  weekly, Monday 03:17 UTC
            ▼
  worker/src/index.js ──── normalise ──── public/data/overrides.json
            │                                (curated, in git)
            │  sanity gate: refuses to publish
            │  a payload that looks broken
            ▼
       R2: v2/passport/<CODE>.json   one file per passport, ~4 KB
           v2/manifest.json
           v2/changes/<date>.json    what moved, every run
            │
            ▼
  functions/api/visa/[code].js   GET, edge-cached
  functions/api/meta.js          freshness, read by the page footer
```

### Why a separate Worker

Only Workers have a `scheduled()` handler. The previous version put `crons` in a
Pages `wrangler.toml` and exported `onScheduled` from a Pages Function — a
combination Pages does not support. It never ran, not once, and the site served
data from July 2025 for fourteen months without anything reporting a problem.

Two things guard against a repeat:

- **The sanity gate.** A sync that would publish fewer than 150 passports, more
  than 5% unparseable cells, or change more than a quarter of the world refuses
  to publish and says why. Serving stale data beats serving wrong data.
- **The freshness indicator.** `/api/meta` reports the age of the data and flags
  it stale past 14 days, and the page shows it. Cloudflare cron triggers
  [stop silently](https://community.cloudflare.com/t/cron-trigger-silently-stopped-dispatching/928936)
  often enough that this is monitoring, not decoration.

## Layout

| Path | What it is |
|---|---|
| `public/js/statuses.js` | The status vocabulary, ranking, and the only text parser. Imported by both the browser and the Worker. |
| `public/js/visa.js` | Resolution: rank passports against a destination, detect ties, follow territory inheritance, apply overrides. Pure functions. |
| `public/data/countries.json` | Generated. Names, ISO codes, aliases, and the territory table. |
| `public/data/overrides.json` | Hand-curated corrections. Every rule cites a source and a check date. |
| `worker/` | The sync job. |
| `functions/api/` | Read endpoints, plus a compatibility shim for the old page. |

### Statuses

`citizen · fom · vf · eta · voa · evisa · permit · visa · banned · unknown`,
ranked easiest first. Two orderings are judgement calls, both one-line edits in
`statuses.js`: `eta` beats `voa` (a web form beats a border queue that can turn
you away), and `voa` beats `evisa` (showing up beats applying in advance).

### Free-movement blocs

The upstream dataset has no freedom-of-movement concept — it reports intra-EU
travel as plain "visa free". True, but it flattens a right of residence into a
90-day tourist allowance, and taking the feed at its word would have wiped out
the ~1,100 pairs the old data did carry.

So bloc membership lives in a table in `scripts/build-countries.mjs` (EU/EEA/CH,
the Common Travel Area, Trans-Tasman, and the GCC) and is applied at *read*
time, in `resolveCell`. Two consequences worth knowing: changing the table needs
no re-sync, and the rule outranks the feed — Irish citizens come out exempt from
the UK's ETA even though the feed reports the generic rule.

CARICOM, Mercosur, the EAC and the CIS are deliberately excluded: their
arrangements are partial or cover only some nationals, and "visa free" is what
the feed already says.

### Colour in the best-passport view

Slots come from a validated categorical palette in fixed order, assigned by the
user's own passport order — not derived from flags. Flag colours were the first
design and caused the worst bug the view had: half the world's flags are red, so
holding Canada and China produced `#FF0000` and `#E6194B`, two reds nobody could
tell apart.

A map is the hardest case for categorical colour, because any two countries can
share a border and so *every* pair has to separate, not just neighbours in a
legend. Validated with the data-viz palette validator under `--pairs all`:

| Slots | Worst CVD ΔE | Worst normal-vision ΔE | |
|---|---|---|---|
| 3 | 9.2 | 24.0 | pass |
| 4 | 9.1 | 13.7 | fail — yellow against orange |
| 8 | 3.2 | 7.1 | fail |

That is the honest limit: past about three passports, no palette carries identity
by colour alone on a choropleth, and no re-ordering fixes it. Beyond three the
view leans on its secondary encodings — the tie hatch, the legend that dims
everything else on click, the hover card and the destination list — which is the
relief the method requires when separation drops into the floor band.

### Territories

Places that appear on a map but issue no passport are declared in the territory
table in `scripts/build-countries.mjs`, not hard-coded in the resolver:

- `own` — sets its own rules; the feed's data is used directly
- `inherit` — the parent's rules apply
- `special` — needs its own rule (Svalbard, Greenland, the Faroes)
- `none` — no civilian entry regime (Antarctica, uninhabited islands)

`freeMovement: false` marks a territory outside its parent's free-movement area.
This is the EU's own distinction: Réunion and Guadeloupe are outermost regions
where an EU citizen may live, while New Caledonia and Greenland are overseas
territories where the same citizen is an ordinary visitor. Without it,
inheritance would quietly promote a stay in Nouméa into a right of residence.

The old code expressed ten of these as `case` labels inside `getBestOptions()`
and had no answer for the rest, so twelve inhabited territories that *did* have
data — Aruba, Bermuda, the Caymans, Curaçao, Guadeloupe, Martinique, Montserrat,
Anguilla, Saint Martin, Sint Maarten, Turks and Caicos, the British Virgin
Islands — were never drawn.

### Boundary geometry

`POST /boundaries` on the Worker fetches Natural Earth's 1:50m admin-0
countries, resolves each feature to an ISO-2 code, rounds coordinates to three
decimals (~110 m, finer than a pixel at these zooms, and it halves the file),
and writes ~1.6 MB of GeoJSON to R2. Served `immutable`, so it downloads once.

Resolution is not by ISO code alone: Natural Earth writes `-99` into the ISO
fields for anything with contested status — France and Norway among them,
historically — so the alpha-3 route through `countries.json` does the real work,
with a name table as the last resort.

**Known gaps at 1:50m.** Eleven destinations have no feature of their own.
Eight are drawn *inside* their parent and therefore coloured correctly, because
they inherit that parent anyway: French Guiana, Guadeloupe, Martinique,
Réunion and Mayotte inside France; Tokelau inside New Zealand; the Caribbean
Netherlands inside the Netherlands; Svalbard inside Norway. Three are absent
entirely — Gibraltar, Christmas Island and the Cocos Islands — all far below one
pixel at world zoom.

The one real inaccuracy is **Svalbard**, which is visa-free to every nationality
under the 1920 treaty while Norway is not, so it takes Norway's colour instead
of its own. Fixing it means switching to Natural Earth's `map_units` set, which
splits Norway and France into their parts.

## Overrides

For anything the feed gets wrong or does not model. A rule may wildcard either
side; the most specific match wins; `effectiveFrom` keeps a known-but-not-yet-in-
force change (ETIAS) inert until its date.

The cases worth knowing about, because no visa dataset can express them:

- **Hong Kong and Macau ↔ the mainland.** Internal travel documents, not visas.
- **A US passport is not valid for North Korea.** A restriction the United States
  places on its own passports — so the feed cheerfully reports that North Korea
  issues Americans a tourist visa.

## Deploying

```bash
# once
npx wrangler r2 bucket create passport-picker-data
npx wrangler secret put SYNC_SECRET --name passport-picker-sync

cd worker && npx wrangler deploy

# first run — populates the bucket
curl -X POST -H "Authorization: Bearer $SYNC_SECRET" \
  https://passport-picker-sync.<subdomain>.workers.dev/sync

# preview a run without publishing
curl -X POST -H "Authorization: Bearer $SYNC_SECRET" \
  "https://passport-picker-sync.<subdomain>.workers.dev/sync?dry=1"
```

The Pages project needs the same `VISA_DATA_BUCKET` R2 binding so the read
endpoints can see what the Worker writes.
