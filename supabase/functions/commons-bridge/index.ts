/**
 * Supabase Edge Function: commons-bridge — the Builder's door for builders
 * who brought their own tools.
 *
 * The RT MCP server (mcp.relationaltechproject.org, repo rt-mcp-server)
 * puts the commons in front of any AI tool. This function is what it calls
 * for the parts that live in the Builder's backend rather than the commons:
 * a build day's demo wall, the live civic-data endpoints, and the shared
 * prompt seeds. It is also where the build day inbox lands: Resend posts
 * each received email here and the email becomes a wall entry.
 *
 * Nothing here needs a Builder account. The room key (event code) is the
 * credential for the wall, exactly as it is at the door.
 *
 * POST JSON (no auth, per-IP rate limited):
 *   { action: "wall", event_code }
 *     → { event: { code, name }, wall_url, entries: [...] }
 *   { action: "share", event_code, project_name, builder_name?, one_liner?,
 *     demo_url?, screenshot? (image data URL), contact_label?,
 *     contact_value?, email?, via?: "mcp" | "email" }
 *     → { ok, wall_url, entry: { id } }   (replaces the same builder's
 *       earlier card for the same project when an email was given)
 *   { action: "civic_endpoints", city? }
 *     → { endpoints: [{ slug, city, kind, mcp_url, notes }] }
 *   { action: "seeds", query?, limit? }
 *     → { seeds: [{ title, excerpt, share_slug, author_name, updated_at, url }] }
 *   { action: "seed", share_slug }
 *     → { seed: { title, body, share_slug, author_name, updated_at, url } }
 *
 * POST ?inbound=resend  (Resend webhook, Svix-signed; event email.received)
 *   The email's subject carries the event code and the project name
 *   ("BUILDJAM: Fog Line Phone Tree"; a plus-address wall+BUILDJAM@… works
 *   too). First line of the body is the one-liner, the first link is the
 *   demo, the first image attachment is the picture, the sender is the
 *   builder. A confirmation (or a plain-words "here's what was missing")
 *   goes back by email.
 *
 * Deploy: see CLAUDE.md (Management API, verify_jwt false)
 * Secrets:
 *   RESEND_API_KEY         — shared; reads received mail, sends replies
 *   RESEND_WEBHOOK_SECRET  — the receiving webhook's signing secret
 *                            (whsec_…); inbound fails closed without it
 *   SITE_URL               — optional, default https://relationalbuilder.org
 *   WALL_FROM_EMAIL        — optional reply sender, default
 *                            "Relational Builder <hello@relationalbuilder.org>"
 */

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

const RATE_LIMIT_PER_HOUR = 20;
const ipCounts = new Map<string, { hour: string; count: number }>();

const MAX_SCREENSHOT_BYTES = 4 * 1024 * 1024;
const SCREENSHOT_EXT: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });
}

function svc(): Record<string, string> {
  const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
  return { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' };
}

function rest(path: string): string {
  return `${Deno.env.get('SUPABASE_URL')}/rest/v1${path}`;
}

function siteUrl(): string {
  return (Deno.env.get('SITE_URL') ?? 'https://relationalbuilder.org').replace(/\/$/, '');
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function cap(v: unknown, max: number): string | null {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  return t ? t.slice(0, max) : null;
}

function cleanUrl(v: unknown): string | null {
  const s = cap(v, 500);
  if (!s) return null;
  try {
    const u = new URL(s);
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.toString() : null;
  } catch {
    return null;
  }
}

function cleanEmail(v: unknown): string | null {
  const s = cap(v, 200)?.toLowerCase() ?? null;
  return s && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s) ? s : null;
}

// ── Events ───────────────────────────────────────────────────────────

interface LiveEvent { code: string; name: string }

/** The event behind a room key, if the key still opens the door */
async function liveEvent(code: string): Promise<LiveEvent | null> {
  const c = code.trim().toUpperCase();
  if (!/^[A-Z0-9]{3,24}$/.test(c)) return null;
  const res = await fetch(
    rest(`/event_codes?select=code,name,active,expires_at,archived_at&code=eq.${encodeURIComponent(c)}&limit=1`),
    { headers: svc() },
  );
  if (!res.ok) return null;
  const rows = (await res.json()) as { code: string; name: string; active: boolean; expires_at: string | null; archived_at: string | null }[];
  const ev = rows[0];
  if (!ev || !ev.active || ev.archived_at) return null;
  if (ev.expires_at && new Date(ev.expires_at).getTime() < Date.now()) return null;
  return { code: ev.code, name: ev.name };
}

function wallUrl(code: string): string {
  return `${siteUrl()}/show/${encodeURIComponent(code)}`;
}

async function wallEntries(code: string): Promise<unknown[]> {
  const res = await fetch(rest('/rpc/event_showcase_for'), {
    method: 'POST',
    headers: svc(),
    body: JSON.stringify({ p_code: code }),
  });
  if (!res.ok) return [];
  const rows = (await res.json()) as Record<string, unknown>[];
  // owner_id is an account id — nothing an outside reader needs
  return rows.map(row => {
    const { owner_id, ...rest } = row;
    void owner_id;
    return rest;
  });
}

// ── Sharing to the wall ──────────────────────────────────────────────

interface ShareInput {
  eventCode: string;
  projectName: string;
  builderName: string | null;
  oneLiner: string | null;
  demoUrl: string | null;
  screenshot: { bytes: Uint8Array; mime: string } | null;
  contactLabel: string | null;
  contactValue: string | null;
  email: string | null;
  via: 'mcp' | 'email';
}

async function hostScreenshot(shot: { bytes: Uint8Array; mime: string }): Promise<string | null> {
  const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? '';
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
  const path = `event-wall/${crypto.randomUUID()}.${SCREENSHOT_EXT[shot.mime]}`;
  try {
    const up = await fetch(`${supabaseUrl}/storage/v1/object/studio-library/${path}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${serviceKey}`,
        apikey: serviceKey,
        'Content-Type': shot.mime,
        'cache-control': 'max-age=31536000, immutable',
      },
      body: shot.bytes.buffer as ArrayBuffer,
    });
    if (!up.ok) return null;
    return `${supabaseUrl}/storage/v1/object/public/studio-library/${path}`;
  } catch {
    return null;
  }
}

function decodeDataUrl(v: unknown): { bytes: Uint8Array; mime: string } | null | 'bad' {
  if (v == null || v === '') return null;
  const m = /^data:(image\/(?:png|jpeg|webp|gif));base64,(.+)$/.exec(String(v));
  if (!m) return 'bad';
  try {
    const bytes = Uint8Array.from(atob(m[2]), c => c.charCodeAt(0));
    if (bytes.length > MAX_SCREENSHOT_BYTES) return 'bad';
    return { bytes, mime: m[1] };
  } catch {
    return 'bad';
  }
}

async function shareToWall(ev: LiveEvent, input: ShareInput): Promise<{ id: string }> {
  const screenshotUrl = input.screenshot ? await hostScreenshot(input.screenshot) : null;

  // A re-sent entry replaces the earlier card (same door as Share Live:
  // delete, then insert; the partial unique index backs it up)
  if (input.email) {
    await fetch(
      rest(
        `/event_showcase?event_code=eq.${encodeURIComponent(ev.code)}` +
          `&owner_id=is.null&submitter_email=eq.${encodeURIComponent(input.email)}` +
          `&project_name=eq.${encodeURIComponent(input.projectName)}`,
      ),
      { method: 'DELETE', headers: svc() },
    );
  }

  const res = await fetch(rest('/event_showcase?select=id'), {
    method: 'POST',
    headers: { ...svc(), Prefer: 'return=representation' },
    body: JSON.stringify({
      event_code: ev.code,
      event_name: ev.name,
      owner_id: null,
      project_id: null,
      builder_name: input.builderName,
      project_name: input.projectName,
      one_liner: input.oneLiner,
      screenshot_url: screenshotUrl,
      deck_url: null,
      demo_url: input.demoUrl,
      contact_label: input.contactLabel,
      contact_value: input.contactValue,
      submitted_via: input.via,
      submitter_email: input.email,
    }),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`Could not pin to the wall (${res.status}) ${detail.slice(0, 200)}`);
  }
  const rows = (await res.json()) as { id: string }[];
  return { id: rows[0]?.id ?? '' };
}

// ── Civic data + seeds ───────────────────────────────────────────────

async function civicEndpoints(city: string | null): Promise<unknown[]> {
  const res = await fetch(rest('/rpc/public_city_data_endpoints'), {
    method: 'POST',
    headers: svc(),
    body: '{}',
  });
  if (!res.ok) return [];
  const rows = (await res.json()) as { city: string; slug: string }[];
  if (!city) return rows;
  const needle = city.toLowerCase();
  return rows.filter(r => r.city.toLowerCase().includes(needle) || r.slug.includes(needle.replace(/[^a-z0-9]+/g, '-')));
}

const SEED_COLUMNS = 'title, body, share_slug, author_name, updated_at';

function seedUrl(slug: string): string {
  return `${siteUrl()}/?prompt=${encodeURIComponent(slug)}`;
}

async function listSeeds(query: string | null, limit: number): Promise<unknown[]> {
  let path = `/prompts?select=${encodeURIComponent(SEED_COLUMNS)}&is_shared=eq.true&share_slug=not.is.null&order=updated_at.desc&limit=${limit}`;
  if (query) {
    const q = query.replace(/[%,()]/g, ' ').trim();
    if (q) path += `&or=(title.ilike.*${encodeURIComponent(q)}*,body.ilike.*${encodeURIComponent(q)}*)`;
  }
  const res = await fetch(rest(path), { headers: svc() });
  if (!res.ok) return [];
  const rows = (await res.json()) as { title: string; body: string; share_slug: string; author_name: string | null; updated_at: string }[];
  return rows.map(r => ({
    title: r.title,
    excerpt: r.body.length > 400 ? `${r.body.slice(0, 400).trimEnd()}…` : r.body,
    share_slug: r.share_slug,
    author_name: r.author_name,
    updated_at: r.updated_at,
    url: seedUrl(r.share_slug),
  }));
}

async function getSeed(slug: string): Promise<unknown | null> {
  const res = await fetch(
    rest(`/prompts?select=${encodeURIComponent(SEED_COLUMNS)}&is_shared=eq.true&share_slug=eq.${encodeURIComponent(slug)}&limit=1`),
    { headers: svc() },
  );
  if (!res.ok) return null;
  const rows = (await res.json()) as { share_slug: string }[];
  return rows[0] ? { ...rows[0], url: seedUrl(rows[0].share_slug) } : null;
}

// ── The build day inbox (Resend → here) ──────────────────────────────

/** Svix signature check, the scheme Resend signs webhooks with: HMAC-SHA256
 *  over `${id}.${timestamp}.${body}` keyed by the base64 secret after
 *  `whsec_`, compared against each `v1,<sig>` in the header. */
async function verifySvix(req: Request, rawBody: string, secret: string): Promise<boolean> {
  const id = req.headers.get('svix-id') ?? '';
  const ts = req.headers.get('svix-timestamp') ?? '';
  const sigHeader = req.headers.get('svix-signature') ?? '';
  if (!id || !ts || !sigHeader) return false;
  const age = Math.abs(Date.now() / 1000 - Number(ts));
  if (!Number.isFinite(age) || age > 5 * 60) return false;
  const keyBytes = Uint8Array.from(atob(secret.replace(/^whsec_/, '')), c => c.charCodeAt(0));
  const key = await crypto.subtle.importKey('raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${id}.${ts}.${rawBody}`));
  const expected = btoa(String.fromCharCode(...new Uint8Array(mac)));
  return sigHeader.split(' ').some(part => {
    const [version, sig] = part.split(',');
    return version === 'v1' && sig === expected;
  });
}

interface ReceivedEmail {
  from: string;
  subject: string;
  text: string;
  to: string[];
  attachments: { id: string; content_type: string; size?: number }[];
}

async function fetchReceivedEmail(emailId: string, resendKey: string): Promise<ReceivedEmail | null> {
  const res = await fetch(`https://api.resend.com/emails/receiving/${encodeURIComponent(emailId)}`, {
    headers: { Authorization: `Bearer ${resendKey}` },
  });
  if (!res.ok) return null;
  const e = (await res.json()) as Record<string, unknown>;
  const text = typeof e.text === 'string' && e.text.trim()
    ? e.text
    : typeof e.html === 'string'
      ? e.html.replace(/<style[\s\S]*?<\/style>/gi, '').replace(/<br\s*\/?>/gi, '\n').replace(/<\/p>/gi, '\n').replace(/<[^>]+>/g, '')
      : '';
  return {
    from: String(e.from ?? ''),
    subject: String(e.subject ?? ''),
    text,
    to: Array.isArray(e.to) ? e.to.map(String) : [],
    attachments: Array.isArray(e.attachments) ? (e.attachments as ReceivedEmail['attachments']) : [],
  };
}

async function fetchFirstImage(emailId: string, resendKey: string): Promise<{ bytes: Uint8Array; mime: string } | null> {
  const res = await fetch(`https://api.resend.com/emails/receiving/${encodeURIComponent(emailId)}/attachments`, {
    headers: { Authorization: `Bearer ${resendKey}` },
  });
  if (!res.ok) return null;
  const list = (await res.json()) as { data?: { content_type: string; download_url: string; size?: number }[] };
  const pick = (list.data ?? []).find(a => SCREENSHOT_EXT[a.content_type] && (a.size ?? 0) <= MAX_SCREENSHOT_BYTES);
  if (!pick) return null;
  const dl = await fetch(pick.download_url);
  if (!dl.ok) return null;
  const bytes = new Uint8Array(await dl.arrayBuffer());
  if (bytes.length > MAX_SCREENSHOT_BYTES) return null;
  return { bytes, mime: pick.content_type };
}

function parseFrom(from: string): { name: string | null; email: string | null } {
  const m = /^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/.exec(from);
  if (m) return { name: m[1].trim() || null, email: cleanEmail(m[2]) };
  return { name: null, email: cleanEmail(from) };
}

/** Candidate room keys in the order a person would put them: a plus
 *  address, then the subject, then the body's first lines. */
function codeCandidates(email: ReceivedEmail): string[] {
  const out: string[] = [];
  for (const addr of email.to) {
    const m = /\+([A-Za-z0-9]{3,24})@/.exec(addr);
    if (m) out.push(m[1].toUpperCase());
  }
  const pool = `${email.subject}\n${email.text.slice(0, 600)}`;
  for (const m of pool.matchAll(/\b([A-Z][A-Z0-9]{2,23})\b/g)) out.push(m[1]);
  return [...new Set(out)];
}

function stripCode(s: string, code: string): string {
  return s
    .replace(new RegExp(`\\b${code}\\b`, 'i'), '')
    .replace(/^\s*[:\-–—|]+\s*/, '')
    .replace(/\s*[:\-–—|]+\s*$/, '')
    .replace(/^\s*(re|fwd?):\s*/i, '')
    .trim();
}

async function sendMail(to: string, subject: string, html: string): Promise<void> {
  const resendKey = Deno.env.get('RESEND_API_KEY') ?? '';
  if (!resendKey) return;
  await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${resendKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: Deno.env.get('WALL_FROM_EMAIL') ?? 'Relational Builder <hello@relationalbuilder.org>',
      to: [to],
      subject,
      html,
    }),
  }).catch(() => {});
}

async function handleInbound(req: Request): Promise<Response> {
  const secret = Deno.env.get('RESEND_WEBHOOK_SECRET') ?? '';
  const resendKey = Deno.env.get('RESEND_API_KEY') ?? '';
  if (!secret || !resendKey) return json({ error: 'Inbox not configured' }, 503);
  const raw = await req.text();
  if (!(await verifySvix(req, raw, secret))) return json({ error: 'Bad signature' }, 401);

  let payload: { type?: string; data?: { email_id?: string } } = {};
  try {
    payload = JSON.parse(raw);
  } catch {
    return json({ error: 'Bad payload' }, 400);
  }
  // Other event types (delivered, bounced…) are acknowledged, not acted on
  if (payload.type !== 'email.received' || !payload.data?.email_id) return json({ ok: true, ignored: true });

  const email = await fetchReceivedEmail(payload.data.email_id, resendKey);
  if (!email) return json({ error: 'Could not read the email' }, 502);
  const sender = parseFrom(email.from);
  if (!sender.email) return json({ ok: true, ignored: 'no sender' });

  // Which room?
  let ev: LiveEvent | null = null;
  let code = '';
  for (const c of codeCandidates(email)) {
    ev = await liveEvent(c);
    if (ev) { code = c; break; }
  }
  if (!ev) {
    await sendMail(
      sender.email,
      "Which build day is this for?",
      `<p>Thanks for sending your build. We couldn't find a live event code in your email, so it isn't on a wall yet.</p>
<p>Reply with the room's code in the subject line, like <strong>BUILDJAM: ${esc(email.subject || 'Your project name')}</strong>. The code is on the slide and the QR card at your build day.</p>
<p>Everything else is optional: a one-line description as the first line, a link to your live tool, and a screenshot attached.</p>`,
    );
    return json({ ok: true, replied: 'no_code' });
  }

  const lines = email.text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  const projectName = cap(stripCode(email.subject, code), 120) ?? 'Untitled build';
  const urlMatch = /https?:\/\/[^\s<>"')\]]+/.exec(email.text);
  const demoUrl = urlMatch ? cleanUrl(urlMatch[0]) : null;
  const oneLiner = cap(lines.find(l => !/^https?:\/\//.test(l) && !/^(>|--|on .* wrote:)/i.test(l)) ?? '', 200);
  const screenshot = email.attachments.length ? await fetchFirstImage(payload.data.email_id, resendKey) : null;

  try {
    await shareToWall(ev, {
      eventCode: ev.code,
      projectName,
      builderName: sender.name,
      oneLiner,
      demoUrl,
      screenshot,
      contactLabel: null,
      contactValue: null,
      email: sender.email,
      via: 'email',
    });
  } catch (err) {
    await sendMail(
      sender.email,
      `Couldn't pin "${projectName}" to the wall`,
      `<p>Something went wrong on our side pinning your build to the ${esc(ev.name)} wall. Please try once more in a minute, or show it to a host in the room.</p>`,
    );
    return json({ error: err instanceof Error ? err.message : 'share failed' }, 500);
  }

  const missing: string[] = [];
  if (!demoUrl) missing.push('a link to your live tool');
  if (!screenshot) missing.push('a screenshot attached');
  await sendMail(
    sender.email,
    `"${projectName}" is on the ${ev.name} wall`,
    `<p><strong>${esc(projectName)}</strong> is pinned to the <a href="${wallUrl(ev.code)}">${esc(ev.name)} wall</a>${sender.name ? `, credited to ${esc(sender.name)}` : ''}.</p>
${missing.length ? `<p>To fill in the card, send the same subject line again with ${esc(missing.join(' and '))} — the new email replaces the old card.</p>` : ''}
<p>If you'd like your build to live on past today, the commons would love it: ask your AI to help you contribute it through the Relational Tech MCP server, or write to humans@relationaltechproject.org.</p>`,
  );
  return json({ ok: true, entry_for: ev.code });
}

// ── Router ───────────────────────────────────────────────────────────

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  const url = new URL(req.url);
  if (url.searchParams.get('inbound') === 'resend') {
    try {
      return await handleInbound(req);
    } catch (err) {
      return json({ error: err instanceof Error ? err.message : 'inbound failed' }, 500);
    }
  }

  try {
    const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown';
    const hour = new Date().toISOString().slice(0, 13);
    const bucket = ipCounts.get(ip);
    if (bucket && bucket.hour === hour && bucket.count >= RATE_LIMIT_PER_HOUR) {
      return json({ error: 'Too many requests — try again in a bit' }, 429);
    }
    ipCounts.set(ip, { hour, count: bucket?.hour === hour ? bucket.count + 1 : 1 });

    const body = await req.json().catch(() => ({}));
    const action = String(body.action ?? '');

    if (action === 'civic_endpoints') {
      return json({ endpoints: await civicEndpoints(cap(body.city, 80)) });
    }

    if (action === 'seeds') {
      const limit = Math.min(Math.max(Number(body.limit) || 12, 1), 40);
      return json({ seeds: await listSeeds(cap(body.query, 200), limit) });
    }

    if (action === 'seed') {
      const slug = cap(body.share_slug, 80);
      if (!slug) return json({ error: 'share_slug is required' }, 400);
      const seed = await getSeed(slug);
      return seed ? json({ seed }) : json({ error: 'No shared prompt with that slug' }, 404);
    }

    if (action === 'wall' || action === 'share') {
      const code = cap(body.event_code, 24) ?? '';
      const ev = await liveEvent(code);
      if (!ev) return json({ error: 'That event code is not live. Check the code on the room\'s slide or QR card.' }, 404);

      if (action === 'wall') {
        return json({ event: { code: ev.code, name: ev.name }, wall_url: wallUrl(ev.code), entries: await wallEntries(ev.code) });
      }

      const projectName = cap(body.project_name, 120);
      if (!projectName) return json({ error: 'project_name is required' }, 400);
      const screenshot = decodeDataUrl(body.screenshot);
      if (screenshot === 'bad') return json({ error: 'screenshot must be a png/jpeg/webp/gif data URL under 4MB' }, 400);
      const via = body.via === 'email' ? 'email' : 'mcp';
      const entry = await shareToWall(ev, {
        eventCode: ev.code,
        projectName,
        builderName: cap(body.builder_name, 120),
        oneLiner: cap(body.one_liner, 200),
        demoUrl: cleanUrl(body.demo_url),
        screenshot,
        contactLabel: cap(body.contact_label, 40),
        contactValue: cap(body.contact_value, 200),
        email: cleanEmail(body.email),
        via,
      });
      return json({ ok: true, event: { code: ev.code, name: ev.name }, wall_url: wallUrl(ev.code), entry });
    }

    return json({ error: 'Unknown action' }, 400);
  } catch (err) {
    return json({ error: err instanceof Error ? err.message : 'Request failed' }, 500);
  }
});
