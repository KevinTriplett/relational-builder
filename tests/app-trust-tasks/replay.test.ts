import { describe, expect, it } from 'vitest';
import {
  CONSEQUENTIAL_FRESHNESS,
  DEFAULT_SKEW_MS,
  UnauthenticatedTransport,
  TRUST_TASK_ERROR_TYPE_URI,
  consumeInbound,
  documentDigest,
  respondWith,
  type ReplayGuard,
  type TrustTaskDocument,
} from '@openvtc/trust-tasks';
import { DEFAULT_RETENTION_PAD_MS, PostgresReplayGuard } from '../../supabase/functions/app-trust-tasks/replay.ts';
// C-60 adds the COMPLETED_RECORD export; read through the namespace so this file type-checks before and after it exists.
import * as replayModule from '../../supabase/functions/app-trust-tasks/replay.ts';
import { APP_A, APP_B, TestClock, authDoc, getChallenge, makeEnv, makeFake, post, rejectionOf, settle } from './helpers.ts';
import { mintDidKey } from './producer.ts';
import type { ReplayRow } from './fake-postgrest.ts';

function setup(appId = APP_A, retentionPadMs?: number) {
  const clock = new TestClock();
  const fake = makeFake(clock);
  const guard = new PostgresReplayGuard({ ...fake.deps(), appId, ...(retentionPadMs === undefined ? {} : { retentionPadMs }) });
  return { clock, fake, guard };
}
function guardFor(fake: ReturnType<typeof makeFake>, appId: string) {
  return new PostgresReplayGuard({ ...fake.deps(), appId });
}

const ID = 'doc-0001';
const D1 = 'a'.repeat(64);
const D2 = 'b'.repeat(64);

describe('PostgresReplayGuard.claim (S-22)', () => {
  it('S-22 fresh: P5 inserts {doc_id, app_id, digest, response:null, until_at = retainUntil + 60 000}, then fires P8 (until_at=lt.now)', async () => {
    const { clock, fake, guard } = setup();
    const retainUntil = clock.ms + 300_000;
    expect(DEFAULT_RETENTION_PAD_MS).toBe(DEFAULT_SKEW_MS);
    expect(await guard.claim(ID, D1, retainUntil, clock.ms)).toEqual({ kind: 'fresh' });
    await settle();
    expect(fake.callIds()).toEqual(['P5', 'P8']);
    expect(fake.callsOf('P5')[0].body).toEqual({
      doc_id: ID, app_id: APP_A, digest: D1, response: null, until_at: new Date(retainUntil + 60_000).toISOString(),
    });
    expect(fake.callsOf('P8')[0].query).toEqual({ until_at: `lt.${new Date(clock.ms).toISOString()}` });
    expect(fake.tables.app_tt_replay).toEqual([
      { doc_id: ID, app_id: APP_A, digest: D1, response: null, until_at: new Date(retainUntil + 60_000).toISOString() },
    ]);
  });

  it('S-22 retentionPadMs is configurable (0 → until_at = retainUntil)', async () => {
    const { clock, fake, guard } = setup(APP_A, 0);
    await guard.claim(ID, D1, clock.ms + 1000, clock.ms);
    expect(fake.tables.app_tt_replay[0].until_at).toBe(new Date(clock.ms + 1000).toISOString());
  });

  it('S-22 P8 failure is ignored (still fresh)', async () => {
    const { clock, fake, guard } = setup();
    fake.failAll('P8', 'reject');
    expect(await guard.claim(ID, D1, clock.ms + 1000, clock.ms)).toEqual({ kind: 'fresh' });
    await settle();
  });

  it('S-22 retainUntil undefined makes claim throw, without writing a record', async () => {
    const { clock, fake, guard } = setup();
    await rejectionOf(Promise.resolve().then(() => guard.claim(ID, D1, undefined, clock.ms)));
    expect(fake.callsOf('P5')).toHaveLength(0);
    expect(fake.tables.app_tt_replay).toHaveLength(0);
  });

  it('S-22 same id + same digest while in flight → duplicate {inFlight:true}, no priorResponse (P5 409 → P6)', async () => {
    const { clock, fake, guard } = setup();
    await guard.claim(ID, D1, clock.ms + 300_000, clock.ms);
    const v = await guard.claim(ID, D1, clock.ms + 300_000, clock.ms);
    expect(v).toMatchObject({ kind: 'duplicate', inFlight: true });
    expect((v as { priorResponse?: unknown }).priorResponse).toBeUndefined();
    expect(fake.callsOf('P5').map((c) => c.status)).toEqual([201, 409]);
    expect(fake.callsOf('P6')).toHaveLength(1);
  });

  it('S-22 / C-60 after recordResponse (P9) of a success, P9 stores {completed:true} and a duplicate is {inFlight:false} with no priorResponse', async () => {
    const { clock, fake, guard } = setup();
    const response = { id: 'r1', type: 'x#response', payload: { tokens: { accessToken: 'T' } } };
    await guard.claim(ID, D1, clock.ms + 300_000, clock.ms);
    await guard.recordResponse(ID, response);
    expect(fake.callsOf('P9')[0].query).toEqual({ doc_id: `eq.${ID}`, app_id: `eq.${APP_A}` });
    expect(fake.callsOf('P9')[0].body).toEqual({ response: { completed: true } });
    const v = await guard.claim(ID, D1, clock.ms + 300_000, clock.ms);
    expect(v).toEqual({ kind: 'duplicate', inFlight: false });
    expect(v).not.toHaveProperty('priorResponse');
  });

  it('S-22 same id + different digest → conflict', async () => {
    const { clock, guard } = setup();
    await guard.claim(ID, D1, clock.ms + 300_000, clock.ms);
    expect(await guard.claim(ID, D2, clock.ms + 300_000, clock.ms)).toEqual({ kind: 'conflict' });
  });

  it('S-22 an expired record (until_at ≤ now) is deleted (P7, until_at=lte.now) and the claim retried once → fresh', async () => {
    const { clock, fake, guard } = setup();
    fake.tables.app_tt_replay.push({ doc_id: ID, app_id: APP_A, digest: D2, response: { old: true }, until_at: new Date(clock.ms).toISOString() });
    expect(await guard.claim(ID, D1, clock.ms + 300_000, clock.ms)).toEqual({ kind: 'fresh' });
    await settle();
    expect(fake.callIds().slice(0, 4)).toEqual(['P5', 'P6', 'P7', 'P5']);
    expect(fake.callsOf('P7')[0].query).toEqual({ doc_id: `eq.${ID}`, until_at: `lte.${new Date(clock.ms).toISOString()}` });
    expect(fake.tables.app_tt_replay).toEqual([
      { doc_id: ID, app_id: APP_A, digest: D1, response: null, until_at: new Date(clock.ms + 360_000).toISOString() },
    ]);
  });

  it('S-22 a raced delete (P5 409, P6 []) retries the insert once → fresh', async () => {
    const { clock, fake, guard } = setup();
    fake.script('P5', 409);
    expect(await guard.claim(ID, D1, clock.ms + 300_000, clock.ms)).toEqual({ kind: 'fresh' });
    expect(fake.callIds().slice(0, 3)).toEqual(['P5', 'P6', 'P5']);
  });

  it('S-22 a second failed retry throws', async () => {
    const { clock, fake, guard } = setup();
    fake.script('P5', 409, 409, 409);
    await rejectionOf(Promise.resolve().then(() => guard.claim(ID, D1, clock.ms + 300_000, clock.ms)));
    expect(fake.callsOf('P5').length).toBeGreaterThanOrEqual(2);
    expect(fake.callsOf('P5').length).toBeLessThanOrEqual(3);
  });

  it('S-22 store unreachable → claim throws (fail closed): rejected fetch, 503 on insert, 503 on read', async () => {
    for (const [call, fault] of [['P5', 'reject'], ['P5', 503], ['P5', 500]] as const) {
      const { clock, fake, guard } = setup();
      fake.failAll(call, fault);
      await rejectionOf(Promise.resolve().then(() => guard.claim(ID, D1, clock.ms + 300_000, clock.ms)));
    }
    const { clock, fake, guard } = setup();
    await guard.claim(ID, D1, clock.ms + 300_000, clock.ms);
    fake.failAll('P6', 503);
    await rejectionOf(Promise.resolve().then(() => guard.claim(ID, D1, clock.ms + 300_000, clock.ms)));
  });

  it('S-22 recordResponse throws on a non-2xx answer', async () => {
    const { clock, fake, guard } = setup();
    await guard.claim(ID, D1, clock.ms + 300_000, clock.ms);
    fake.failAll('P9', 503);
    await rejectionOf(Promise.resolve().then(() => guard.recordResponse(ID, { r: 1 })));
  });

  it('S-22 release (P10) deletes only an in-flight record with this app, id and digest', async () => {
    const { clock, fake, guard } = setup();
    await guard.claim(ID, D1, clock.ms + 300_000, clock.ms);
    await guard.release(ID, D2);
    expect(fake.tables.app_tt_replay).toHaveLength(1);
    await guard.release(ID, D1);
    expect(fake.callsOf('P10').at(-1)!.query).toEqual({ doc_id: `eq.${ID}`, app_id: `eq.${APP_A}`, digest: `eq.${D1}`, response: 'is.null' });
    expect(fake.tables.app_tt_replay).toHaveLength(0);
    // A completed record (response set) is never released.
    await guard.claim('doc-2', D1, clock.ms + 300_000, clock.ms);
    await guard.recordResponse('doc-2', { done: true });
    await guard.release('doc-2', D1);
    expect(fake.tables.app_tt_replay.map((r) => r.doc_id)).toEqual(['doc-2']);
  });

  it('S-22 / C-60 PostgresReplayGuard is a ReplayGuard the runtime can drive: consumeInbound executes once, then answers the duplicate {inFlight:false} with no retained response', async () => {
    const { clock, fake, guard } = setup();
    const g: ReplayGuard = guard;
    const doc: TrustTaskDocument<{ n: number }> = {
      id: 'urn:uuid:replay-runtime', type: 'https://example.org/spec/x/0.1', issuer: 'did:example:p', recipient: 'did:example:me',
      issuedAt: clock.now().toISOString(), payload: { n: 1 },
    };
    let executions = 0;
    const run = () =>
      consumeInbound<{ n: number }, { ok: boolean }>({
        transport: new UnauthenticatedTransport(),
        spec: { typeUri: doc.type, isBearer: false, isProofRequired: false, isRecipientRequired: true, isIssuedAtRequired: true },
        proofPolicy: { kind: 'acceptUnverified' },
        payloadPolicy: { kind: 'acceptUnvalidated' },
        checks: { freshness: CONSEQUENTIAL_FRESHNESS, replay: { kind: 'guard', guard: g } },
        doc,
        myVid: 'did:example:me',
        now: clock.ms,
        newErrorId: () => crypto.randomUUID(),
        clock: () => clock.now().toISOString(),
        handler: (d) => {
          executions += 1;
          return respondWith(d, 'resp-1', { ok: true }, () => clock.now().toISOString());
        },
      });
    const first = await run();
    expect(first.kind).toBe('handled');
    const second = await run();
    expect(second).toMatchObject({ kind: 'duplicate', inFlight: false });
    expect((second as { priorResponse?: unknown }).priorResponse).toBeUndefined();
    expect(executions).toBe(1);
    // retainUntil from the runtime (issuedAt + maxAgeMs) plus the pad.
    expect(fake.tables.app_tt_replay[0].until_at).toBe(new Date(clock.ms + 300_000 + 60_000).toISOString());
    // S-11: keyed on the document id; digest is the whole-document digest.
    expect(fake.tables.app_tt_replay[0].doc_id).toBe(doc.id);
    expect(fake.tables.app_tt_replay[0].digest).toBe(documentDigest(doc));
  });
});

describe('the guard never retains a success response (C-60)', () => {
  const errorDoc = {
    id: 'err-1', type: TRUST_TASK_ERROR_TYPE_URI, issuer: 'did:web:fakeproject.supabase.co', recipient: 'did:key:z6MkP', threadId: ID,
    payload: { code: 'auth/authenticate:challengeNotFound', retryable: false, message: 'Challenge not found' },
  };
  const successDoc = (token: string) => ({
    id: 'resp-1', type: 'https://trusttasks.org/spec/auth/authenticate/0.3#response', issuer: 'did:web:fakeproject.supabase.co', threadId: ID,
    payload: { session: { id: 'sess-1', subject: 'did:key:z6MkP' }, tokens: { accessToken: token, tokenType: 'Bearer', expiresIn: 60 } },
  });

  it('C-60 a trust-task-error document is stored verbatim by P9 and replayed as priorResponse (inFlight:false)', async () => {
    const { clock, fake, guard } = setup();
    await guard.claim(ID, D1, clock.ms + 300_000, clock.ms);
    await guard.recordResponse(ID, errorDoc);
    expect(fake.callsOf('P9')[0].body).toEqual({ response: errorDoc });
    expect(fake.tables.app_tt_replay[0].response).toEqual(errorDoc);
    expect(await guard.claim(ID, D1, clock.ms + 300_000, clock.ms)).toEqual({ kind: 'duplicate', inFlight: false, priorResponse: errorDoc });
  });

  it('C-60 a seeded pre-C-60 row holding a full success #response → duplicate {inFlight:false} with no priorResponse property', async () => {
    const { clock, fake, guard } = setup();
    const token = 'f'.repeat(64);
    fake.tables.app_tt_replay.push({ doc_id: ID, app_id: APP_A, digest: D1, response: successDoc(token), until_at: new Date(clock.ms + 300_000).toISOString() });
    const v = await guard.claim(ID, D1, clock.ms + 300_000, clock.ms);
    expect(v).toEqual({ kind: 'duplicate', inFlight: false });
    expect(v).not.toHaveProperty('priorResponse');
    expect(JSON.stringify(v)).not.toContain(token);
  });

  it('C-60 replay.ts exports COMPLETED_RECORD = {completed:true}, frozen', () => {
    const rec = (replayModule as Record<string, unknown>).COMPLETED_RECORD;
    expect(rec).toEqual({ completed: true });
    expect(Object.isFrozen(rec)).toBe(true);
  });

  it('C-60 P9\'s request body never contains the success token (one attempt, and the C-40 retry)', async () => {
    const token = 'c'.repeat(64);
    for (const faults of [[], [503]] as const) {
      const { clock, fake, guard } = setup();
      await guard.claim(ID, D1, clock.ms + 300_000, clock.ms);
      if (faults.length) fake.script('P9', ...faults);
      await guard.recordResponse(ID, successDoc(token));
      const p9 = fake.callsOf('P9');
      expect(p9, String(faults)).toHaveLength(1 + faults.length);
      for (const call of p9) {
        expect(call.body).toEqual({ response: { completed: true } });
        expect(JSON.stringify(call.body)).not.toContain(token);
      }
      expect(JSON.stringify(fake.tables.app_tt_replay)).not.toContain(token);
    }
  });
});

describe('PostgresReplayGuard is app-scoped (S-24)', () => {
  it('S-24 a record written by app A, offered under app B with the same id and digest, is conflict — never A\'s retained response', async () => {
    const { clock, fake, guard: a } = setup(APP_A);
    const b = guardFor(fake, APP_B);
    const response = { payload: { tokens: { accessToken: 'secret-token-of-A' } } };
    await a.claim(ID, D1, clock.ms + 300_000, clock.ms);
    await a.recordResponse(ID, response);
    const v = await b.claim(ID, D1, clock.ms + 300_000, clock.ms);
    expect(v).toEqual({ kind: 'conflict' });
    expect(JSON.stringify(v)).not.toContain('secret-token-of-A');
  });

  it('S-24 app B\'s recordResponse and release do not touch app A\'s record', async () => {
    const { clock, fake, guard: a } = setup(APP_A);
    const b = guardFor(fake, APP_B);
    await a.claim(ID, D1, clock.ms + 300_000, clock.ms);
    await b.recordResponse(ID, { hijack: true });
    await b.release(ID, D1);
    const rec = fake.tables.app_tt_replay.find((r: ReplayRow) => r.doc_id === ID);
    expect(rec).toMatchObject({ app_id: APP_A, response: null });
    expect(fake.callsOf('P9')[0].query.app_id).toBe(`eq.${APP_B}`);
    expect(fake.callsOf('P10')[0].query.app_id).toBe(`eq.${APP_B}`);
  });
});

// C-39 / C-40 add optional ReplayGuardDeps members (acceptanceWindowMs, log). They are passed
// through a variable, not an object literal, so this file type-checks before and after they exist.
function guardWith(extra: { acceptanceWindowMs?: number; log?: (event: string, detail?: Record<string, unknown>) => void }) {
  const clock = new TestClock();
  const fake = makeFake(clock);
  const deps = { ...fake.deps(), appId: APP_A, ...extra };
  return { clock, fake, guard: new PostgresReplayGuard(deps) };
}

describe('replay retention is capped at the acceptance window (C-39)', () => {
  const YEAR_9999 = Date.parse('9999-12-31T23:59:59Z');

  it('C-39 oracle 1: claim with retainUntil in year 9999 and now = N writes until_at = ISO(N + 300 000 + 120 000)', async () => {
    const { clock, fake, guard } = guardWith({});
    expect(await guard.claim(ID, D1, YEAR_9999, clock.ms)).toEqual({ kind: 'fresh' });
    await settle();
    expect(fake.callsOf('P5')[0].body).toMatchObject({ until_at: new Date(clock.ms + 420_000).toISOString() });
    expect(fake.tables.app_tt_replay[0].until_at).toBe(new Date(clock.ms + 420_000).toISOString());
  });

  it('C-39 oracle 4: acceptanceWindowMs 10 000 → the cap is now + 130 000', async () => {
    const { clock, fake, guard } = guardWith({ acceptanceWindowMs: 10_000 });
    await guard.claim(ID, D1, clock.ms + 300_000, clock.ms);
    expect(fake.tables.app_tt_replay[0].until_at).toBe(new Date(clock.ms + 130_000).toISOString());
    // Below the cap, retainUntil + pad still wins.
    await guard.claim('doc-2', D1, clock.ms + 10_000, clock.ms);
    expect(fake.tables.app_tt_replay.find((r) => r.doc_id === 'doc-2')!.until_at).toBe(new Date(clock.ms + 70_000).toISOString());
  });

  it('C-39 the cap uses claim\'s now argument, not a clock: a claim with now = N + 1 000 caps at N + 1 000 + 420 000', async () => {
    const { clock, fake, guard } = guardWith({});
    await guard.claim(ID, D1, YEAR_9999, clock.ms + 1_000);
    expect(fake.tables.app_tt_replay[0].until_at).toBe(new Date(clock.ms + 1_000 + 420_000).toISOString());
  });
});

describe('release is total; recordResponse retries once (C-40)', () => {
  it('C-40 oracle 2: release with a rejecting fetch (P10) resolves and logs replay.release_failed once, naming no id or digest', async () => {
    const logs: Array<{ event: string; detail?: Record<string, unknown> }> = [];
    const { clock, fake, guard } = guardWith({ log: (event, detail) => void logs.push({ event, detail }) });
    await guard.claim(ID, D1, clock.ms + 300_000, clock.ms);
    fake.failAll('P10', 'reject');
    await expect(guard.release(ID, D1)).resolves.toBeUndefined();
    expect(fake.callsOf('P10')).toHaveLength(1);
    expect(logs.filter((l) => l.event === 'replay.release_failed')).toHaveLength(1);
    expect(JSON.stringify(logs)).not.toContain(ID);
    expect(JSON.stringify(logs)).not.toContain(D1);
  });

  it('C-40 release answered 503 by P10 resolves and logs replay.release_failed once (P10 issued at most once)', async () => {
    const logs: Array<{ event: string; detail?: Record<string, unknown> }> = [];
    const { clock, fake, guard } = guardWith({ log: (event, detail) => void logs.push({ event, detail }) });
    await guard.claim(ID, D1, clock.ms + 300_000, clock.ms);
    fake.failAll('P10', 503);
    await expect(guard.release(ID, D1)).resolves.toBeUndefined();
    expect(fake.callsOf('P10')).toHaveLength(1);
    expect(logs.filter((l) => l.event === 'replay.release_failed')).toHaveLength(1);
  });

  it('C-40 release without a log dep still resolves on a rejecting fetch', async () => {
    const { clock, fake, guard } = guardWith({});
    await guard.claim(ID, D1, clock.ms + 300_000, clock.ms);
    fake.failAll('P10', 'reject');
    await expect(guard.release(ID, D1)).resolves.toBeUndefined();
  });

  it('C-40 / C-60 recordResponse: P9 failing once (503 or rejected) is retried once and the response is stored (a success as {completed:true})', async () => {
    for (const fault of [503, 'reject'] as const) {
      const { clock, fake, guard } = guardWith({});
      await guard.claim(ID, D1, clock.ms + 300_000, clock.ms);
      fake.script('P9', fault);
      await expect(guard.recordResponse(ID, { done: true })).resolves.toBeUndefined();
      expect(fake.callsOf('P9'), String(fault)).toHaveLength(2);
      expect(fake.tables.app_tt_replay[0].response).toEqual({ completed: true });
    }
  });

  it('C-40 recordResponse: P9 failing twice throws after exactly two attempts', async () => {
    const { clock, fake, guard } = guardWith({});
    await guard.claim(ID, D1, clock.ms + 300_000, clock.ms);
    fake.script('P9', 503, 'reject');
    await rejectionOf(Promise.resolve().then(() => guard.recordResponse(ID, { r: 1 })));
    expect(fake.callsOf('P9')).toHaveLength(2);
  });
});

describe('a twice-failed recordResponse is logged (C-59)', () => {
  type LogEntry = { event: string; detail?: Record<string, unknown> };

  it('C-59 recordResponse failing twice logs replay.record_failed exactly once, {failure} only ("HTTP <status>" / "fetch rejected"), naming no id or digest, then throws', async () => {
    for (const [faults, failure] of [[[503, 503], 'HTTP 503'], [[503, 'reject'], 'fetch rejected']] as const) {
      const logs: LogEntry[] = [];
      const { clock, fake, guard } = guardWith({ log: (event, detail) => void logs.push({ event, detail }) });
      await guard.claim(ID, D1, clock.ms + 300_000, clock.ms);
      fake.script('P9', ...faults);
      await rejectionOf(Promise.resolve().then(() => guard.recordResponse(ID, { r: 1 })));
      expect(fake.callsOf('P9')).toHaveLength(2);
      const failed = logs.filter((l) => l.event === 'replay.record_failed');
      expect(failed, String(faults)).toHaveLength(1);
      expect(failed[0].detail).toEqual({ failure });
      expect(JSON.stringify(logs)).not.toContain(ID);
      expect(JSON.stringify(logs)).not.toContain(D1);
    }
  });

  it('C-59 recordResponse failing once logs nothing', async () => {
    const logs: LogEntry[] = [];
    const { clock, fake, guard } = guardWith({ log: (event, detail) => void logs.push({ event, detail }) });
    await guard.claim(ID, D1, clock.ms + 300_000, clock.ms);
    fake.script('P9', 503);
    await expect(guard.recordResponse(ID, { r: 1 })).resolves.toBeUndefined();
    expect(logs.filter((l) => l.event === 'replay.record_failed')).toHaveLength(0);
  });

  it('C-59 a throwing log sink is swallowed: recordResponse still throws its own error, and the sink was called', async () => {
    let calls = 0;
    const { clock, fake, guard } = guardWith({ log: (event) => { if (event === 'replay.record_failed') calls += 1; throw new Error('sink exploded'); } });
    await guard.claim(ID, D1, clock.ms + 300_000, clock.ms);
    fake.script('P9', 503, 'reject');
    const e = await rejectionOf(Promise.resolve().then(() => guard.recordResponse(ID, { r: 1 })));
    expect(String((e as Error)?.message ?? e)).not.toContain('sink exploded');
    expect(calls).toBe(1);
  });

  it('C-59 end to end: P9 failing twice → log called exactly once with replay.record_failed (no document id, no digest); the first answer is still 200; the identical resend gets 202', async () => {
    const env = makeEnv();
    const id = mintDidKey();
    const c = await getChallenge(env, id);
    env.fake.script('P9', 503, 'reject');
    const d = authDoc(env, id, c);
    const first = await post(env, d);
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    const failed = env.logs.filter((l) => l.event === 'replay.record_failed');
    expect(failed).toHaveLength(1);
    const detail = JSON.stringify(failed[0].detail ?? {});
    expect(detail).not.toContain(d.id);
    expect(detail).not.toContain(documentDigest(d));
    expect((await post(env, d)).status).toBe(202);
    expect(env.logs.filter((l) => l.event === 'replay.record_failed')).toHaveLength(1);
  });
});
