/**
 * Supabase Edge Function: build-day-notice — a note to the people stewarding
 * community build days when an organizer approves their build day plan for
 * its first build in Relational Builder.
 *
 * Fires from the client the moment the plan is approved (not opt-in: it
 * carries nothing identifying — the plan's Event brief lines, and the
 * locality the builder has on their profile). No builder name, no email,
 * no chat. The stewards mint the event code and set up the day-of tools by
 * hand, so this is their earliest heads-up; the organizer's own steward
 * request email follows when they send it.
 *
 * POST JSON: { projectName?, convenedBy?, where?, when?, format?, expectedSize?,
 *              entryPoint?, rhythm?, rsvp?, eventCode?, makingNow?, locality?, source? }
 *   - No auth (builders may not be signed in); per-IP rate limited
 *   - Everything is optional and truncated; a bare POST still notifies
 *
 * Deploy (Management API, see CLAUDE.md): slug build-day-notice, verify_jwt false
 * Secrets:
 *   RESEND_API_KEY           — Resend key for the relationalbuilder.org domain
 *   BUILD_DAY_NOTICE_EMAILS  — comma-separated recipients (default: humans@)
 */
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};
const DEFAULT_RECIPIENTS = ['humans@relationaltechproject.org'];
const RATE_LIMIT_PER_HOUR = 10;
const MAX_BODY_BYTES = 6_000;
const ipCounts = new Map<string, { hour: string; count: number }>();

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });
}

function clip(v: unknown, max: number): string | null {
  if (typeof v !== 'string') return null;
  const t = v.replace(/\s+/g, ' ').trim();
  return t ? t.slice(0, max) : null;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c);
}

function rateLimited(req: Request): boolean {
  const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown';
  const hour = new Date().toISOString().slice(0, 13);
  const cur = ipCounts.get(ip);
  if (!cur || cur.hour !== hour) {
    ipCounts.set(ip, { hour, count: 1 });
    return false;
  }
  cur.count += 1;
  return cur.count > RATE_LIMIT_PER_HOUR;
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);
  if (rateLimited(req)) return json({ error: 'Too many requests' }, 429);

  const raw = await req.text();
  if (raw.length > MAX_BODY_BYTES) return json({ error: 'Body too large' }, 413);
  let body: Record<string, unknown> = {};
  try {
    body = raw ? JSON.parse(raw) : {};
  } catch {
    return json({ error: 'Invalid JSON' }, 400);
  }

  const name = clip(body.projectName, 80) ?? 'A community build day';
  const rows: [string, string | null][] = [
    ['Convened by', clip(body.convenedBy, 160)],
    ['Where', clip(body.where, 160)],
    ['When', clip(body.when, 120)],
    ['Format', clip(body.format, 60)],
    ['Expected size', clip(body.expectedSize, 60)],
    ['Entry point', clip(body.entryPoint, 120)],
    ['Rhythm', clip(body.rhythm, 80)],
    ['RSVP', clip(body.rsvp, 200)],
    ['Suggested event code', clip(body.eventCode, 40)],
    ['Making now', clip(body.makingNow, 240)],
    ['Builder’s profile locality', clip(body.locality, 120)],
    ['Started from', clip(body.source, 80)],
  ];

  const resendKey = Deno.env.get('RESEND_API_KEY') ?? '';
  if (!resendKey) return json({ error: 'RESEND_API_KEY is not configured' }, 500);
  const to = (Deno.env.get('BUILD_DAY_NOTICE_EMAILS') ?? '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
  const recipients = to.length > 0 ? to : DEFAULT_RECIPIENTS;

  const where = rows[1][1] ?? rows[10][1];
  const subject = `🔨 ${name} is being planned${where ? ` — ${where}` : ''}`;
  const intro = 'An organizer just approved their community build day plan in Relational Builder and the first build (the plan, the agenda, the landing page, the flyer, the steward request) is underway. Expect their email asking for an event code; this is the heads-up.';
  const outro = 'This note carries no name or email on purpose. The organizer’s own steward request arrives at josh@relationaltechproject.org when they send it; a build report, if they opt in, arrives separately.';

  const lines = [
    intro,
    '',
    `Build day: ${name}`,
    ...rows.map(([k, v]) => `${k}: ${v ?? 'not stated'}`),
    '',
    outro,
  ];

  const html = `<div style="font-family:ui-sans-serif,system-ui,sans-serif;font-size:15px;line-height:1.5;color:#1f2a3a">
  <p style="font-size:20px;margin:0 0 12px">🔨 ${escapeHtml(name)} is being planned${where ? ` — ${escapeHtml(where)}` : ''}</p>
  <p>${escapeHtml(intro)}</p>
  <table style="border-collapse:collapse;margin:12px 0">
    ${rows.map(([k, v]) => `<tr><td style="padding:2px 12px 2px 0;color:#667;vertical-align:top">${escapeHtml(k)}</td><td>${escapeHtml(v ?? 'not stated')}</td></tr>`).join('\n    ')}
  </table>
  <p style="color:#667;font-size:13px">${escapeHtml(outro)}</p>
</div>`;

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${resendKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: 'Relational Builder <hello@relationalbuilder.org>',
      to: recipients,
      subject,
      text: lines.join('\n'),
      html,
    }),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    console.error('Resend error', res.status, detail);
    return json({ error: 'Email failed', status: res.status }, 502);
  }
  return json({ ok: true, recipients: recipients.length });
});
