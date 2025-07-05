// functions/api/mapbox-token.js
// This function securely provides the Mapbox token to the frontend.

export async function onRequestGet(context) {
  const token = context.env.MAPBOX_ACCESS_TOKEN;

  if (!token) {
    return new Response(JSON.stringify({ error: 'Mapbox token not configured' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  return new Response(JSON.stringify({ token: token }), {
    headers: { 'Content-Type': 'application/json' },
  });
}
