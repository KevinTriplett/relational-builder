// app-trust-tasks/members.ts — member upsert by DID and member_token minting (S-47).
// Deno-free: all I/O through the injected PostgREST seam (DESIGN §3, P11–P13).

import type { PostgrestDeps } from "./core.ts";

/** An app_members row as this function selects it (S-47). */
export interface MemberRow {
  id: string;
  email: string | null;
  name: string | null;
  did: string | null;
}

function toMember(r: Record<string, unknown>): MemberRow {
  return {
    id: String(r.id),
    email: typeof r.email === "string" ? r.email : null,
    name: typeof r.name === "string" ? r.name : null,
    did: typeof r.did === "string" ? r.did : null,
  };
}

// P11
async function findByDid(deps: PostgrestDeps, appId: string, did: string): Promise<MemberRow | null> {
  const res = await deps.fetch(
    deps.restUrl(`/app_members?app_id=eq.${encodeURIComponent(appId)}&did=eq.${encodeURIComponent(did)}&select=id,email,name,did`),
    { headers: deps.svcHeaders() },
  );
  if (!res.ok) throw new Error(`member lookup failed with HTTP ${res.status}`);
  const rows = (await res.json()) as Array<Record<string, unknown>>;
  return Array.isArray(rows) && rows.length > 0 ? toMember(rows[0]) : null;
}

/** S-47: return the (app_id, did) member, creating it (email null, name null) if absent; a 409 race re-reads. Throws on failure. */
export async function upsertMemberByDid(deps: PostgrestDeps, appId: string, did: string): Promise<MemberRow> {
  const existing = await findByDid(deps, appId, did);
  if (existing) return existing;
  // P12
  const res = await deps.fetch(deps.restUrl("/app_members"), {
    method: "POST",
    headers: { ...deps.svcHeaders(), Prefer: "return=representation" },
    body: JSON.stringify({ app_id: appId, did, email: null, name: null }),
  });
  if (res.status === 409) {
    const raced = await findByDid(deps, appId, did);
    if (raced) return raced;
    throw new Error("member insert conflicted but no row was found");
  }
  if (!res.ok) throw new Error(`member insert failed with HTTP ${res.status}`);
  const rows = (await res.json()) as Array<Record<string, unknown>>;
  if (!Array.isArray(rows) || rows.length === 0) throw new Error("member insert returned no row");
  return toMember(rows[0]);
}

/** S-47: insert one app_sessions row with token = memberTokenFactory(); returns the token. Throws on non-2xx. */
export async function mintMemberToken(
  deps: PostgrestDeps & { memberTokenFactory: () => string },
  input: { appId: string; memberId: string; expiresAt: Date },
): Promise<string> {
  const token = deps.memberTokenFactory();
  // P13
  const res = await deps.fetch(deps.restUrl("/app_sessions"), {
    method: "POST",
    headers: { ...deps.svcHeaders(), Prefer: "return=minimal" },
    body: JSON.stringify({ token, app_id: input.appId, member_id: input.memberId, expires_at: input.expiresAt.toISOString() }),
  });
  if (!res.ok) throw new Error(`session insert failed with HTTP ${res.status}`);
  return token;
}

/** authVerify's scheme: two randomUUID()s with dashes stripped, concatenated (64 lowercase hex). */
export function defaultMemberToken(randomUUID: () => string = () => crypto.randomUUID()): string {
  return (randomUUID() + randomUUID()).replace(/-/g, "").toLowerCase();
}
