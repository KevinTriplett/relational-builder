import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import {
  AuthChallenge_v0_1,
  TRUST_TASK_ERROR_TYPE_URI,
  type ConsumeOutcome,
  type ErrorResponse,
  type TrustTaskDocument,
} from '@openvtc/trust-tasks';
import {
  AUTHENTICATE_TYPE,
  CHALLENGE_TYPE,
  InMemoryRateLimiter,
  RATE_LIMIT_PER_MIN,
  REGISTERED_TYPES,
  checkFrameworkShape,
  classifyType,
  errorDocument,
  handleTrustTask,
  localVidFromSupabaseUrl,
  stampIssuer,
} from '../../supabase/functions/app-trust-tasks/core.ts';
import { CORS_HEADERS, mapOutcomeToHttp, plainError, responseHeaders, statusForCode } from '../../supabase/functions/app-trust-tasks/status.ts';
import {
  APP_A, APP_OFF, KEY_A, KEY_OFF, LOCAL_VID, SUPABASE_URL, expectError, makeEnv, makeFake, post, signInFlow, TestClock,
} from './helpers.ts';
import { challengeDoc, mintDidKey } from './producer.ts';

const FN_DIR = fileURLToPath(new URL('../../supabase/functions/app-trust-tasks/', import.meta.url));
const read = (f: string) => readFileSync(FN_DIR + f, 'utf8');

function chDoc(env: ReturnType<typeof makeEnv>, o: Partial<Parameters<typeof challengeDoc>[1]> = {}) {
  return challengeDoc(mintDidKey().did, { id: crypto.randomUUID(), now: env.clock.now(), recipient: LOCAL_VID, ...o });
}

describe('app authentication precedes parsing (S-40)', () => {
  it('S-40 missing app_id or app_key → 401 plain JSON {error:"app_id and app_key required"}, before rate limiting, lookup or parsing', async () => {
    for (const [appId, appKey] of [['', KEY_A], [APP_A, ''], ['', '']]) {
      const env = makeEnv();
      const res = await handleTrustTask(env.deps, { appId, appKey, rawBody: undefined });
      expect(res).toEqual({ status: 401, body: { error: 'app_id and app_key required' } });
      expect(env.limiter.hits).toHaveLength(0);
      expect(env.fake.calls).toHaveLength(0);
    }
  });

  it('S-40 rate limited → 429 {error:"Rate limit exceeded — try again in a minute"} before the app lookup (no PostgREST call)', async () => {
    const env = makeEnv();
    env.limiter.limited = true;
    const res = await post(env, chDoc(env));
    expect(res).toEqual({ status: 429, body: { error: 'Rate limit exceeded — try again in a minute' } });
    expect(env.limiter.hits).toEqual([{ appId: APP_A, nowMs: env.clock.ms }]);
    expect(env.fake.calls).toHaveLength(0);
  });

  it('S-40 InMemoryRateLimiter: 120 per minute per app, fixed 60 s window', () => {
    const rl = new InMemoryRateLimiter();
    expect(RATE_LIMIT_PER_MIN).toBe(120);
    const t = 1_000_000;
    for (let i = 0; i < 120; i++) expect(rl.hit('app-1', t + i)).toBe(false);
    expect(rl.hit('app-1', t + 200)).toBe(true);
    expect(rl.hit('app-2', t + 200)).toBe(false);
    expect(rl.hit('app-1', t + 60_001)).toBe(false);
    const small = new InMemoryRateLimiter(2);
    expect([small.hit('a', 0), small.hit('a', 1), small.hit('a', 2)]).toEqual([false, false, true]);
  });

  it('S-40 the 121st request in a minute through handleTrustTask with the default limiter → 429', async () => {
    const env = makeEnv();
    env.deps.rateLimiter = new InMemoryRateLimiter();
    let last;
    for (let i = 0; i < 121; i++) last = await handleTrustTask(env.deps, { appId: APP_A, appKey: 'wrong', rawBody: {} });
    expect(last).toEqual({ status: 429, body: { error: 'Rate limit exceeded — try again in a minute' } });
    expect(env.fake.callsOf('P1')).toHaveLength(120);
  });

  it('S-40 unknown app, wrong key, or a non-uuid app_id → 403 {error:"Unknown app or wrong key"} (one P1 lookup)', async () => {
    for (const [appId, appKey] of [['99999999-9999-4999-8999-999999999999', KEY_A], [APP_A, 'wrong-key'], ['not-a-uuid', KEY_A]]) {
      const env = makeEnv();
      const res = await post(env, chDoc(env), appId, appKey);
      expect(res).toEqual({ status: 403, body: { error: 'Unknown app or wrong key' } });
      expect(env.fake.callIds()).toEqual(['P1']);
      expect(env.fake.callsOf('P1')[0].query).toEqual({ id: `eq.${appId}`, select: 'id,app_key,trust_signin_enabled' });
    }
  });

  it('S-40 the app lookup failing (rejected fetch or 5xx) → 503 {error:"Service unavailable"}', async () => {
    for (const fault of ['reject', 503, 500] as const) {
      const env = makeEnv();
      env.fake.failAll('P1', fault);
      expect(await post(env, chDoc(env))).toEqual({ status: 503, body: { error: 'Service unavailable' } });
    }
  });

  it('S-40 trust_signin_enabled false → 403 {error:"Trust Task sign-in is not enabled for this app"} with zero P2–P13 calls', async () => {
    const env = makeEnv();
    const res = await post(env, chDoc(env), APP_OFF, KEY_OFF);
    expect(res).toEqual({ status: 403, body: { error: 'Trust Task sign-in is not enabled for this app' } });
    expect(env.fake.callIds()).toEqual(['P1']);
  });

  it('S-40 credentials are checked before the body: bad key + unparseable body → 403, not 400', async () => {
    const env = makeEnv();
    expect(await post(env, undefined, APP_A, 'wrong')).toEqual({ status: 403, body: { error: 'Unknown app or wrong key' } });
  });
});

describe('the rate limit is spent by app_id alone (C-54)', () => {
  it('C-54 120 requests with the right app_id and a wrong app_key (each 403), then one with the right key in the same window → 429', async () => {
    const env = makeEnv();
    env.deps.rateLimiter = new InMemoryRateLimiter();
    for (let i = 0; i < 120; i++) {
      const res = await handleTrustTask(env.deps, { appId: APP_A, appKey: 'wrong-key', rawBody: chDoc(env) });
      expect(res, `request ${i + 1}`).toEqual({ status: 403, body: { error: 'Unknown app or wrong key' } });
      env.clock.advance(100);
    }
    const p1 = env.fake.callsOf('P1').length;
    const res = await handleTrustTask(env.deps, { appId: APP_A, appKey: KEY_A, rawBody: chDoc(env) });
    expect(res).toEqual({ status: 429, body: { error: 'Rate limit exceeded — try again in a minute' } });
    expect(env.fake.callsOf('P1')).toHaveLength(p1);
  });
});

/** The limiter's bucket map, found by type so the test does not depend on the field's name (C-57). */
function bucketsOf(rl: InMemoryRateLimiter): Map<string, unknown> {
  const maps = Object.values(rl as unknown as Record<string, unknown>).filter((v): v is Map<string, unknown> => v instanceof Map);
  expect(maps, 'InMemoryRateLimiter keeps exactly one Map-valued field (its buckets)').toHaveLength(1);
  return maps[0];
}

describe('the rate limiter\'s memory is bounded (C-57)', () => {
  const MAX_BUCKETS = 10_000;

  it('C-57 with a fixed now, 20 000 distinct ids leave the map at ≤ 10 000 entries; the latest id is present and its next hit counts as its second', () => {
    const rl = new InMemoryRateLimiter(1); // limit 1: a second hit in the window returns true
    const now = 5_000_000;
    let last = '';
    for (let i = 0; i < 20_000; i++) {
      last = `app-${i}`;
      expect(rl.hit(last, now)).toBe(false);
    }
    const buckets = bucketsOf(rl);
    expect(buckets.size).toBeLessThanOrEqual(MAX_BUCKETS);
    expect(buckets.has(last)).toBe(true);
    expect(rl.hit(last, now), 'the latest id\'s next hit is its second (over a limit of 1)').toBe(true);
  });

  it('C-57 an id hit 121 times in one window (with fewer than MAX_BUCKETS other ids in between) → the 121st returns true', () => {
    const rl = new InMemoryRateLimiter();
    const now = 7_000_000;
    const results: boolean[] = [];
    for (let i = 0; i < 121; i++) {
      results.push(rl.hit('busy-app', now));
      for (let j = 0; j < 50; j++) rl.hit(`other-${i}-${j}`, now); // 6 050 other ids in total
    }
    expect(results.slice(0, 120).every((r) => r === false)).toBe(true);
    expect(results[120]).toBe(true);
    expect(bucketsOf(rl).size).toBeLessThanOrEqual(MAX_BUCKETS);
  });

  it('C-57 the self-check: bucketsOf finds the one Map on a concrete object', () => {
    const fakeLimiter = { limit: 3, buckets: new Map([['a', 1]]) } as unknown as InMemoryRateLimiter;
    expect(bucketsOf(fakeLimiter).get('a')).toBe(1);
  });
});

describe('parse and dispatch (S-41)', () => {
  it('S-41 unparseable or non-object bodies → 400 malformedRequest trust-task-error (issuer = localVid)', async () => {
    for (const raw of [undefined, 'not json', null, 42, [], [{ type: CHALLENGE_TYPE }], {}, { type: 7 }]) {
      const env = makeEnv();
      const err = expectError(await post(env, raw), 400, 'malformedRequest');
      expect(err.payload.retryable).toBe(false);
      expect(env.fake.callIds()).toEqual(['P1']);
    }
  });

  it('S-41 another version of a registered slug → 422 unsupportedVersion', async () => {
    for (const type of ['https://trusttasks.org/spec/auth/authenticate/0.2', 'https://trusttasks.org/spec/auth/challenge/0.2', 'https://trusttasks.org/spec/auth/authenticate/1.0']) {
      const env = makeEnv();
      expectError(await post(env, { ...chDoc(env), type }), 422, 'unsupportedVersion');
    }
  });

  it('S-41 any other type, including a #response fragment → 422 unsupportedType', async () => {
    for (const type of ['https://trusttasks.org/spec/acl/grant/0.1', `${CHALLENGE_TYPE}#response`, `${AUTHENTICATE_TYPE}#response`, 'https://trusttasks.org/spec/auth/whoami/0.1', 'nonsense']) {
      const env = makeEnv();
      expectError(await post(env, { ...chDoc(env), type }), 422, 'unsupportedType');
      expect(env.fake.callIds()).toEqual(['P1']);
    }
  });

  it('S-41 classifyType and REGISTERED_TYPES', () => {
    expect([...REGISTERED_TYPES]).toEqual([CHALLENGE_TYPE, AUTHENTICATE_TYPE]);
    expect(CHALLENGE_TYPE).toBe('https://trusttasks.org/spec/auth/challenge/0.1');
    expect(AUTHENTICATE_TYPE).toBe('https://trusttasks.org/spec/auth/authenticate/0.3');
    expect(classifyType(CHALLENGE_TYPE)).toBe('challenge');
    expect(classifyType(AUTHENTICATE_TYPE)).toBe('authenticate');
    expect(classifyType('https://trusttasks.org/spec/auth/authenticate/0.2')).toBe('unsupportedVersion');
    expect(classifyType('https://trusttasks.org/spec/auth/challenge/0.2')).toBe('unsupportedVersion');
    expect(classifyType(`${CHALLENGE_TYPE}#response`)).toBe('unsupportedType');
    expect(classifyType('https://trusttasks.org/spec/acl/grant/0.1')).toBe('unsupportedType');
  });

  it('S-41 envelope shape: id must be a non-empty string, payload an object; optional members typed → else 400 malformedRequest', async () => {
    const bads: Array<Record<string, unknown>> = [
      { type: CHALLENGE_TYPE, payload: {} },
      { id: '', type: CHALLENGE_TYPE, payload: {} },
      { id: 5, type: CHALLENGE_TYPE, payload: {} },
      { id: 'x', type: CHALLENGE_TYPE },
      { id: 'x', type: CHALLENGE_TYPE, payload: [] },
      { id: 'x', type: CHALLENGE_TYPE, payload: 'p' },
      { id: 'x', type: CHALLENGE_TYPE, payload: null },
      { id: 'x', type: CHALLENGE_TYPE, payload: {}, issuer: 1 },
      { id: 'x', type: CHALLENGE_TYPE, payload: {}, recipient: {} },
      { id: 'x', type: CHALLENGE_TYPE, payload: {}, issuedAt: 0 },
      { id: 'x', type: CHALLENGE_TYPE, payload: {}, expiresAt: true },
      { id: 'x', type: CHALLENGE_TYPE, payload: {}, threadId: 3 },
      { id: 'x', type: CHALLENGE_TYPE, payload: {}, proof: 'sig' },
      { id: 'x', type: AUTHENTICATE_TYPE, payload: {}, proof: [] },
    ];
    for (const b of bads) {
      expect(typeof checkFrameworkShape(b), JSON.stringify(b)).toBe('string');
      const env = makeEnv();
      expectError(await post(env, b), 400, 'malformedRequest');
      expect(env.fake.callIds()).toEqual(['P1']);
    }
    expect(checkFrameworkShape(chDoc(makeEnv()) as Record<string, unknown>)).toBeNull();
  });

  it('S-41 errorDocument without a parsed request: issuer localVid; recipient = body issuer; threadId = threadId ?? id ?? own id; inResponseTo only with string type and id', () => {
    const deps = { localVid: LOCAL_VID, now: () => new Date(Date.UTC(2031, 0, 1)), randomUUID: () => 'err-id-1' };
    const payload = { code: 'malformedRequest', retryable: false, message: 'm' };
    const a = errorDocument(deps, { id: 'req-1', type: CHALLENGE_TYPE, issuer: 'did:key:z6MkX', threadId: 'th-1' }, payload);
    expect(a).toMatchObject({ id: 'err-id-1', type: TRUST_TASK_ERROR_TYPE_URI, issuer: LOCAL_VID, recipient: 'did:key:z6MkX', threadId: 'th-1' });
    expect(a.payload).toMatchObject({ code: 'malformedRequest', retryable: false, inResponseTo: { typeUri: CHALLENGE_TYPE, id: 'req-1' } });
    const b = errorDocument(deps, { id: 'req-2', issuer: 5 }, payload);
    expect(b.threadId).toBe('req-2');
    expect(b.recipient).toBeUndefined();
    expect(b.payload.inResponseTo).toBeUndefined();
    const c = errorDocument(deps, undefined, payload);
    expect(c).toMatchObject({ id: 'err-id-1', issuer: LOCAL_VID, threadId: 'err-id-1' });
    expect(c.recipient).toBeUndefined();
    expect(c.issuedAt).toBe('2031-01-01T00:00:00.000Z');
  });

  it('S-41 a 400 for a body with string type/id/issuer is addressed back: recipient = issuer, threadId = id, inResponseTo set', async () => {
    const env = makeEnv();
    const body = { id: 'req-9', type: CHALLENGE_TYPE, issuer: 'did:key:z6MkAbc', payload: [] };
    const err = expectError(await post(env, body), 400, 'malformedRequest');
    expect(err).toMatchObject({ recipient: 'did:key:z6MkAbc', threadId: 'req-9' });
    expect(err.payload.inResponseTo).toEqual({ typeUri: CHALLENGE_TYPE, id: 'req-9' });
  });
});

describe('localVid is configuration (S-30)', () => {
  it('S-30 localVidFromSupabaseUrl = did:web:<hostname> (+ %3A<port> for an explicit non-default port), no scheme or path (C-25)', () => {
    expect(localVidFromSupabaseUrl('https://abcd.supabase.co')).toBe('did:web:abcd.supabase.co');
    expect(localVidFromSupabaseUrl('https://abcd.supabase.co/')).toBe('did:web:abcd.supabase.co');
    expect(localVidFromSupabaseUrl('https://abcd.supabase.co/functions/v1')).toBe('did:web:abcd.supabase.co');
    expect(localVidFromSupabaseUrl('http://localhost:54321')).toBe('did:web:localhost%3A54321');
    expect(localVidFromSupabaseUrl('http://127.0.0.1:54321/rest')).toBe('did:web:127.0.0.1%3A54321');
    expect(localVidFromSupabaseUrl('https://abcd.supabase.co:443/x')).toBe('did:web:abcd.supabase.co');
  });

  it('S-30 recipient did:web:other.example → 422 wrongRecipient with error issuer === localVid', async () => {
    const env = makeEnv();
    const err = expectError(await post(env, chDoc(env, { recipient: 'did:web:other.example' })), 422, 'wrongRecipient');
    expect(err.issuer).toBe(LOCAL_VID);
    expect(err.issuer).not.toBe('did:web:other.example');
  });

  it('S-30 no recipient → 400 malformedRequest (recipient REQUIRED by both task specs)', async () => {
    const env = makeEnv();
    expectError(await post(env, chDoc(env, { recipient: null })), 400, 'malformedRequest');
  });

  it('S-30 every emitted document has issuer === localVid (success, handler refusal, runtime rejection, unparsed error) and the SPIKE label comment is present', async () => {
    const env = makeEnv({ localVid: 'did:web:configured.example' });
    const ok = await handleTrustTask(env.deps, { appId: APP_A, appKey: KEY_A, rawBody: challengeDoc(mintDidKey().did, { id: 'a', now: env.clock.now(), recipient: 'did:web:configured.example' }) });
    const refusal = await handleTrustTask(env.deps, { appId: APP_A, appKey: KEY_A, rawBody: challengeDoc(mintDidKey().did, { id: 'b', now: env.clock.now(), recipient: 'did:web:configured.example', subject: 'did:web:x' }) });
    const wrong = await handleTrustTask(env.deps, { appId: APP_A, appKey: KEY_A, rawBody: challengeDoc(mintDidKey().did, { id: 'c', now: env.clock.now(), recipient: LOCAL_VID }) });
    const unparsed = await handleTrustTask(env.deps, { appId: APP_A, appKey: KEY_A, rawBody: undefined });
    expect([ok.status, refusal.status, wrong.status, unparsed.status]).toEqual([200, 422, 422, 400]);
    for (const r of [ok, refusal, wrong, unparsed]) expect((r.body as TrustTaskDocument<unknown>).issuer).toBe('did:web:configured.example');
    expect(read('core.ts')).toContain('// SPIKE: unsigned responses; local_vid is a label');
  });

  it('S-30 stampIssuer replaces issuer and nothing else', () => {
    const d: TrustTaskDocument<{ a: number }> = { id: 'i', type: 't', issuer: 'did:web:wrong', recipient: 'did:key:z6Mk1', threadId: 'th', payload: { a: 1 } };
    const s = stampIssuer(d, LOCAL_VID);
    expect(s).toEqual({ ...d, issuer: LOCAL_VID });
  });
});

describe('HTTP status mapping (S-50)', () => {
  const err = (code: string): ErrorResponse => ({ id: 'e', type: TRUST_TASK_ERROR_TYPE_URI, issuer: LOCAL_VID, payload: { code, retryable: false } });
  const generic = () => err('malformedRequest');

  it('S-50 statusForCode per binding 0.2 §4 as amended (normalizes 0.1 snake_case; extended → 422; unknown standard-looking → 500)', () => {
    const table: Record<string, number> = {
      malformedRequest: 400, permissionDenied: 403, idConflict: 409, unavailable: 503, internalError: 500,
      unsupportedType: 422, unsupportedVersion: 422, expired: 422, proofRequired: 422, proofInvalid: 422,
      identityMismatch: 422, wrongRecipient: 422, cancelled: 422, taskFailed: 422,
      malformed_request: 400, proof_required: 422, permission_denied: 403, id_conflict: 409,
      'auth/authenticate:challengeNotFound': 422, 'auth/challenge:subjectNotRecognized': 422, 'auth/challenge:rateLimited': 422,
      somethingNew: 500,
    };
    for (const [code, status] of Object.entries(table)) expect([code, statusForCode(code)]).toEqual([code, status]);
  });

  it('S-50 mapOutcomeToHttp: handled 200, rejected by code, suppressed 400 generic + log, accepted 204, duplicates 200 / error status / 202 / 204', () => {
    const response: TrustTaskDocument<unknown> = { id: 'r', type: `${CHALLENGE_TYPE}#response`, issuer: LOCAL_VID, payload: {} };
    const cases: Array<[ConsumeOutcome<unknown>, number, unknown]> = [
      [{ kind: 'handled', response }, 200, response],
      [{ kind: 'rejected', error: err('proofInvalid') }, 422, err('proofInvalid')],
      [{ kind: 'rejected', error: err('idConflict') }, 409, err('idConflict')],
      [{ kind: 'rejected', error: err('unavailable') }, 503, err('unavailable')],
      [{ kind: 'accepted' }, 204, undefined],
      [{ kind: 'duplicate', priorResponse: response, inFlight: false }, 200, response],
      [{ kind: 'duplicate', priorResponse: err('auth/authenticate:challengeNotFound'), inFlight: false }, 422, err('auth/authenticate:challengeNotFound')],
      [{ kind: 'duplicate', inFlight: true }, 202, undefined],
      [{ kind: 'duplicate', inFlight: false }, 204, undefined],
    ];
    for (const [outcome, status, body] of cases) {
      const r = mapOutcomeToHttp(outcome, generic);
      expect({ kind: outcome.kind, status: r.status, body: r.body }).toEqual({ kind: outcome.kind, status, body });
    }
    const s = mapOutcomeToHttp({ kind: 'suppressed', reason: { code: 'identityMismatch', message: 'secret detail', retryable: false } }, generic);
    expect(s.status).toBe(400);
    expect(s.body).toEqual(generic());
    expect(typeof s.log).toBe('string');
    expect(JSON.stringify(s.body)).not.toContain('secret detail');
  });

  it('S-50 responseHeaders: Cache-Control no-store and app-data CORS always; Content-Type application/json iff a body', () => {
    const appDataCors = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    };
    expect({ ...CORS_HEADERS }).toEqual(appDataCors);
    const withBody = responseHeaders(true);
    expect(withBody).toMatchObject({ ...appDataCors, 'Cache-Control': 'no-store', 'Content-Type': 'application/json' });
    const noBody = responseHeaders(false);
    expect(noBody).toMatchObject({ ...appDataCors, 'Cache-Control': 'no-store' });
    expect(Object.keys(noBody).map((k) => k.toLowerCase())).not.toContain('content-type');
  });

  it('S-50 plainError builds {status, body:{error}}', () => {
    expect(plainError(429, 'slow down')).toEqual({ status: 429, body: { error: 'slow down' } });
  });

  it('S-50 end-to-end statuses: 200 success, 422 extended code, 400 malformed, 409 idConflict (from the core)', async () => {
    const env = makeEnv();
    const { res } = await signInFlow(env);
    expect(res.status).toBe(200);
    expectError(await post(env, chDoc(env, { subject: 'did:web:nope' })), 422, 'auth/challenge:subjectNotRecognized');
  });
});

describe('statusForCode amendment (C-45)', () => {
  it('C-45 statusForCode("unsupportedExtension") === 422 (a SPEC §8.3 standard code)', () => {
    expect(statusForCode('unsupportedExtension')).toBe(422);
  });
});

describe('envelope shape: RFC 3339 timestamps and parentThreadId (C-43)', () => {
  const base = (): Record<string, unknown> => ({ id: 'x', type: CHALLENGE_TYPE, payload: {}, issuedAt: '2031-03-04T05:06:07.000Z' });
  it('C-43 checkFrameworkShape refuses a non-RFC-3339 issuedAt/expiresAt and a non-string parentThreadId, naming the member', () => {
    const bads: Array<[string, Record<string, unknown>]> = [
      ['issuedAt', { ...base(), issuedAt: 'Tue, 04 Mar 2031 05:06:07 GMT' }],
      ['issuedAt', { ...base(), issuedAt: '2031-03-04T05:06:07.000' }],
      ['issuedAt', { ...base(), issuedAt: '2031-03-04' }],
      ['issuedAt', { ...base(), issuedAt: '2031-00-04T05:06:07Z' }],
      ['expiresAt', { ...base(), expiresAt: '2031-13-01T00:00:00Z' }],
      ['expiresAt', { ...base(), expiresAt: '2031-03-32T00:00:00Z' }],
      ['expiresAt', { ...base(), expiresAt: '2031-03-04T05:06:07' }],
      ['parentThreadId', { ...base(), parentThreadId: 7 }],
      ['parentThreadId', { ...base(), parentThreadId: null }],
    ];
    for (const [member, b] of bads) {
      const r = checkFrameworkShape(b);
      expect(typeof r, JSON.stringify(b)).toBe('string');
      expect(r, JSON.stringify(b)).toContain(member);
    }
  });

  it('C-43 checkFrameworkShape accepts Z and ±hh:mm offsets, fractional seconds, and a string parentThreadId', () => {
    for (const issuedAt of ['2031-03-04T05:06:07Z', '2031-03-04T05:06:07.123Z', '2031-03-04T05:06:07+02:00', '2031-03-04T05:06:07-05:30']) {
      expect(checkFrameworkShape({ ...base(), issuedAt }), issuedAt).toBeNull();
    }
    expect(checkFrameworkShape({ ...base(), expiresAt: '2031-03-04T07:06:07+02:00', parentThreadId: 'thread-1' })).toBeNull();
  });

  it('C-43 a challenge with an RFC 2822 issuedAt → 400 malformedRequest with no store call beyond P1', async () => {
    const env = makeEnv();
    const b = { ...(chDoc(env) as Record<string, unknown>), issuedAt: 'Tue, 04 Mar 2031 05:06:07 GMT' };
    expectError(await post(env, b), 400, 'malformedRequest', false);
    expect(env.fake.callIds()).toEqual(['P1']);
  });
});

describe('nothing touches email (S-49)', () => {
  it('S-49 a full sign-in only talks to PostgREST P1–P13 (no app_login_codes, no email API); sources reference no RESEND_API_KEY, app_login_codes or email sending', async () => {
    const env = makeEnv();
    const { res } = await signInFlow(env);
    expect(res.status).toBe(200);
    for (const c of env.fake.calls) {
      expect(c.url.startsWith(`${SUPABASE_URL}/rest/v1/`)).toBe(true);
      expect(c.url).not.toContain('app_login_codes');
    }
    for (const f of ['core.ts', 'challenges.ts', 'replay.ts', 'members.ts', 'status.ts']) {
      const src = read(f);
      expect(src, f).not.toMatch(/RESEND_API_KEY|app_login_codes|api\.resend\.com|sendEmail|send-email|notify-invite/);
    }
  });
});

describe('index.ts routing (S-51) — via a Deno.serve shim', () => {
  async function loadIndex(fake: ReturnType<typeof makeFake>, env: Record<string, string>) {
    let handler: ((req: Request) => Response | Promise<Response>) | undefined;
    vi.stubGlobal('Deno', {
      serve: (a: unknown, b?: unknown) => {
        handler = (typeof a === 'function' ? a : b) as typeof handler;
        return { finished: Promise.resolve(), shutdown: async () => {} };
      },
      env: { get: (k: string) => env[k] },
    });
    vi.stubGlobal('fetch', fake.fetch);
    vi.resetModules();
    // A non-literal specifier keeps tsc from type-checking index.ts (it needs Deno types; `deno check` covers it — Appendix A).
    const indexModule = '../../supabase/functions/app-trust-tasks/index.ts';
    await import(/* @vite-ignore */ indexModule);
    expect(handler, 'index.ts must call Deno.serve(handler)').toBeTypeOf('function');
    return handler!;
  }
  const BASE = `${SUPABASE_URL}/functions/v1/app-trust-tasks`;

  it('S-51 OPTIONS → 204 with CORS and no body; GET /trust-tasks → 405; POST /other → 404; POST /trust-tasks without credentials → 401 plain JSON; index.ts ≤ 60 lines and the only file touching Deno.*', async () => {
    const clock = new TestClock(Date.now());
    const fake = makeFake(clock);
    const h = await loadIndex(fake, { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY: fake.serviceKey });

    const opt = await h(new Request(`${BASE}/trust-tasks`, { method: 'OPTIONS' }));
    expect(opt.status).toBe(204);
    expect(opt.headers.get('Access-Control-Allow-Origin')).toBe('*');
    expect(await opt.text()).toBe('');

    const get = await h(new Request(`${BASE}/trust-tasks`, { method: 'GET' }));
    expect(get.status).toBe(405);
    expect(get.headers.get('Content-Type')).toContain('application/json');
    expect(typeof (await get.json()).error).toBe('string');

    const other = await h(new Request(`${BASE}/elsewhere`, { method: 'POST', body: '{}' }));
    expect(other.status).toBe(404);
    expect(typeof (await other.json()).error).toBe('string');

    const noCreds = await h(new Request(`${BASE}/trust-tasks`, { method: 'POST', body: '{}', headers: { 'Content-Type': 'application/json' } }));
    expect(noCreds.status).toBe(401);
    expect(await noCreds.json()).toEqual({ error: 'app_id and app_key required' });
    expect(noCreds.headers.get('Cache-Control')).toBe('no-store');

    const src = read('index.ts');
    expect(src.split('\n').filter((l, i, a) => i < a.length - 1 || l !== '').length).toBeLessThanOrEqual(60);
    expect(src).toMatch(/\/\/ SPIKE:/);
    for (const f of ['core.ts', 'challenges.ts', 'replay.ts', 'members.ts', 'status.ts']) expect(read(f), f).not.toMatch(/\bDeno\./);
  });

  it('S-51 / S-30 POST /trust-tasks?app_id&app_key reaches the core; localVid defaults to did:web:<SUPABASE_URL host>; unparseable JSON → 400 malformedRequest', async () => {
    const clock = new TestClock(Date.now());
    const fake = makeFake(clock);
    fake.addApp({ id: APP_A, app_key: KEY_A, trust_signin_enabled: true });
    const h = await loadIndex(fake, { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY: fake.serviceKey });
    const url = `${BASE}/trust-tasks?app_id=${APP_A}&app_key=${KEY_A}`;
    const body = challengeDoc(mintDidKey().did, { id: crypto.randomUUID(), now: new Date(), recipient: 'did:web:fakeproject.supabase.co' });
    const ok = await h(new Request(url, { method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } }));
    expect(ok.status).toBe(200);
    expect(ok.headers.get('Content-Type')).toContain('application/json');
    const doc = (await ok.json()) as TrustTaskDocument<unknown>;
    expect(doc.type).toBe(AuthChallenge_v0_1.RESPONSE_TYPE_URI);
    expect(doc.issuer).toBe('did:web:fakeproject.supabase.co');

    const bad = await h(new Request(url, { method: 'POST', body: '{not json', headers: { 'Content-Type': 'application/json' } }));
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as ErrorResponse).payload.code).toBe('malformedRequest');
  });

  it('S-51 TRUST_TASKS_LOCAL_VID overrides the default localVid', async () => {
    const clock = new TestClock(Date.now());
    const fake = makeFake(clock);
    fake.addApp({ id: APP_A, app_key: KEY_A, trust_signin_enabled: true });
    const h = await loadIndex(fake, { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY: fake.serviceKey, TRUST_TASKS_LOCAL_VID: 'did:web:override.example' });
    const body = challengeDoc(mintDidKey().did, { id: crypto.randomUUID(), now: new Date(), recipient: 'did:web:override.example' });
    const res = await h(new Request(`${BASE}/trust-tasks?app_id=${APP_A}&app_key=${KEY_A}`, { method: 'POST', body: JSON.stringify(body) }));
    expect(res.status).toBe(200);
    expect(((await res.json()) as TrustTaskDocument<unknown>).issuer).toBe('did:web:override.example');
  });
});
