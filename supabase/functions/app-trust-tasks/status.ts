// app-trust-tasks/status.ts — outcome → HTTP per HTTPS binding 0.2 §4, as amended by S-50 / C-12.
// Deno-free. The runtime ships no status helper (DESIGN Q7), so this table is hand-written,
// mirroring trust-tasks-https `status_for_code`.

import { normalizeCode, type ConsumeOutcome, type ErrorResponse } from "npm:@openvtc/trust-tasks@0.26.29";

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

const STANDARD_STATUS: Readonly<Record<string, number>> = {
  malformedRequest: 400,
  permissionDenied: 403,
  idConflict: 409,
  unavailable: 503,
  internalError: 500,
  unsupportedType: 422,
  unsupportedVersion: 422,
  expired: 422,
  proofRequired: 422,
  proofInvalid: 422,
  identityMismatch: 422,
  wrongRecipient: 422,
  cancelled: 422,
  taskFailed: 422,
  // C-45: a SPEC §8.3 standard code (was 500). Never emitted by this consumer.
  unsupportedExtension: 422,
};

/** S-50: HTTP status for a trust-task-error code per binding 0.2 §4 (normalizes 0.1 spellings; extended → 422; unknown standard → 500). */
export function statusForCode(code: string): number {
  const c = normalizeCode(code);
  const known = STANDARD_STATUS[c];
  if (known !== undefined) return known;
  // Extended `slug:local` codes: no task spec assigns a status (C-33).
  if (c.includes(":")) return 422;
  return 500;
}

function isErrorDocument(v: unknown): v is ErrorResponse {
  if (typeof v !== "object" || v === null) return false;
  const d = v as { type?: unknown; payload?: { code?: unknown } };
  return typeof d.type === "string" && d.type.split("#")[0].includes("/trust-task-error/") && typeof d.payload?.code === "string";
}

/** S-50: map a consumeInbound outcome to status/body; `genericMalformed` builds the body used for `suppressed`. */
export function mapOutcomeToHttp(
  outcome: ConsumeOutcome<unknown>,
  genericMalformed: () => ErrorResponse,
): HttpResult {
  switch (outcome.kind) {
    case "handled":
      return { status: 200, body: outcome.response };
    case "rejected":
      return { status: statusForCode(outcome.error.payload.code), body: outcome.error };
    case "suppressed":
      // SPIKE: suppressed → 400 — unreachable with UnauthenticatedTransport; answered like trust-tasks-https, no oracle (L-11, C-45).
      return { status: 400, body: genericMalformed(), log: `suppressed rejection: ${outcome.reason.code}` };
    case "accepted":
      return { status: 204 };
    case "duplicate":
      if (outcome.priorResponse !== undefined) {
        const prior = outcome.priorResponse;
        // SPIKE: retained error — a duplicate whose prior response was an error replays it at that code's status, not the binding's duplicate status (R6, L-10, C-45).
        return { status: isErrorDocument(prior) ? statusForCode(prior.payload.code) : 200, body: prior };
      }
      return { status: outcome.inFlight ? 202 : 204 };
  }
}

/** S-50: CORS + Cache-Control: no-store, plus Content-Type: application/json iff a body is sent. */
export function responseHeaders(hasBody: boolean): Record<string, string> {
  const h: Record<string, string> = { ...CORS_HEADERS, "Cache-Control": "no-store" };
  if (hasBody) h["Content-Type"] = "application/json";
  return h;
}

/** S-40: transport-level plain-JSON error `{error}` (never a trust-task-error). */
export function plainError(status: number, error: string): HttpResult {
  return { status, body: { error } };
}
