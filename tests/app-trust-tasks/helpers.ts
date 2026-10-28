/**
 * Shared test scaffolding: a controllable clock, a CoreDeps builder wired to
 * the fake PostgREST, and the challenge → authenticate flow.
 *
 * The clock starts in 2031 on purpose: any module that reads the real clock
 * (`Date.now()`, `new Date()`) instead of `deps.now` sees documents dated six
 * years in the future and refuses them, so the S-42 clock seam is exercised
 * by every test.
 */
import { afterEach, expect } from 'vitest';
import { TRUST_TASK_ERROR_TYPE_URI, type TrustTaskDocument } from '@openvtc/trust-tasks';
import { handleTrustTask, type CoreDeps, type CoreResponse, type RateLimiter } from '../../supabase/functions/app-trust-tasks/core.ts';
import { FakePostgrest } from './fake-postgrest.ts';
import { authenticateDoc, challengeDoc, mintDidKey, type AuthenticateDocOptions, type TestIdentity } from './producer.ts';

export const T0 = Date.parse('2031-03-04T05:06:07.000Z');
export const SUPABASE_URL = 'https://fakeproject.supabase.co';
export const LOCAL_VID = 'did:web:fakeproject.supabase.co';
export const APP_A = '11111111-1111-4111-8111-111111111111';
export const APP_B = '22222222-2222-4222-8222-222222222222';
export const APP_OFF = '33333333-3333-4333-8333-333333333333';
export const KEY_A = 'key-a-secret';
export const KEY_B = 'key-b-secret';
export const KEY_OFF = 'key-off-secret';

export class TestClock {
  ms: number;
  constructor(start = T0) {
    this.ms = start;
  }
  now = (): Date => new Date(this.ms);
  advance(ms: number): void {
    this.ms += ms;
  }
  iso(offsetMs = 0): string {
    return new Date(this.ms + offsetMs).toISOString();
  }
}

/** A limiter that never limits but records every hit. */
export class RecordingLimiter implements RateLimiter {
  hits: Array<{ appId: string; nowMs: number }> = [];
  limited = false;
  hit(appId: string, nowMs: number): boolean {
    this.hits.push({ appId, nowMs });
    return this.limited;
  }
}

let uuidCounter = 0;
export function seqUuid(): string {
  uuidCounter += 1;
  const hex = uuidCounter.toString(16).padStart(12, '0');
  return `aaaaaaaa-bbbb-4ccc-8ddd-${hex}`;
}

export interface Env {
  fake: FakePostgrest;
  clock: TestClock;
  limiter: RecordingLimiter;
  deps: CoreDeps;
  logs: Array<{ event: string; detail?: Record<string, unknown> }>;
}

const liveFakes: FakePostgrest[] = [];
afterEach(() => {
  // S-12: no suite may issue a PostgREST call outside DESIGN §3.
  const fakes = liveFakes.splice(0);
  for (const f of fakes) expect(f.violations, 'fake-postgrest contract violations (S-12)').toEqual([]);
});

export function makeFake(clock: TestClock): FakePostgrest {
  const fake = new FakePostgrest({ supabaseUrl: SUPABASE_URL, now: clock.now });
  liveFakes.push(fake);
  return fake;
}

export function makeEnv(overrides: Partial<CoreDeps> = {}): Env {
  const clock = new TestClock();
  const fake = makeFake(clock);
  fake.addApp({ id: APP_A, app_key: KEY_A, trust_signin_enabled: true });
  fake.addApp({ id: APP_B, app_key: KEY_B, trust_signin_enabled: true });
  fake.addApp({ id: APP_OFF, app_key: KEY_OFF, trust_signin_enabled: false });
  const limiter = new RecordingLimiter();
  const logs: Env['logs'] = [];
  const deps: CoreDeps = {
    ...fake.deps(),
    now: clock.now,
    localVid: LOCAL_VID,
    rateLimiter: limiter,
    log: (event, detail) => logs.push({ event, detail }),
    ...overrides,
  };
  return { fake, clock, limiter, deps, logs };
}

/** Let fire-and-forget work (P4, P8) settle. Not a timer wait. */
export async function settle(): Promise<void> {
  for (let i = 0; i < 3; i++) await new Promise<void>((r) => setImmediate(r));
}

export async function post(env: Env, rawBody: unknown, appId = APP_A, appKey = KEY_A): Promise<CoreResponse> {
  const res = await handleTrustTask(env.deps, { appId, appKey, rawBody });
  await settle();
  return res;
}

export type ErrorDoc = TrustTaskDocument<{ code: string; message?: string; retryable: boolean; inResponseTo?: { typeUri: string; id?: string } }>;

export function asError(res: CoreResponse): ErrorDoc {
  const body = res.body as ErrorDoc;
  expect(body, 'expected a trust-task-error body').toBeTruthy();
  expect(body.type).toBe(TRUST_TASK_ERROR_TYPE_URI);
  expect(body.issuer, 'every emitted document has issuer === localVid (S-30)').toBe(LOCAL_VID);
  return body;
}

export function expectError(res: CoreResponse, status: number, code: string, retryable?: boolean): ErrorDoc {
  expect({ status: res.status, code: (res.body as ErrorDoc | undefined)?.payload?.code }).toEqual({ status, code });
  const err = asError(res);
  if (retryable !== undefined) expect(err.payload.retryable).toBe(retryable);
  return err;
}

export interface ChallengeResult {
  challenge: string;
  sessionId: string;
  expiresAt: string;
  response: CoreResponse;
}

export async function getChallenge(
  env: Env,
  identity: TestIdentity,
  opts: { subject?: string | null; appId?: string; appKey?: string } = {},
): Promise<ChallengeResult> {
  const doc = challengeDoc(identity.did, { id: crypto.randomUUID(), now: env.clock.now(), recipient: LOCAL_VID, subject: opts.subject });
  const response = await post(env, doc, opts.appId ?? APP_A, opts.appKey ?? KEY_A);
  expect(response.status, `challenge failed: ${JSON.stringify(response.body)}`).toBe(200);
  const p = (response.body as TrustTaskDocument<{ challenge: string; sessionId: string; expiresAt: string }>).payload;
  return { ...p, response };
}

export function authDoc(env: Env, identity: TestIdentity, ch: { challenge: string; sessionId: string }, o: Partial<AuthenticateDocOptions> = {}) {
  return authenticateDoc(identity, {
    id: crypto.randomUUID(),
    now: env.clock.now(),
    recipient: LOCAL_VID,
    challenge: ch.challenge,
    sessionId: ch.sessionId,
    ...o,
  });
}

/** Full producer flow: mint (or reuse) a did:key, challenge, authenticate. */
export async function signInFlow(env: Env, identity: TestIdentity = mintDidKey(), opts: { appId?: string; appKey?: string } = {}) {
  const ch = await getChallenge(env, identity, opts);
  const doc = authDoc(env, identity, ch);
  const res = await post(env, doc, opts.appId ?? APP_A, opts.appKey ?? KEY_A);
  return { identity, ch, doc, res };
}

/** Await a promise expected to reject, and return the error — failing if it was the stub's "not implemented". */
export async function rejectionOf(p: Promise<unknown> | (() => Promise<unknown>)): Promise<unknown> {
  const promise = typeof p === 'function' ? p() : p;
  const outcome = await promise.then(
    () => ({ rejected: false as const }),
    (e: unknown) => ({ rejected: true as const, e }),
  );
  expect(outcome.rejected, 'expected a rejection').toBe(true);
  const e = outcome.rejected ? outcome.e : undefined;
  expect(String((e as Error)?.message ?? e)).not.toMatch(/not implemented/i);
  return e;
}

/** Call `fn`, expect it to throw, and return the error — failing if it was the stub's "not implemented". */
export function thrownBy(fn: () => unknown): unknown {
  let threw = false;
  let err: unknown;
  try {
    fn();
  } catch (e) {
    threw = true;
    err = e;
  }
  expect(threw, 'expected a throw').toBe(true);
  expect(String((err as Error)?.message ?? err)).not.toMatch(/not implemented/i);
  return err;
}
