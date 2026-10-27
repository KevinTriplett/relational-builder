import { describe, expect, it } from 'vitest';
import { PostgresChallengeStore, generateChallenge } from '../../supabase/functions/app-trust-tasks/challenges.ts';
import { APP_A, APP_B, TestClock, makeFake, rejectionOf, settle } from './helpers.ts';
import type { ChallengeRow } from './fake-postgrest.ts';

const B64URL_43 = /^[A-Za-z0-9_-]{43}$/;

function setup(opts: { uuids?: string[]; bytes?: Uint8Array } = {}) {
  const clock = new TestClock();
  const fake = makeFake(clock);
  const uuids = [...(opts.uuids ?? [])];
  const byteCalls: number[] = [];
  const store = new PostgresChallengeStore({
    ...fake.deps(),
    now: clock.now,
    randomUUID: () => uuids.shift() ?? crypto.randomUUID(),
    randomBytes: (n: number) => {
      byteCalls.push(n);
      return opts.bytes ? opts.bytes.slice(0, n) : crypto.getRandomValues(new Uint8Array(n));
    },
  });
  return { clock, fake, store, byteCalls };
}

function row(over: Partial<ChallengeRow>): ChallengeRow {
  return {
    session_id: crypto.randomUUID(), app_id: APP_A, subject: null, challenge: 'c'.repeat(43),
    expires_at: new Date(Date.UTC(2031, 0, 1)).toISOString(), consumed_at: null, created_at: new Date(0).toISOString(), ...over,
  };
}

const FIXED = new Uint8Array(32).map((_, i) => i * 7 + 3);
const FIXED_B64URL = Buffer.from(FIXED).toString('base64url');

describe('PostgresChallengeStore.issue (S-20)', () => {
  it('S-20 issue inserts one row (P2) and returns {sessionId = randomUUID(), challenge = 32 random bytes base64url, expiresAt = now + ttl}', async () => {
    const sid = '0f0f0f0f-0000-4000-8000-000000000001';
    const { clock, fake, store, byteCalls } = setup({ uuids: [sid], bytes: FIXED });
    const out = await store.issue({ appId: APP_A, subject: 'did:key:z6MkTest', ttlMs: 120_000 });
    expect(out.sessionId).toBe(sid);
    expect(out.challenge).toBe(FIXED_B64URL);
    expect(out.challenge).toMatch(B64URL_43);
    expect(byteCalls).toEqual([32]);
    expect(out.expiresAt).toBeInstanceOf(Date);
    expect(out.expiresAt.getTime()).toBe(clock.ms + 120_000);
    expect(fake.callIds()).toEqual(['P2']);
    expect(fake.callsOf('P2')[0].body).toEqual({
      session_id: sid, app_id: APP_A, subject: 'did:key:z6MkTest', challenge: FIXED_B64URL, expires_at: new Date(clock.ms + 120_000).toISOString(),
    });
    expect(fake.tables.app_tt_challenges).toHaveLength(1);
    expect(fake.tables.app_tt_challenges[0]).toMatchObject({ session_id: sid, consumed_at: null });
  });

  it('S-20 issue without a subject stores subject null', async () => {
    const { fake, store } = setup();
    await store.issue({ appId: APP_A, ttlMs: 60_000 });
    expect(fake.tables.app_tt_challenges[0].subject).toBeNull();
    expect(fake.callsOf('P2')[0].body).toHaveProperty('subject', null);
  });

  it('S-20 generateChallenge is 32 bytes → base64url without padding (43 chars, ≥128 bits)', () => {
    const calls: number[] = [];
    const c = generateChallenge((n) => {
      calls.push(n);
      return FIXED.slice(0, n);
    });
    expect(c).toBe(FIXED_B64URL);
    expect(c).not.toContain('=');
    expect(calls).toEqual([32]);
    const r1 = generateChallenge();
    const r2 = generateChallenge();
    expect(r1).toMatch(B64URL_43);
    expect(r1).not.toBe(r2);
  });

  it('S-20 a duplicate session_id (409) is retried once with a fresh uuid', async () => {
    const dup = '0f0f0f0f-0000-4000-8000-00000000000d';
    const fresh = '0f0f0f0f-0000-4000-8000-00000000000e';
    const { fake, store } = setup({ uuids: [dup, fresh] });
    fake.tables.app_tt_challenges.push(row({ session_id: dup }));
    const out = await store.issue({ appId: APP_A, ttlMs: 60_000 });
    expect(out.sessionId).toBe(fresh);
    expect(fake.callsOf('P2').map((c) => c.status)).toEqual([409, 201]);
  });

  it('S-20 a second duplicate session_id makes issue throw (after exactly two inserts)', async () => {
    const d1 = '0f0f0f0f-0000-4000-8000-0000000000d1';
    const d2 = '0f0f0f0f-0000-4000-8000-0000000000d2';
    const { fake, store } = setup({ uuids: [d1, d2] });
    fake.tables.app_tt_challenges.push(row({ session_id: d1 }), row({ session_id: d2 }));
    await rejectionOf(store.issue({ appId: APP_A, ttlMs: 60_000 }));
    expect(fake.callsOf('P2').map((c) => c.status)).toEqual([409, 409]);
  });

  it('S-20 issue throws when fetch rejects or PostgREST answers 503 (S-21 store-failure rule)', async () => {
    const a = setup();
    a.fake.failAll('P2', 'reject');
    await rejectionOf(a.store.issue({ appId: APP_A, ttlMs: 60_000 }));
    expect(a.fake.callsOf('P2')).toHaveLength(1);
    const b = setup();
    b.fake.failAll('P2', 503);
    await rejectionOf(b.store.issue({ appId: APP_A, ttlMs: 60_000 }));
    expect(b.fake.callsOf('P2')).toHaveLength(1);
    expect(b.fake.tables.app_tt_challenges).toHaveLength(0);
  });
});

describe('PostgresChallengeStore.lookupAndConsume (S-21)', () => {
  it('S-21 ok: one PATCH (P3) with session_id/app_id/consumed_at=is.null and Prefer return=representation; row consumed at now', async () => {
    const { clock, fake, store } = setup();
    const issued = await store.issue({ appId: APP_A, subject: 'did:key:z6MkSubj', ttlMs: 120_000 });
    const before = fake.calls.length;
    const res = await store.lookupAndConsume({ appId: APP_A, sessionId: issued.sessionId, now: clock.now() });
    expect(res).toEqual({ kind: 'ok', challenge: issued.challenge, subject: 'did:key:z6MkSubj' });
    const after = fake.calls.slice(before);
    expect(after.map((c) => c.id)).toEqual(['P3']);
    expect(after[0].query).toMatchObject({ session_id: `eq.${issued.sessionId}`, app_id: `eq.${APP_A}`, consumed_at: 'is.null' });
    expect(after[0].body).toEqual({ consumed_at: clock.now().toISOString() });
    expect(fake.tables.app_tt_challenges[0].consumed_at).toBe(clock.now().toISOString());
  });

  it('S-21 subject null round-trips as null', async () => {
    const { clock, store } = setup();
    const issued = await store.issue({ appId: APP_A, ttlMs: 120_000 });
    expect(await store.lookupAndConsume({ appId: APP_A, sessionId: issued.sessionId, now: clock.now() })).toEqual({
      kind: 'ok', challenge: issued.challenge, subject: null,
    });
  });

  it('S-21 already consumed → notFound; never issued → notFound', async () => {
    const { clock, store } = setup();
    const issued = await store.issue({ appId: APP_A, ttlMs: 120_000 });
    expect((await store.lookupAndConsume({ appId: APP_A, sessionId: issued.sessionId, now: clock.now() })).kind).toBe('ok');
    expect(await store.lookupAndConsume({ appId: APP_A, sessionId: issued.sessionId, now: clock.now() })).toEqual({ kind: 'notFound' });
    expect(await store.lookupAndConsume({ appId: APP_A, sessionId: crypto.randomUUID(), now: clock.now() })).toEqual({ kind: 'notFound' });
  });

  it('S-21 expires_at < now → expired, the row stays consumed, and a second attempt is notFound', async () => {
    const { clock, fake, store } = setup();
    const issued = await store.issue({ appId: APP_A, ttlMs: 30_000 });
    clock.advance(30_001);
    expect(await store.lookupAndConsume({ appId: APP_A, sessionId: issued.sessionId, now: clock.now() })).toEqual({ kind: 'expired' });
    expect(fake.tables.app_tt_challenges[0].consumed_at).not.toBeNull();
    expect(await store.lookupAndConsume({ appId: APP_A, sessionId: issued.sessionId, now: clock.now() })).toEqual({ kind: 'notFound' });
  });

  it('S-21 expires_at exactly equal to now is still ok (strictly "expires_at < now" expires)', async () => {
    const { clock, store } = setup();
    const issued = await store.issue({ appId: APP_A, ttlMs: 30_000 });
    clock.advance(30_000);
    expect((await store.lookupAndConsume({ appId: APP_A, sessionId: issued.sessionId, now: clock.now() })).kind).toBe('ok');
  });

  it('S-21 rows for another app_id are invisible and left unconsumed', async () => {
    const { clock, fake, store } = setup();
    const issued = await store.issue({ appId: APP_A, ttlMs: 120_000 });
    expect(await store.lookupAndConsume({ appId: APP_B, sessionId: issued.sessionId, now: clock.now() })).toEqual({ kind: 'notFound' });
    expect(fake.tables.app_tt_challenges[0].consumed_at).toBeNull();
  });

  it('S-21 two concurrent lookupAndConsume for the same id → exactly one ok, the other notFound', async () => {
    const { clock, store } = setup();
    const issued = await store.issue({ appId: APP_A, ttlMs: 120_000 });
    const results = await Promise.all([
      store.lookupAndConsume({ appId: APP_A, sessionId: issued.sessionId, now: clock.now() }),
      store.lookupAndConsume({ appId: APP_A, sessionId: issued.sessionId, now: clock.now() }),
    ]);
    expect(results.map((r) => r.kind).sort()).toEqual(['notFound', 'ok']);
  });

  it('S-21 the sessionId is URL-encoded; any string is a valid lookup key (unknown → notFound)', async () => {
    const { clock, fake, store } = setup();
    const weird = 'a+b&c=d#e/f?g h%20i,eq.x';
    fake.tables.app_tt_challenges.push(row({ session_id: weird, expires_at: new Date(clock.ms + 60_000).toISOString() }));
    const res = await store.lookupAndConsume({ appId: APP_A, sessionId: weird, now: clock.now() });
    expect(res).toEqual({ kind: 'ok', challenge: 'c'.repeat(43), subject: null });
    expect(fake.callsOf('P3')[0].query.session_id).toBe(`eq.${weird}`);
    expect(await store.lookupAndConsume({ appId: APP_A, sessionId: '', now: clock.now() })).toEqual({ kind: 'notFound' });
  });

  it('S-21 / S-12 an unknown sessionId containing + & = # (and a space) round-trips encoded → notFound, not a contract violation (C-36)', async () => {
    const { clock, fake, store } = setup();
    for (const sid of ['+&=#', 'a+b&c=d#e', ' +x']) {
      expect(await store.lookupAndConsume({ appId: APP_A, sessionId: sid, now: clock.now() })).toEqual({ kind: 'notFound' });
      expect(fake.callsOf('P3').at(-1)!.query.session_id).toBe(`eq.${sid}`);
    }
    expect(fake.violations).toEqual([]);
  });

  it('S-21 a rejected fetch or a non-2xx answer makes lookupAndConsume throw', async () => {
    for (const fault of ['reject', 503, 500] as const) {
      const { clock, fake, store } = setup();
      const issued = await store.issue({ appId: APP_A, ttlMs: 120_000 });
      fake.failAll('P3', fault);
      await rejectionOf(store.lookupAndConsume({ appId: APP_A, sessionId: issued.sessionId, now: clock.now() }));
      expect(fake.callsOf('P3')).toHaveLength(1);
    }
  });
});

describe('PostgresChallengeStore.sweep (S-23)', () => {
  it('S-23 sweep deletes challenges whose expires_at < now − 1h (P4) and keeps the rest', async () => {
    const { clock, fake, store } = setup();
    const cutoff = clock.ms - 3_600_000;
    fake.tables.app_tt_challenges.push(
      row({ session_id: 'old', expires_at: new Date(cutoff - 1).toISOString() }),
      row({ session_id: 'edge', expires_at: new Date(cutoff).toISOString() }),
      row({ session_id: 'recent', expires_at: new Date(cutoff + 1).toISOString() }),
    );
    await store.sweep();
    await settle();
    expect(fake.callsOf('P4')).toHaveLength(1);
    expect(fake.callsOf('P4')[0].query).toEqual({ expires_at: `lt.${new Date(cutoff).toISOString()}` });
    expect(fake.tables.app_tt_challenges.map((r) => r.session_id).sort()).toEqual(['edge', 'recent']);
  });

  it('S-23 sweep never throws, even when the store is unreachable', async () => {
    const { fake, store } = setup();
    fake.failAll('P4', 'reject');
    await expect(store.sweep()).resolves.toBeUndefined();
    const b = setup();
    b.fake.failAll('P4', 503);
    await expect(b.store.sweep()).resolves.toBeUndefined();
    expect(fake.callsOf('P4').length + b.fake.callsOf('P4').length).toBe(2);
  });
});
