// app-trust-tasks/replay.ts — SPIKE STUB (Phase 1). Signatures only; DESIGN.md §2.

import {
  DEFAULT_SKEW_MS,
  type ReplayGuard,
  type ReplayVerdict,
} from "npm:@openvtc/trust-tasks@0.26.29";
import type { PostgrestDeps } from "./core.ts";

/** Default padding added to the runtime's retainUntil (S-22: recordExpiry omits skewMs). */
export const DEFAULT_RETENTION_PAD_MS: number = DEFAULT_SKEW_MS;

/** Construction deps; one guard per request, scoped to the authenticated app (S-24). */
export interface ReplayGuardDeps extends PostgrestDeps {
  appId: string;
  /** Added to retainUntil before it is stored as until_at. Default DEFAULT_RETENTION_PAD_MS. */
  retentionPadMs?: number;
}

/** S-22/S-24: ReplayGuard over PostgREST (`app_tt_replay`), keyed on document id, app-scoped. */
export class PostgresReplayGuard implements ReplayGuard {
  constructor(_deps: ReplayGuardDeps) {
    throw new Error("not implemented");
  }
  /** Insert-or-inspect; fresh | duplicate(priorResponse?, inFlight) | conflict. Throws when the store cannot be consulted. */
  claim(_id: string, _digest: string, _retainUntil: number | undefined, _now: number): Promise<ReplayVerdict> {
    throw new Error("not implemented");
  }
  /** Store the response document on this app's row; throws on non-2xx (the runtime swallows it). */
  recordResponse(_id: string, _response: unknown): Promise<void> {
    throw new Error("not implemented");
  }
  /** Delete this app's row for (id, digest) only while response is null (retryable refusal). */
  release(_id: string, _digest: string): Promise<void> {
    throw new Error("not implemented");
  }
}
