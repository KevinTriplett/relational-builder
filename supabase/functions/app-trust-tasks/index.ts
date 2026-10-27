// app-trust-tasks/index.ts — SPIKE STUB (Phase 1). Deno.serve glue only (S-51, ≤ 60 lines when
// implemented): read env, build CoreDeps once, route POST …/trust-tasks to handleTrustTask,
// map status via status.ts. Excluded from tsconfig.functions.json; checked with `deno check`.

import { handleTrustTask } from "./core.ts";
import { responseHeaders } from "./status.ts";

Deno.serve((_req: Request): Response => {
  void handleTrustTask;
  void responseHeaders;
  throw new Error("not implemented");
});
