/**
 * In-memory PostgREST subset — exactly the contract in DESIGN.md §3 (P1–P13).
 *
 * Anything not in that table (path, method, query parameter, operator, select
 * column, header, Prefer value, body member) is a *contract violation*: it is
 * recorded in `violations` and the returned promise rejects with
 * `FakeContractError`. Recording matters because the code under test is
 * allowed to catch store errors (→ `unavailable`), which would otherwise hide a
 * violation; every suite asserts `violations` is empty after each test.
 *
 * Fault injection: `failAll(callId, 'reject' | status)` and the one-shot
 * `script(callId, …)` queue. `before(callId, fn)` runs a hook before a call is
 * processed (used to stage races).
 */

export type CallId =
  | 'P1' | 'P2' | 'P3' | 'P4' | 'P5' | 'P6' | 'P7' | 'P8' | 'P9' | 'P10' | 'P11' | 'P12' | 'P13';

export interface AppRow { id: string; app_key: string; trust_signin_enabled: boolean }
export interface ChallengeRow {
  session_id: string; app_id: string; subject: string | null; challenge: string;
  expires_at: string; consumed_at: string | null; created_at: string;
}
export interface ReplayRow { doc_id: string; app_id: string; digest: string; response: unknown; until_at: string }
export interface MemberRow { id: string; app_id: string; email: string | null; name: string | null; did: string | null; created_at: string }
export interface SessionRow { token: string; app_id: string; member_id: string; expires_at: string }

export interface Tables {
  cloud_apps: AppRow[];
  app_tt_challenges: ChallengeRow[];
  app_tt_replay: ReplayRow[];
  app_members: MemberRow[];
  app_sessions: SessionRow[];
}

export interface CallRecord {
  id: CallId | 'UNMODELED';
  method: string;
  url: string;
  /** Decoded query parameters. */
  query: Record<string, string>;
  prefer: string | null;
  body: unknown;
  status: number | 'rejected';
}

export class FakeContractError extends Error {
  constructor(message: string) {
    super(`fake-postgrest contract violation: ${message}`);
    this.name = 'FakeContractError';
  }
}

type Op = 'eq' | 'lt' | 'lte' | 'is.null';
interface CallSpec {
  id: CallId;
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  table: keyof Tables;
  /** Filter params and their operator. */
  filters: Record<string, Op>;
  select?: readonly string[];
  prefer: 'return=minimal' | 'return=representation' | null;
  bodyKeys?: readonly string[];
}

const CONTRACT: readonly CallSpec[] = [
  { id: 'P1', method: 'GET', table: 'cloud_apps', filters: { id: 'eq' }, select: ['id', 'app_key', 'trust_signin_enabled'], prefer: null },
  { id: 'P2', method: 'POST', table: 'app_tt_challenges', filters: {}, prefer: 'return=minimal', bodyKeys: ['session_id', 'app_id', 'subject', 'challenge', 'expires_at'] },
  { id: 'P3', method: 'PATCH', table: 'app_tt_challenges', filters: { session_id: 'eq', app_id: 'eq', consumed_at: 'is.null' }, prefer: 'return=representation', bodyKeys: ['consumed_at'] },
  { id: 'P4', method: 'DELETE', table: 'app_tt_challenges', filters: { expires_at: 'lt' }, prefer: null },
  { id: 'P5', method: 'POST', table: 'app_tt_replay', filters: {}, prefer: 'return=minimal', bodyKeys: ['doc_id', 'app_id', 'digest', 'response', 'until_at'] },
  { id: 'P6', method: 'GET', table: 'app_tt_replay', filters: { doc_id: 'eq' }, select: ['app_id', 'digest', 'response', 'until_at'], prefer: null },
  { id: 'P7', method: 'DELETE', table: 'app_tt_replay', filters: { doc_id: 'eq', until_at: 'lte' }, prefer: null },
  { id: 'P8', method: 'DELETE', table: 'app_tt_replay', filters: { until_at: 'lt' }, prefer: null },
  { id: 'P9', method: 'PATCH', table: 'app_tt_replay', filters: { doc_id: 'eq', app_id: 'eq' }, prefer: 'return=minimal', bodyKeys: ['response'] },
  { id: 'P10', method: 'DELETE', table: 'app_tt_replay', filters: { doc_id: 'eq', app_id: 'eq', digest: 'eq', response: 'is.null' }, prefer: null },
  { id: 'P11', method: 'GET', table: 'app_members', filters: { app_id: 'eq', did: 'eq' }, select: ['id', 'email', 'name', 'did'], prefer: null },
  { id: 'P12', method: 'POST', table: 'app_members', filters: {}, prefer: 'return=representation', bodyKeys: ['app_id', 'did', 'email', 'name'] },
  { id: 'P13', method: 'POST', table: 'app_sessions', filters: {}, prefer: 'return=minimal', bodyKeys: ['token', 'app_id', 'member_id', 'expires_at'] },
];

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ALLOWED_HEADERS = new Set(['apikey', 'authorization', 'content-type', 'prefer']);

export type ScriptAction = 'reject' | number | ((ctx: { body: unknown; query: Record<string, string> }) => Response);

export interface FakeOptions {
  supabaseUrl?: string;
  serviceKey?: string;
  /** Clock for `created_at` defaults. */
  now?: () => Date;
  randomUUID?: () => string;
}

function isoOrViolation(v: unknown, what: string): string {
  if (typeof v !== 'string' || Number.isNaN(Date.parse(v)) || new Date(v).toISOString() !== v) {
    throw new FakeContractError(`${what} must be a Date#toISOString() timestamp, got ${JSON.stringify(v)}`);
  }
  return v;
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}
function empty(status: number): Response {
  return new Response(null, { status });
}
function uniqueViolation(constraint: string): Response {
  return json(409, { code: '23505', message: `duplicate key value violates unique constraint "${constraint}"` });
}

export class FakePostgrest {
  readonly supabaseUrl: string;
  readonly serviceKey: string;
  readonly tables: Tables = { cloud_apps: [], app_tt_challenges: [], app_tt_replay: [], app_members: [], app_sessions: [] };
  readonly calls: CallRecord[] = [];
  readonly violations: string[] = [];
  private readonly nowFn: () => Date;
  private readonly uuid: () => string;
  private readonly persistentFaults = new Map<CallId | '*', 'reject' | number>();
  private readonly scripts = new Map<CallId, ScriptAction[]>();
  private readonly hooks = new Map<CallId, Array<() => void>>();

  constructor(opts: FakeOptions = {}) {
    this.supabaseUrl = opts.supabaseUrl ?? 'https://fakeproject.supabase.co';
    this.serviceKey = opts.serviceKey ?? 'svc-test-key';
    this.nowFn = opts.now ?? (() => new Date(0));
    this.uuid = opts.randomUUID ?? (() => crypto.randomUUID());
  }

  restUrl = (p: string): string => `${this.supabaseUrl}/rest/v1${p}`;
  svcHeaders = (): Record<string, string> => ({
    apikey: this.serviceKey,
    Authorization: `Bearer ${this.serviceKey}`,
    'Content-Type': 'application/json',
  });
  deps() {
    return { fetch: this.fetch, restUrl: this.restUrl, svcHeaders: this.svcHeaders };
  }

  /** Every call with this id, in order. */
  callsOf(id: CallId): CallRecord[] {
    return this.calls.filter((c) => c.id === id);
  }
  callIds(): string[] {
    return this.calls.map((c) => c.id);
  }
  /** Persistent fault for one call id (or every call: '*'). `null` clears. */
  failAll(id: CallId | '*', action: 'reject' | number | null): void {
    if (action === null) this.persistentFaults.delete(id);
    else this.persistentFaults.set(id, action);
  }
  /** One-shot scripted answers, consumed in order, before the modelled behaviour. */
  script(id: CallId, ...actions: ScriptAction[]): void {
    this.scripts.set(id, [...(this.scripts.get(id) ?? []), ...actions]);
  }
  /** Run `fn` immediately before the next call with this id is processed. */
  before(id: CallId, fn: () => void): void {
    this.hooks.set(id, [...(this.hooks.get(id) ?? []), fn]);
  }

  addApp(row: AppRow): void {
    this.tables.cloud_apps.push(row);
  }

  fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    let method = (init?.method ?? 'GET').toUpperCase();
    let url: string;
    let headers = new Headers(init?.headers);
    let rawBody: unknown = init?.body;
    if (typeof input === 'string') url = input;
    else if (input instanceof URL) url = input.toString();
    else {
      url = input.url;
      method = (init?.method ?? input.method).toUpperCase();
      if (!init?.headers) headers = new Headers(input.headers);
      if (rawBody === undefined) rawBody = await input.text();
    }
    const record: CallRecord = { id: 'UNMODELED', method, url, query: {}, prefer: null, body: undefined, status: 'rejected' };
    this.calls.push(record);
    try {
      const res = this.handle(record, method, url, headers, rawBody);
      record.status = res === 'reject' ? 'rejected' : res.status;
      if (res === 'reject') throw new TypeError('fetch failed (fake-postgrest: injected network failure)');
      return res;
    } catch (e) {
      if (e instanceof FakeContractError) this.violations.push(e.message);
      throw e;
    }
  };

  private violation(msg: string): never {
    throw new FakeContractError(msg);
  }

  private handle(record: CallRecord, method: string, url: string, headers: Headers, rawBody: unknown): Response | 'reject' {
    const prefix = `${this.supabaseUrl}/rest/v1/`;
    if (!url.startsWith(prefix)) this.violation(`URL outside ${prefix}: ${url}`);
    const rest = url.slice(prefix.length);
    if (rest.includes('#')) this.violation(`unencoded '#' in ${url}`);
    const qIdx = rest.indexOf('?');
    const table = qIdx === -1 ? rest : rest.slice(0, qIdx);
    const rawQuery = qIdx === -1 ? '' : rest.slice(qIdx + 1);

    // Query: parameter order is not significant; values decoded as PostgREST
    // does ('+' is a space), so an unencoded filter value is visible.
    const query: Record<string, string> = {};
    if (rawQuery) {
      for (const part of rawQuery.split('&')) {
        const eq = part.indexOf('=');
        if (eq === -1) this.violation(`query parameter without value: ${part}`);
        const k = decodeURIComponent(part.slice(0, eq).replace(/\+/g, ' '));
        const v = decodeURIComponent(part.slice(eq + 1).replace(/\+/g, ' '));
        if (k in query) this.violation(`repeated query parameter ${k}`);
        query[k] = v;
      }
    }
    record.query = query;

    // Headers.
    const seen: Record<string, string> = {};
    headers.forEach((value, key) => {
      if (!ALLOWED_HEADERS.has(key.toLowerCase())) this.violation(`unmodelled header ${key}`);
      seen[key.toLowerCase()] = value;
    });
    if (seen['apikey'] !== this.serviceKey) this.violation('missing/wrong apikey header (svcHeaders)');
    if (seen['authorization'] !== `Bearer ${this.serviceKey}`) this.violation('missing/wrong Authorization header (svcHeaders)');
    if (seen['content-type'] !== 'application/json') this.violation('missing Content-Type: application/json (svcHeaders)');
    const prefer = seen['prefer'] ?? null;
    record.prefer = prefer;

    // Identify the call.
    const keys = Object.keys(query).filter((k) => k !== 'select').sort();
    const spec = CONTRACT.find(
      (c) => c.method === method && c.table === table && keys.join(',') === Object.keys(c.filters).sort().join(','),
    );
    if (!spec) this.violation(`unmodelled call ${method} /${table}?${rawQuery}`);
    record.id = spec.id;

    // select=
    if (spec.select) {
      if (!('select' in query)) this.violation(`${spec.id}: select= is required`);
      const cols = query.select.split(',');
      if (cols.length !== spec.select.length || cols.some((c) => !spec.select!.includes(c))) {
        this.violation(`${spec.id}: unmodelled select=${query.select}`);
      }
    } else if ('select' in query) {
      this.violation(`${spec.id}: unmodelled select=`);
    }

    // Operators.
    const filters: Record<string, string> = {};
    for (const [col, op] of Object.entries(spec.filters)) {
      const v = query[col];
      if (op === 'is.null') {
        if (v !== 'is.null') this.violation(`${spec.id}: ${col} must be is.null, got ${v}`);
        continue;
      }
      if (!v.startsWith(`${op}.`)) this.violation(`${spec.id}: unmodelled operator on ${col}: ${v}`);
      filters[col] = v.slice(op.length + 1);
      if (op === 'lt' || op === 'lte') isoOrViolation(filters[col], `${spec.id} ${col} filter`);
    }

    // Prefer.
    if (prefer !== spec.prefer) this.violation(`${spec.id}: Prefer must be ${spec.prefer ?? 'absent'}, got ${prefer}`);

    // Body.
    let body: unknown = undefined;
    if (spec.bodyKeys) {
      if (typeof rawBody !== 'string') this.violation(`${spec.id}: body must be a JSON string`);
      try {
        body = JSON.parse(rawBody);
      } catch {
        this.violation(`${spec.id}: body is not JSON`);
      }
      if (typeof body !== 'object' || body === null || Array.isArray(body)) this.violation(`${spec.id}: body must be a JSON object`);
      const bk = Object.keys(body as object).sort();
      if (bk.join(',') !== [...spec.bodyKeys].sort().join(',')) {
        this.violation(`${spec.id}: body members ${bk.join(',')} != ${[...spec.bodyKeys].sort().join(',')}`);
      }
    } else if (rawBody !== undefined && rawBody !== null) {
      this.violation(`${spec.id}: unexpected request body`);
    }
    record.body = body;

    // Hooks, faults, scripts.
    const hooks = this.hooks.get(spec.id);
    if (hooks?.length) hooks.shift()!();
    const fault = this.persistentFaults.get(spec.id) ?? this.persistentFaults.get('*');
    if (fault !== undefined) return fault === 'reject' ? 'reject' : json(fault, { message: 'Service Unavailable' });
    const scripted = this.scripts.get(spec.id);
    if (scripted?.length) {
      const action = scripted.shift()!;
      if (action === 'reject') return 'reject';
      if (typeof action === 'number') return json(action, { message: `scripted ${action}` });
      return action({ body, query });
    }

    return this.execute(spec.id, filters, body as Record<string, unknown>);
  }

  private execute(id: CallId, f: Record<string, string>, body: Record<string, unknown>): Response {
    const t = this.tables;
    const before = (a: string, b: string) => Date.parse(a) < Date.parse(b);
    switch (id) {
      case 'P1': {
        if (!UUID_RE.test(f.id)) return json(400, { code: '22P02', message: 'invalid input syntax for type uuid' });
        return json(200, t.cloud_apps.filter((r) => r.id === f.id).map((r) => ({ id: r.id, app_key: r.app_key, trust_signin_enabled: r.trust_signin_enabled })));
      }
      case 'P2': {
        const b = body;
        if (typeof b.session_id !== 'string' || typeof b.app_id !== 'string' || typeof b.challenge !== 'string') {
          this.violation('P2: session_id, app_id, challenge must be strings');
        }
        if (b.subject !== null && typeof b.subject !== 'string') this.violation('P2: subject must be string|null');
        const expires_at = isoOrViolation(b.expires_at, 'P2 expires_at');
        if (t.app_tt_challenges.some((r) => r.session_id === b.session_id)) return uniqueViolation('app_tt_challenges_pkey');
        t.app_tt_challenges.push({
          session_id: b.session_id as string, app_id: b.app_id as string, subject: b.subject as string | null,
          challenge: b.challenge as string, expires_at, consumed_at: null, created_at: this.nowFn().toISOString(),
        });
        return empty(201);
      }
      case 'P3': {
        const consumed_at = isoOrViolation(body.consumed_at, 'P3 consumed_at');
        const rows = t.app_tt_challenges.filter((r) => r.session_id === f.session_id && r.app_id === f.app_id && r.consumed_at === null);
        for (const r of rows) r.consumed_at = consumed_at;
        return json(200, rows.map((r) => ({ ...r })));
      }
      case 'P4': {
        t.app_tt_challenges = t.app_tt_challenges.filter((r) => !before(r.expires_at, f.expires_at));
        return empty(204);
      }
      case 'P5': {
        const b = body;
        if (typeof b.doc_id !== 'string' || typeof b.app_id !== 'string' || typeof b.digest !== 'string') {
          this.violation('P5: doc_id, app_id, digest must be strings');
        }
        if (b.response !== null) this.violation('P5: response must be null');
        const until_at = isoOrViolation(b.until_at, 'P5 until_at');
        if (t.app_tt_replay.some((r) => r.doc_id === b.doc_id)) return uniqueViolation('app_tt_replay_pkey');
        t.app_tt_replay.push({ doc_id: b.doc_id as string, app_id: b.app_id as string, digest: b.digest as string, response: null, until_at });
        return empty(201);
      }
      case 'P6':
        return json(200, t.app_tt_replay.filter((r) => r.doc_id === f.doc_id).map((r) => ({ app_id: r.app_id, digest: r.digest, response: r.response, until_at: r.until_at })));
      case 'P7':
        t.app_tt_replay = t.app_tt_replay.filter((r) => !(r.doc_id === f.doc_id && Date.parse(r.until_at) <= Date.parse(f.until_at)));
        return empty(204);
      case 'P8':
        t.app_tt_replay = t.app_tt_replay.filter((r) => !before(r.until_at, f.until_at));
        return empty(204);
      case 'P9': {
        for (const r of t.app_tt_replay) if (r.doc_id === f.doc_id && r.app_id === f.app_id) r.response = structuredClone(body.response);
        return empty(204);
      }
      case 'P10':
        t.app_tt_replay = t.app_tt_replay.filter((r) => !(r.doc_id === f.doc_id && r.app_id === f.app_id && r.digest === f.digest && r.response === null));
        return empty(204);
      case 'P11':
        return json(200, t.app_members.filter((r) => r.app_id === f.app_id && r.did === f.did).map((r) => ({ id: r.id, email: r.email, name: r.name, did: r.did })));
      case 'P12': {
        const b = body;
        if (typeof b.app_id !== 'string' || typeof b.did !== 'string') this.violation('P12: app_id and did must be strings');
        if (b.email !== null || b.name !== null) this.violation('P12: email and name must be null');
        if (t.app_members.some((r) => r.app_id === b.app_id && r.did !== null && r.did === b.did)) return uniqueViolation('app_members_app_did_idx');
        const row: MemberRow = { id: this.uuid(), app_id: b.app_id as string, email: null, name: null, did: b.did as string, created_at: this.nowFn().toISOString() };
        t.app_members.push(row);
        return json(201, [{ ...row }]);
      }
      case 'P13': {
        const b = body;
        if (typeof b.token !== 'string' || typeof b.app_id !== 'string' || typeof b.member_id !== 'string') {
          this.violation('P13: token, app_id, member_id must be strings');
        }
        const expires_at = isoOrViolation(b.expires_at, 'P13 expires_at');
        if (t.app_sessions.some((r) => r.token === b.token)) return uniqueViolation('app_sessions_pkey');
        t.app_sessions.push({ token: b.token as string, app_id: b.app_id as string, member_id: b.member_id as string, expires_at });
        return empty(201);
      }
    }
  }
}
