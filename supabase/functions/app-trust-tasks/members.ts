// app-trust-tasks/members.ts — SPIKE STUB (Phase 1). Signatures only; DESIGN.md §2.

import type { PostgrestDeps } from "./core.ts";

/** An app_members row as this function selects it (S-47). */
export interface MemberRow {
  id: string;
  email: string | null;
  name: string | null;
  did: string | null;
}

/** S-47: return the (app_id, did) member, creating it (email null, name null) if absent; a 409 race re-reads. Throws on failure. */
export async function upsertMemberByDid(_deps: PostgrestDeps, _appId: string, _did: string): Promise<MemberRow> {
  throw new Error("not implemented");
}

/** S-47: insert one app_sessions row with token = memberTokenFactory(); returns the token. Throws on non-2xx. */
export async function mintMemberToken(
  _deps: PostgrestDeps & { memberTokenFactory: () => string },
  _input: { appId: string; memberId: string; expiresAt: Date },
): Promise<string> {
  throw new Error("not implemented");
}

/** authVerify's scheme: two randomUUID()s with dashes stripped, concatenated (64 lowercase hex). */
export function defaultMemberToken(_randomUUID?: () => string): string {
  throw new Error("not implemented");
}
