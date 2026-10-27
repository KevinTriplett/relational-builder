// app-trust-tasks/challenges.ts — SPIKE STUB (Phase 1). Signatures only; DESIGN.md §2.

import type { PostgrestDeps } from "./core.ts";

/** Input to PostgresChallengeStore.issue (S-20). */
export interface IssueInput {
  appId: string;
  /** Bound subject (Ed25519 did:key) or undefined for a subject-agnostic challenge. */
  subject?: string;
  ttlMs: number;
}

/** A freshly issued challenge (S-20). */
export interface IssuedChallenge {
  sessionId: string;
  /** 32 random bytes, base64url, no padding (43 chars). */
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

/** Postgres-backed challenge binding over PostgREST (`app_tt_challenges`). */
export class PostgresChallengeStore {
  constructor(_deps: ChallengeStoreDeps) {
    throw new Error("not implemented");
  }
  /** S-20: insert one row; a 409 on session_id retries once with a new id, then throws. Non-2xx/throw → throws. */
  issue(_input: IssueInput): Promise<IssuedChallenge> {
    throw new Error("not implemented");
  }
  /** S-21: one PATCH …consumed_at=is.null; zero rows → notFound, expired row → expired, else ok. Non-2xx/throw → throws. */
  lookupAndConsume(_input: { appId: string; sessionId: string; now: Date }): Promise<LookupResult> {
    throw new Error("not implemented");
  }
  /** S-23: DELETE rows whose expires_at < now − 1 h. Never throws. */
  sweep(): Promise<void> {
    throw new Error("not implemented");
  }
}

/** S-20: 32 bytes from `randomBytes` (default crypto.getRandomValues), base64url without padding. */
export function generateChallenge(_randomBytes?: (n: number) => Uint8Array): string {
  throw new Error("not implemented");
}
