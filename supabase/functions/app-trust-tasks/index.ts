// app-trust-tasks/index.ts — Deno.serve glue only (S-51): read env, build CoreDeps once,
// route POST …/trust-tasks to handleTrustTask, map status via status.ts. The only file that
// touches Deno.*; excluded from tsconfig.functions.json and checked with `deno check`.

import { type CoreDeps, InMemoryRateLimiter, errorDocument, handleTrustTask, localVidFromSupabaseUrl } from "./core.ts";
import { CORS_HEADERS, responseHeaders } from "./status.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

const deps: CoreDeps = {
  fetch: (input, init) => fetch(input, init),
  restUrl: (p) => `${SUPABASE_URL}/rest/v1${p}`,
  svcHeaders: () => ({ apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, "Content-Type": "application/json" }),
  now: () => new Date(),
  localVid: Deno.env.get("TRUST_TASKS_LOCAL_VID") || localVidFromSupabaseUrl(SUPABASE_URL),
  rateLimiter: new InMemoryRateLimiter(),
  log: (event, detail) => console.log(event, detail ?? {}),
};

function reply(status: number, body?: unknown): Response {
  const hasBody = body !== undefined;
  return new Response(hasBody ? JSON.stringify(body) : null, { status, headers: responseHeaders(hasBody) });
}

Deno.serve(async (req: Request): Promise<Response> => {
  // SPIKE: OPTIONS answers the CORS preflight (204); binding 0.2 §2 item 1 says 405.
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: { ...CORS_HEADERS } });
  const url = new URL(req.url);
  if (!url.pathname.endsWith("/trust-tasks")) return reply(404, { error: "Not found" });
  if (req.method !== "POST") return reply(405, { error: "Method not allowed" });

  let rawBody: unknown;
  try {
    rawBody = JSON.parse(await req.text());
  } catch {
    rawBody = undefined; // unparseable → 400 malformedRequest in the core (S-41)
  }
  try {
    const appId = url.searchParams.get("app_id") ?? "";
    const appKey = url.searchParams.get("app_key") ?? "";
    const res = await handleTrustTask(deps, { appId, appKey, rawBody });
    return reply(res.status, res.body);
  } catch {
    const err = errorDocument(deps, undefined, { code: "internalError", message: "internal error", retryable: false });
    return reply(500, err);
  }
});
