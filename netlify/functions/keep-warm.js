/**
 * Scheduled keep-warm for report-ai-v2.
 *
 * The hub's keep-warm already pings this endpoint, but having a local
 * scheduler provides redundancy and keeps this Lambda warm even if the
 * hub scheduler is temporarily broken.
 *
 * Pings the mcp-v2 endpoint with no auth — response is 401 but Lambda
 * is woken up which is all we need.
 */

export const config = {
  schedule: '*/3 * * * *',
};

export default async function handler() {
  const url = 'https://rotor-report-ai.netlify.app/.netlify/functions/mcp-v2';
  const t0 = Date.now();
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
      signal: AbortSignal.timeout(10_000),
    });
    console.log(`[keep-warm] mcp-v2 status=${res.status} ms=${Date.now() - t0}`);
  } catch (err) {
    console.log(`[keep-warm] mcp-v2 error: ${err?.message || err}`);
  }
  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}
