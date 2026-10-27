/**
 * S-12: the fake models exactly DESIGN.md §3 and throws on anything else.
 * These are self-tests of the test fixture (they pass independently of the
 * implementation); the S-12 requirement on the *function* is enforced by the
 * afterEach in helpers.ts, which fails any suite whose code under test made
 * an unmodelled call — and by the integration test at the end of this file.
 */
import { describe, expect, it } from 'vitest';
import { FakeContractError, FakePostgrest } from './fake-postgrest.ts';
import { APP_A, makeEnv, signInFlow } from './helpers.ts';

function fake() {
  return new FakePostgrest({ now: () => new Date(0) });
}
async function violation(p: Promise<unknown>): Promise<string> {
  const e = await p.then(() => null, (x: unknown) => x);
  expect(e).toBeInstanceOf(FakeContractError);
  return (e as Error).message;
}

describe('fake PostgREST contract (S-12)', () => {
  it('S-12 fixture: unmodelled path, method, operator, select column, header and Prefer value all throw and are recorded', async () => {
    const f = fake();
    const h = f.svcHeaders();
    await violation(f.fetch(f.restUrl('/app_documents?id=eq.1'), { headers: h }));
    await violation(f.fetch(f.restUrl('/cloud_apps?id=eq.1&select=id,app_key,trust_signin_enabled'), { method: 'PUT', headers: h }));
    await violation(f.fetch(f.restUrl('/app_tt_challenges?expires_at=gt.2031-01-01T00:00:00.000Z'), { method: 'DELETE', headers: h }));
    await violation(f.fetch(f.restUrl('/cloud_apps?id=eq.1&select=*'), { headers: h }));
    await violation(f.fetch(f.restUrl(`/cloud_apps?id=eq.${APP_A}&select=id,app_key,trust_signin_enabled`), { headers: { ...h, 'X-Client-Info': 'x' } }));
    await violation(f.fetch(f.restUrl('/app_tt_replay'), { method: 'POST', headers: { ...h, Prefer: 'return=headers-only' }, body: '{}' }));
    await violation(f.fetch(f.restUrl('/app_tt_challenges?expires_at=lt.2031-01-01T00:00:00.000Z&order=expires_at.asc'), { method: 'DELETE', headers: h }));
    await violation(f.fetch('https://api.resend.com/emails', { method: 'POST', headers: h, body: '{}' }));
    expect(f.violations).toHaveLength(8);
    f.violations.length = 0;
  });

  it('S-12 fixture: unique violations answer 409 {code:"23505"}; fault injection rejects or answers 503', async () => {
    const f = fake();
    const h = { ...f.svcHeaders(), Prefer: 'return=minimal' };
    const body = JSON.stringify({ doc_id: 'd', app_id: APP_A, digest: 'x', response: null, until_at: new Date(0).toISOString() });
    expect((await f.fetch(f.restUrl('/app_tt_replay'), { method: 'POST', headers: h, body })).status).toBe(201);
    const dup = await f.fetch(f.restUrl('/app_tt_replay'), { method: 'POST', headers: h, body });
    expect(dup.status).toBe(409);
    expect((await dup.json()).code).toBe('23505');
    f.failAll('P5', 503);
    expect((await f.fetch(f.restUrl('/app_tt_replay'), { method: 'POST', headers: h, body })).status).toBe(503);
    f.failAll('P5', 'reject');
    const e = await f.fetch(f.restUrl('/app_tt_replay'), { method: 'POST', headers: h, body }).then(() => null, (x: unknown) => x);
    expect(e).toBeInstanceOf(TypeError);
    expect(f.violations).toEqual([]);
  });

  it('S-12 a full sign-in, a replay and a refusal issue only P1–P13 calls with the modelled shapes', async () => {
    const env = makeEnv();
    const { doc, res } = await signInFlow(env);
    expect(res.status).toBe(200);
    await signInFlow(env);
    const again = await import('./helpers.ts').then((m) => m.post(env, doc));
    expect(again.status).toBe(200);
    expect(env.fake.violations).toEqual([]);
    expect(new Set(env.fake.callIds())).toEqual(new Set(['P1', 'P2', 'P3', 'P4', 'P5', 'P6', 'P8', 'P9', 'P11', 'P12', 'P13']));
  });
});
