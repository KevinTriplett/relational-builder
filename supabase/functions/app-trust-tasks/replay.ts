// app-trust-tasks/replay.ts — Postgres-backed ReplayGuard (S-22, S-24).
//
// No Deno globals: all I/O goes through the injected `fetch` / `restUrl` /
// `svcHeaders` seam (DESIGN §3, P5–P10). The guard is app-scoped: a record
// written by one app is never absorbed, released, or swept by another.
//
// SPIKE: app-scoped Postgres guard so a different app can never run this app's
// effect a second time (S-24) — a row owned by another app is always `conflict`.

import {
  DEFAULT_SKEW_MS,
  type ReplayGuard,
  type ReplayVerdict,
} from "npm:@openvtc/trust-tasks@0.26.29";
import type { PostgrestDeps } from "./core.ts";

/** Default padding added to the runtime's retainUntil (S-22: recordExpiry omits skewMs). */
export const DEFAULT_RETENTION_PAD_MS: number = DEFAULT_SKEW_MS;

/** A row as P6 returns it — the four columns the claim reads back. */
interface ReplayRecord {
  app_id: string;
  digest: string;
  response: unknown;
  until_at: string;
}

/** Construction deps; one guard per request, scoped to the authenticated app (S-24). */
export interface ReplayGuardDeps extends PostgrestDeps {
  /** The row's owner; every read and write is filtered by this app id. */
  appId: string;
  /** Added to retainUntil before it is stored as until_at. Default DEFAULT_RETENTION_PAD_MS. */
  retentionPadMs?: number;
}

// What the conflict-resolution path (a 409 on the insert) decides: retry the
// insert, or a terminal verdict the caller may return.
type Resolve = ReplayVerdict | { kind: "retry" };

/** S-22/S-24: ReplayGuard over PostgREST (`app_tt_replay`), keyed on document id, app-scoped. */
export class PostgresReplayGuard implements ReplayGuard {
  private readonly fetch: typeof fetch;
  private readonly restUrl: (path: string) => string;
  private readonly svcHeaders: () => Record<string, string>;
  private readonly appId: string;
  private readonly retentionPadMs: number;

  constructor(deps: ReplayGuardDeps) {
    this.fetch = deps.fetch;
    this.restUrl = deps.restUrl;
    this.svcHeaders = deps.svcHeaders;
    this.appId = deps.appId;
    this.retentionPadMs = deps.retentionPadMs ?? DEFAULT_RETENTION_PAD_MS;
  }

  // S-22: claim an id for execution. A missing retention window fails closed
  // (SPEC §7.2 bounds the record to the acceptance window; no window, no claim).
  // A 409 means a row already holds the id; we read it back and resolve.
  async claim(
    id: string,
    digest: string,
    retainUntil: number | undefined,
    now: number,
  ): Promise<ReplayVerdict> {
    if (retainUntil === undefined) {
      throw new Error("replay claim: no retention window (retainUntil undefined)");
    }
    for (let attempt = 0; attempt < 2; attempt++) {
      const res = await this.insert(id, digest, retainUntil);
      if (res.status === 201) {
        this.sweep(now); // fire-and-forget; a failed sweep must not fail the claim
        return { kind: "fresh" };
      }
      if (res.status === 409) {
        const verdict = await this.resolveConflict(id, digest, now);
        if (verdict.kind === "retry") continue;
        return verdict;
      }
      throw new Error(`replay insert failed with HTTP ${res.status}`);
    }
    throw new Error("replay insert: doc_id collision after one retry");
  }

  // S-22: store the response document on this app's row (P9). Throws on non-2xx.
  async recordResponse(id: string, response: unknown): Promise<void> {
    const url = this.restUrl(
      `/app_tt_replay?doc_id=eq.${encodeURIComponent(id)}` +
        `&app_id=eq.${encodeURIComponent(this.appId)}`,
    );
    const res = await this.fetch(url, {
      method: "PATCH",
      headers: { ...this.svcHeaders(), Prefer: "return=minimal" },
      body: JSON.stringify({ response }),
    });
    if (!res.ok) throw new Error(`replay recordResponse failed with HTTP ${res.status}`);
  }

  // S-22: release a claim that is not to stand. Scoped to this app's in-flight
  // record only — P10 filters `response=is.null`, so a completed record stays.
  async release(id: string, digest: string): Promise<void> {
    const url = this.restUrl(
      `/app_tt_replay?doc_id=eq.${encodeURIComponent(id)}` +
        `&app_id=eq.${encodeURIComponent(this.appId)}` +
        `&digest=eq.${encodeURIComponent(digest)}&response=is.null`,
    );
    await this.fetch(url, { method: "DELETE", headers: this.svcHeaders() });
  }

  // P5: insert the in-flight record. `until_at` is the retention deadline.
  private async insert(id: string, digest: string, retainUntil: number): Promise<Response> {
    return this.fetch(this.restUrl("/app_tt_replay"), {
      method: "POST",
      headers: { ...this.svcHeaders(), Prefer: "return=minimal" },
      body: JSON.stringify({
        doc_id: id,
        app_id: this.appId,
        digest,
        response: null,
        until_at: new Date(retainUntil + this.retentionPadMs).toISOString(),
      }),
    });
  }

  // On a 409, read the row(s) holding the id and decide. A row owned by a
  // *different* app is always a conflict (S-24) — never touched. Our own expired
  // row is deleted (P7) and the insert retried; an unexpired same-digest row is a
  // duplicate; a different digest is a conflict.
  private async resolveConflict(id: string, digest: string, now: number): Promise<Resolve> {
    const rows = await this.lookup(id);
    if (rows.some((r) => r.app_id !== this.appId)) return { kind: "conflict" };
    const ours = rows.find((r) => r.app_id === this.appId);
    if (!ours) return { kind: "retry" };
    if (Date.parse(ours.until_at) <= now) {
      await this.deleteExpired(id, now);
      return { kind: "retry" };
    }
    if (ours.digest !== digest) return { kind: "conflict" };
    if (ours.response === null) return { kind: "duplicate", inFlight: true };
    return { kind: "duplicate", inFlight: false, priorResponse: ours.response };
  }

  // P6: get the rows for this id (all apps; the caller scopes by app_id).
  private async lookup(id: string): Promise<ReplayRecord[]> {
    const url = this.restUrl(
      `/app_tt_replay?doc_id=eq.${encodeURIComponent(id)}&select=app_id,digest,response,until_at`,
    );
    const res = await this.fetch(url, { method: "GET", headers: this.svcHeaders() });
    if (!res.ok) throw new Error(`replay lookup failed with HTTP ${res.status}`);
    return (await res.json()) as ReplayRecord[];
  }

  // P7: delete this app's expired record for the id so the insert can retry.
  private async deleteExpired(id: string, now: number): Promise<void> {
    const url = this.restUrl(
      `/app_tt_replay?doc_id=eq.${encodeURIComponent(id)}` +
        `&until_at=lte.${encodeURIComponent(new Date(now).toISOString())}`,
    );
    await this.fetch(url, { method: "DELETE", headers: this.svcHeaders() });
  }

  // P8: sweep records past their retention deadline. Fire-and-forget.
  private sweep(now: number): void {
    const url = this.restUrl(
      `/app_tt_replay?until_at=lt.${encodeURIComponent(new Date(now).toISOString())}`,
    );
    this.fetch(url, { method: "DELETE", headers: this.svcHeaders() }).catch(() => {});
  }
}
