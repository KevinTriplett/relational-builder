// app-trust-tasks/challenges.ts — Postgres-backed challenge binding (S-20, S-21, S-23).
//
// Deno-free: no Deno globals (brief rule 6). All I/O goes through the
// injected `fetch` / `restUrl` / `svcHeaders` seam (DESIGN §3, P2–P4).

import type { PostgrestDeps } from "./core.ts";

/** Input to `PostgresChallengeStore.issue` (S-20). */
export interface IssueInput {
  appId: string;
  /** Bound subject (Ed25519 did:key) or undefined for a subject-agnostic challenge. */
  subject?: string;
  ttlMs: number;
}

/** A freshly issued challenge (S-20). */
export interface IssuedChallenge {
  sessionId: string;
  /** 32 random bytes, base64url, no padding (43 chars, ≥128 bits). */
  challenge: string;
  expiresAt: Date;
}

/** Outcome of the single atomic consume (S-21). */
export type LookupResult =
  | { kind: "notFound" }
  | { kind: "expired" }
  | { kind: "ok"; challenge: string; subject: string | null };

/** Construction deps for the challenge store. */
export interface ChallengeStoreDeps extends PostgrestDeps {
  now: () => Date;
  randomUUID?: () => string;
  randomBytes?: (n: number) => Uint8Array;
}

// S-23: delete challenges older than now − 1 h.
const SWEEP_GRACE_MS = 60 * 60 * 1000;

export class PostgresChallengeStore {
  private readonly fetch: typeof fetch;
  private readonly restUrl: (path: string) => string;
  private readonly svcHeaders: () => Record<string, string>;
  private readonly now: () => Date;
  private readonly randomUUID: () => string;
  private readonly randomBytes: (n: number) => Uint8Array;

  constructor(deps: ChallengeStoreDeps) {
    this.fetch = deps.fetch;
    this.restUrl = deps.restUrl;
    this.svcHeaders = deps.svcHeaders;
    this.now = deps.now;
    this.randomUUID = deps.randomUUID ?? (() => crypto.randomUUID());
    this.randomBytes = deps.randomBytes ?? ((n) => crypto.getRandomValues(new Uint8Array(n)));
  }

  // S-20: insert one row. A 409 on session_id (astronomically unlikely) retries
  // once with a fresh uuid, then throws. Any other non-2xx, or a rejected fetch, throws.
  async issue(input: IssueInput): Promise<IssuedChallenge> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const sessionId = this.randomUUID();
      const challenge = generateChallenge(this.randomBytes);
      const expiresAt = new Date(this.now().getTime() + input.ttlMs);
      const res = await this.fetch(this.restUrl("/app_tt_challenges"), {
        method: "POST",
        headers: { ...this.svcHeaders(), Prefer: "return=minimal" },
        body: JSON.stringify({
          session_id: sessionId,
          app_id: input.appId,
          subject: input.subject ?? null,
          challenge,
          expires_at: expiresAt.toISOString(),
        }),
      });
      if (res.status === 201) return { sessionId, challenge, expiresAt };
      if (res.status === 409) continue;
      throw new Error(`challenge insert failed with HTTP ${res.status}`);
    }
    throw new Error("challenge insert: session_id collision after one retry");
  }

  // S-21: one atomic PATCH that consumes the row. Zero rows → notFound; a row that
  // has passed its expiry → expired (the row stays consumed); else ok. A rejected
  // fetch or a non-2xx answer makes the call throw (the handler answers `unavailable`).
  async lookupAndConsume(input: { appId: string; sessionId: string; now: Date }): Promise<LookupResult> {
    const { appId, sessionId, now } = input;
    const url =
      this.restUrl(
        `/app_tt_challenges?session_id=eq.${encodeURIComponent(sessionId)}` +
          `&app_id=eq.${encodeURIComponent(appId)}&consumed_at=is.null`,
      );
    const res = await this.fetch(url, {
      method: "PATCH",
      headers: { ...this.svcHeaders(), Prefer: "return=representation" },
      body: JSON.stringify({ consumed_at: now.toISOString() }),
    });
    if (!res.ok) throw new Error(`challenge lookup failed with HTTP ${res.status}`);
    const rows = (await res.json()) as Array<{ challenge: string; subject: string | null; expires_at: string }>;
    if (rows.length === 0) return { kind: "notFound" };
    const r = rows[0];
    // Strictly "expires_at < now" expires; equality is still valid.
    if (Date.parse(r.expires_at) < now.getTime()) return { kind: "expired" };
    return { kind: "ok", challenge: r.challenge, subject: r.subject };
  }

  // S-23: delete expired challenges. Fire-and-forget: never throws.
  async sweep(): Promise<void> {
    try {
      const cutoff = new Date(this.now().getTime() - SWEEP_GRACE_MS).toISOString();
      await this.fetch(this.restUrl(`/app_tt_challenges?expires_at=lt.${encodeURIComponent(cutoff)}`), {
        method: "DELETE",
        headers: this.svcHeaders(),
      });
    } catch {
      // A store failure must not take down the handler that fired it.
    }
  }
}

// S-20: 32 bytes → base64url, no padding (43 chars). Portable across Node and Deno runtimes.
export function generateChallenge(randomBytes?: (n: number) => Uint8Array): string {
  const bytes = (randomBytes ?? ((n) => crypto.getRandomValues(new Uint8Array(n))))(32);
  return bytesToBase64Url(bytes);
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
