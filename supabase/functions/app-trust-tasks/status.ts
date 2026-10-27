// app-trust-tasks/status.ts — SPIKE STUB (Phase 1). Signatures only; DESIGN.md §2.

import type { ConsumeOutcome, ErrorResponse } from "npm:@openvtc/trust-tasks@0.26.29";

/** CORS headers, identical to app-data's CORS constant (S-50). */
export const CORS_HEADERS: Readonly<Record<string, string>> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

/** Status + optional body + optional server-side log line for one outcome (S-50). */
export interface HttpResult {
  status: number;
  body?: unknown;
  log?: string;
}

/** S-50: HTTP status for a trust-task-error code per binding 0.2 §4 (normalizes 0.1 spellings; extended → 422; unknown standard → 500). */
export function statusForCode(_code: string): number {
  throw new Error("not implemented");
}

/** S-50: map a consumeInbound outcome to status/body; `genericMalformed` builds the body used for `suppressed`. */
export function mapOutcomeToHttp(
  _outcome: ConsumeOutcome<unknown>,
  _genericMalformed: () => ErrorResponse,
): HttpResult {
  throw new Error("not implemented");
}

/** S-50: CORS + Cache-Control: no-store, plus Content-Type: application/json iff a body is sent. */
export function responseHeaders(_hasBody: boolean): Record<string, string> {
  throw new Error("not implemented");
}

/** S-40: transport-level plain-JSON error `{error}` (never a trust-task-error). */
export function plainError(_status: number, _error: string): HttpResult {
  throw new Error("not implemented");
}
