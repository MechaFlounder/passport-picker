/**
 * GET /api/meta  —  what the freshness indicator reads.
 *
 * Cloudflare cron triggers have a documented habit of stopping silently: the
 * dashboard keeps advancing "next run" while nothing fires. The previous
 * pipeline had no way to notice, which is how the site served fourteen-month-old
 * data without anyone knowing. Surfacing the age on the page turns that failure
 * into something a visitor can see, which means the owner sees it too.
 */

const STALE_AFTER_DAYS = 14;

export async function onRequestGet(context) {
  const { env } = context;

  const manifest = await env.VISA_DATA_BUCKET.get('v2/manifest.json');
  if (!manifest) {
    return json({ ok: false, error: 'no data has been published yet' }, 503, 60);
  }

  const parsed = await manifest.json();
  const updated = parsed.updated ?? null;
  const ageDays = updated
    ? Math.floor((Date.now() - Date.parse(updated)) / 86400000)
    : null;

  let changes = null;
  const latest = await env.VISA_DATA_BUCKET.get('v2/changes/latest.json');
  if (latest) {
    const c = await latest.json();
    changes = { total: c.total ?? 0, generated: c.generated ?? null };
  }

  return json({
    ok: true,
    updated,
    ageDays,
    stale: ageDays !== null && ageDays > STALE_AFTER_DAYS,
    source: parsed.source ?? null,
    passports: parsed.passports?.length ?? 0,
    overridesApplied: parsed.overridesApplied ?? 0,
    changes,
  }, 200, 300);
}

function json(body, status, maxAge) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': `public, max-age=${maxAge}, stale-while-revalidate=3600`,
    },
  });
}
