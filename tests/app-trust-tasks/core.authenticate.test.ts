import { describe, expect, it } from 'vitest';
import {
  AuthAuthenticate_v0_3,
  CONSEQUENTIAL_FRESHNESS,
  ISSUED_AT_REQUIRED,
  PROOF_INVALID_WIRE_MESSAGE,
  documentDigest,
  type ReplayGuard,
  type TrustTaskDocument,
} from '@openvtc/trust-tasks';
import {
  AUTHENTICATE_TYPE,
  CODES,
  DEFAULT_ACCEPTANCE_WINDOW_MS,
  DEFAULT_SESSION_TTL_MS,
  EXT_NAMESPACE,
  PurposeCheckingVerifier,
  SIGNING_PROOF_PURPOSES,
  authenticateChecks,
  constantTimeEqual,
  subsetSchemaValidator,
} from '../../supabase/functions/app-trust-tasks/core.ts';
import {
  APP_A, APP_B, KEY_B, LOCAL_VID, authDoc, expectError, getChallenge, makeEnv, post, signInFlow, type Env,
} from './helpers.ts';
import { signTrustTask, signerFromPrivateKey } from '@openvtc/trust-tasks-proof';
import { fixedSeed, mintDidKey, signAs, unsignedAuthenticateDoc, type TestIdentity } from './producer.ts';

interface AuthResponsePayload {
  session: { id: string; subject: string; issuedAt: string; expiresAt: string; amr?: string[]; acr?: string; actor?: string };
  tokens: { accessToken: string; tokenType: string; expiresIn: number; scope?: string[]; refreshToken?: string };
  ext?: Record<string, { member: { id: string; did: string; name: string | null; email: null } }>;
}
type AuthResponse = TrustTaskDocument<AuthResponsePayload>;

function validates(schema: unknown, payload: unknown): boolean {
  const r = subsetSchemaValidator.validate(schema, payload);
  return typeof r === 'boolean' ? r : r.ok;
}

function sessionCount(env: Env) {
  return env.fake.tables.app_sessions.length;
}

describe('authenticate success and session minting (S-47)', () => {
  it('S-47 full producer flow with a fresh did:key → 200 #response with session + TokenBundle + ext member; one member row (did, email null), one session row whose token is the accessToken', async () => {
    const env = makeEnv();
    const { identity, doc, res } = await signInFlow(env);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const body = res.body as AuthResponse;
    expect(body.type).toBe(AuthAuthenticate_v0_3.RESPONSE_TYPE_URI);
    expect(body.issuer).toBe(LOCAL_VID);
    expect(body.recipient).toBe(identity.did);
    expect(body.threadId).toBe(doc.id);
    expect(body.issuedAt).toBe(env.clock.now().toISOString());
    expect(body.proof, 'Increment 1 responses are unsigned (recorded deviation)').toBeUndefined();

    const now = env.clock.ms;
    const { session, tokens, ext } = body.payload;
    expect(session).toEqual({
      id: session.id,
      subject: identity.did,
      issuedAt: new Date(now).toISOString(),
      expiresAt: new Date(now + DEFAULT_SESSION_TTL_MS).toISOString(),
      amr: ['did'],
      acr: 'aal1',
    });
    expect(session.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    expect(tokens).toEqual({ accessToken: tokens.accessToken, tokenType: 'Bearer', expiresIn: 30 * 24 * 3600 });
    expect(tokens.accessToken).toMatch(/^[0-9a-f]{64}$/);
    expect(session.id).not.toBe(tokens.accessToken);
    expect(tokens.accessToken).not.toContain(session.id.replace(/-/g, ''));
    expect(session.id.replace(/-/g, '')).not.toBe(tokens.accessToken.slice(0, 32));
    expect(session.id.replace(/-/g, '')).not.toBe(tokens.accessToken.slice(32));

    expect(env.fake.tables.app_members).toHaveLength(1);
    const member = env.fake.tables.app_members[0];
    expect(member).toMatchObject({ app_id: APP_A, did: identity.did, email: null, name: null });
    expect(ext).toEqual({ [EXT_NAMESPACE]: { member: { id: member.id, did: identity.did, name: null, email: null } } });
    expect(EXT_NAMESPACE).toBe('org.relationalbuilder.cloud');

    expect(env.fake.tables.app_sessions).toEqual([
      { token: tokens.accessToken, app_id: APP_A, member_id: member.id, expires_at: new Date(now + DEFAULT_SESSION_TTL_MS).toISOString() },
    ]);
  });

  it('S-47 the response payload validates against AuthAuthenticate_v0_3.RESPONSE_SPEC.payloadSchema', async () => {
    const env = makeEnv();
    const { res } = await signInFlow(env);
    expect(validates(AuthAuthenticate_v0_3.RESPONSE_SPEC.payloadSchema, (res.body as AuthResponse).payload)).toBe(true);
  });

  it('S-47 a second sign-in by the same did:key → a second session row, no second member row', async () => {
    const env = makeEnv();
    const identity = mintDidKey();
    const a = await signInFlow(env, identity);
    const b = await signInFlow(env, identity);
    expect([a.res.status, b.res.status]).toEqual([200, 200]);
    expect(env.fake.tables.app_members).toHaveLength(1);
    expect(env.fake.tables.app_sessions).toHaveLength(2);
    const ta = (a.res.body as AuthResponse).payload.tokens.accessToken;
    const tb = (b.res.body as AuthResponse).payload.tokens.accessToken;
    expect(ta).not.toBe(tb);
    expect((b.res.body as AuthResponse).payload.ext?.[EXT_NAMESPACE].member.id).toBe(env.fake.tables.app_members[0].id);
  });

  it('S-47 members use P11 then P12, sessions P13 (and the claim P5 / record P9)', async () => {
    const env2 = makeEnv();
    const identity = mintDidKey();
    const c = await getChallenge(env2, identity);
    const start = env2.fake.calls.length;
    const res = await post(env2, authDoc(env2, identity, c));
    expect(res.status).toBe(200);
    const ids = env2.fake.calls.slice(start).map((x) => x.id).filter((x) => x !== 'P8');
    expect(ids).toEqual(['P1', 'P5', 'P3', 'P11', 'P12', 'P13', 'P9']);
  });

  it('S-47 a P12 unique-violation race (409) re-reads the member with P11 and still succeeds with one member row', async () => {
    const env = makeEnv();
    const identity = mintDidKey();
    const c = await getChallenge(env, identity);
    const racedId = crypto.randomUUID();
    env.fake.before('P12', () => {
      env.fake.tables.app_members.push({ id: racedId, app_id: APP_A, email: null, name: null, did: identity.did, created_at: env.clock.iso() });
    });
    const res = await post(env, authDoc(env, identity, c));
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(env.fake.tables.app_members).toHaveLength(1);
    expect(env.fake.tables.app_sessions[0].member_id).toBe(racedId);
    expect(env.fake.callsOf('P12').map((x) => x.status)).toEqual([409]);
    expect(env.fake.callsOf('P11')).toHaveLength(2);
  });

  it('S-47 memberTokenFactory and sessionTtlMs are honoured (expiresIn = round(ttl/1000))', async () => {
    const env = makeEnv({ memberTokenFactory: () => 'f'.repeat(64), sessionTtlMs: 3_600_400 });
    const { res } = await signInFlow(env);
    const p = (res.body as AuthResponse).payload;
    expect(p.tokens.accessToken).toBe('f'.repeat(64));
    expect(p.tokens.expiresIn).toBe(3600);
    expect(p.session.expiresAt).toBe(new Date(env.clock.ms + 3_600_400).toISOString());
    expect(env.fake.tables.app_sessions[0].token).toBe('f'.repeat(64));
  });

  it('S-47 a store failure while minting (P12 or P13) → 503 unavailable, retryable', async () => {
    for (const call of ['P11', 'P12', 'P13'] as const) {
      const env = makeEnv();
      const identity = mintDidKey();
      const c = await getChallenge(env, identity);
      env.fake.failAll(call, 'reject');
      expectError(await post(env, authDoc(env, identity, c)), 503, 'unavailable', true);
    }
  });

  it('S-44 / S-47 payload.scope is accepted but ignored: tokens.scope is omitted', async () => {
    const env = makeEnv();
    const identity = mintDidKey();
    const c = await getChallenge(env, identity);
    const res = await post(env, authDoc(env, identity, c, { extraPayload: { scope: ['admin', 'write'] } }));
    expect(res.status).toBe(200);
    expect((res.body as AuthResponse).payload.tokens).not.toHaveProperty('scope');
  });

  it('S-46 principal equal to issuer is the ordinary form → success, no session.actor', async () => {
    const env = makeEnv();
    const identity = mintDidKey();
    const c = await getChallenge(env, identity);
    const res = await post(env, authDoc(env, identity, c, { extraPayload: { principal: identity.did } }));
    expect(res.status).toBe(200);
    expect((res.body as AuthResponse).payload.session).not.toHaveProperty('actor');
    expect((res.body as AuthResponse).payload.session.subject).toBe(identity.did);
  });
});

describe('the consumeInbound pipeline for authenticate (S-42)', () => {
  it('S-42 a missing proof → 422 proofRequired; nothing claimed or consumed', async () => {
    const env = makeEnv();
    const identity = mintDidKey();
    const c = await getChallenge(env, identity);
    const start = env.fake.calls.length;
    expectError(await post(env, authDoc(env, identity, c, { unsigned: true })), 422, 'proofRequired');
    expect(env.fake.calls.slice(start).map((x) => x.id)).toEqual(['P1']);
  });

  it('S-42 a tampered document → 422 proofInvalid with the constant wire message; no claim (P5) and no consume (P3)', async () => {
    const env = makeEnv();
    const identity = mintDidKey();
    const c = await getChallenge(env, identity);
    const d = authDoc(env, identity, c);
    const tampered = { ...d, issuedAt: new Date(env.clock.ms - 1000).toISOString() };
    const start = env.fake.calls.length;
    const err = expectError(await post(env, tampered), 422, 'proofInvalid');
    expect(err.payload.message).toBe(PROOF_INVALID_WIRE_MESSAGE);
    expect(env.fake.calls.slice(start).map((x) => x.id)).toEqual(['P1']);
    expect(env.fake.tables.app_tt_challenges[0].consumed_at).toBeNull();
  });

  it('S-42 a proof by a different did:key than the issuer → 422 proofInvalid', async () => {
    const env = makeEnv();
    const identity = mintDidKey();
    const c = await getChallenge(env, identity);
    expectError(await post(env, authDoc(env, identity, c, { signWith: mintDidKey() })), 422, 'proofInvalid');
  });

  it('S-42 PurposeCheckingVerifier: proofPurpose keyAgreement → 422 proofInvalid; assertionMethod (a signing purpose) → 200', async () => {
    const env = makeEnv();
    const identity = mintDidKey();
    const c1 = await getChallenge(env, identity);
    expectError(await post(env, authDoc(env, identity, c1, { proofPurpose: 'keyAgreement' })), 422, 'proofInvalid');
    const c2 = await getChallenge(env, identity);
    expect((await post(env, authDoc(env, identity, c2, { proofPurpose: 'assertionMethod' }))).status).toBe(200);
  });

  it('S-42 PurposeCheckingVerifier unit: rejects purposes outside the list without consulting the inner verifier; delegates otherwise', async () => {
    let innerCalls = 0;
    const inner = { verify: () => { innerCalls += 1; return true; } };
    const v = new PurposeCheckingVerifier(inner);
    const base: TrustTaskDocument<object> = { id: 'x', type: 't', payload: {} };
    const withPurpose = (proofPurpose: string): TrustTaskDocument<object> => ({
      ...base, proof: { type: 'DataIntegrityProof', cryptosuite: 'eddsa-jcs-2022', verificationMethod: 'did:key:z#z', created: '2031-01-01T00:00:00Z', proofPurpose, proofValue: 'z1' },
    });
    expect(await v.verify(withPurpose('keyAgreement'))).toBe(false);
    expect(await v.verify(base)).toBe(false);
    expect(innerCalls).toBe(0);
    for (const p of ['authentication', 'assertionMethod', 'capabilityInvocation', 'capabilityDelegation']) {
      expect(SIGNING_PROOF_PURPOSES).toContain(p);
      expect(await v.verify(withPurpose(p))).toBe(true);
    }
    expect([...SIGNING_PROOF_PURPOSES].sort()).toEqual(['assertionMethod', 'authentication', 'capabilityDelegation', 'capabilityInvocation']);
    const narrow = new PurposeCheckingVerifier({ verify: () => false }, ['authentication']);
    expect(await narrow.verify(withPurpose('authentication'))).toBe(false);
    expect(await new PurposeCheckingVerifier(inner, ['authentication']).verify(withPurpose('assertionMethod'))).toBe(false);
  });

  it('S-42 a missing issuedAt → 400 malformedRequest with message ISSUED_AT_REQUIRED', async () => {
    const env = makeEnv();
    const identity = mintDidKey();
    const c = await getChallenge(env, identity);
    const err = expectError(await post(env, authDoc(env, identity, c, { omitIssuedAt: true })), 400, 'malformedRequest');
    expect(err.payload.message).toBe(ISSUED_AT_REQUIRED);
  });

  it('S-42 payload schema is checked first: an invalid payload with no proof → 400 malformedRequest (not proofRequired)', async () => {
    const env = makeEnv();
    const identity = mintDidKey();
    const c = await getChallenge(env, identity);
    const d = authDoc(env, identity, { challenge: 'short', sessionId: c.sessionId }, { unsigned: true });
    expectError(await post(env, d), 400, 'malformedRequest');
  });

  it('S-42 check order: a wrong recipient with no proof → wrongRecipient (recipient before proof)', async () => {
    const env = makeEnv();
    const identity = mintDidKey();
    const c = await getChallenge(env, identity);
    expectError(await post(env, authDoc(env, identity, c, { unsigned: true, recipient: 'did:web:other.example' })), 422, 'wrongRecipient');
  });

  it('S-42 clock seam: a proof created 2 min after deps.now is refused (every success test also signs at deps.now in 2031, which a real-clock verifier would refuse)', async () => {
    const env = makeEnv();
    const identity = mintDidKey();
    const c = await getChallenge(env, identity);
    expectError(await post(env, authDoc(env, identity, c, { created: new Date(env.clock.ms + 120_000) })), 422, 'proofInvalid');
  });

  it('S-42 authenticateChecks(guard, window) = {freshness: {...CONSEQUENTIAL_FRESHNESS, maxAgeMs: window}, replay: {kind:"guard", guard}}', () => {
    const guard: ReplayGuard = { claim: () => ({ kind: 'fresh' }) };
    const checks = authenticateChecks(guard, 123_456);
    expect(checks).toEqual({ freshness: { ...CONSEQUENTIAL_FRESHNESS, maxAgeMs: 123_456 }, replay: { kind: 'guard', guard } });
    expect(checks.replay.kind === 'guard' && checks.replay.guard).toBe(guard);
  });

  it('S-42 acceptanceWindowMs is honoured: with a 60 s window, a document issued 121 s ago → 422 expired', async () => {
    const env = makeEnv({ acceptanceWindowMs: 60_000 });
    const identity = mintDidKey();
    const c = await getChallenge(env, identity);
    const d = authDoc(env, identity, c, { issuedAt: new Date(env.clock.ms - 121_000).toISOString(), created: new Date(env.clock.ms - 121_000) });
    expectError(await post(env, d), 422, 'expired');
  });
});

describe('authenticate binding checks in spec order (S-44)', () => {
  it('S-44 an unknown sessionId → 422 auth/authenticate:challengeNotFound, retryable false', async () => {
    const env = makeEnv();
    const identity = mintDidKey();
    const d = authDoc(env, identity, { challenge: 'Z'.repeat(43), sessionId: crypto.randomUUID() });
    const err = expectError(await post(env, d), 422, CODES.challengeNotFound, false);
    expect(CODES.challengeNotFound).toBe('auth/authenticate:challengeNotFound');
    expect(err.recipient).toBe(identity.did);
    expect(err.threadId).toBe(d.id);
    expect(err.payload.inResponseTo).toEqual({ typeUri: AUTHENTICATE_TYPE, id: d.id });
  });

  it('S-44 / S-12 a sessionId containing + & = # → 422 challengeNotFound, with the filter value encoded exactly once (C-36)', async () => {
    const env = makeEnv();
    const identity = mintDidKey();
    expectError(await post(env, authDoc(env, identity, { challenge: 'Z'.repeat(43), sessionId: 'x+y&z=w#v' })), 422, 'auth/authenticate:challengeNotFound', false);
    expect(env.fake.callsOf('P3')[0].query.session_id).toBe('eq.x+y&z=w#v');
    expect(env.fake.violations).toEqual([]);
  });

  it('S-44 a challenge is single-use: a second (new) authenticate document for it → challengeNotFound', async () => {
    const env = makeEnv();
    const { identity, ch, res } = await signInFlow(env);
    expect(res.status).toBe(200);
    expectError(await post(env, authDoc(env, identity, ch)), 422, 'auth/authenticate:challengeNotFound', false);
    expect(sessionCount(env)).toBe(1);
  });

  it('S-44 an expired challenge → 422 challengeExpired (retryable true); the next attempt is challengeNotFound', async () => {
    const env = makeEnv();
    const identity = mintDidKey();
    const c = await getChallenge(env, identity);
    env.clock.advance(120_001);
    expectError(await post(env, authDoc(env, identity, c)), 422, 'auth/authenticate:challengeExpired', true);
    expectError(await post(env, authDoc(env, identity, c)), 422, 'auth/authenticate:challengeNotFound', false);
    expect(sessionCount(env)).toBe(0);
  });

  it('S-44 a wrong challenge value → 422 challengeMismatch (retryable false), and the challenge is burned (consume-before-compare)', async () => {
    const env = makeEnv();
    const identity = mintDidKey();
    const c = await getChallenge(env, identity);
    const wrong = (c.challenge[0] === 'A' ? 'B' : 'A') + c.challenge.slice(1);
    expectError(await post(env, authDoc(env, identity, { challenge: wrong, sessionId: c.sessionId })), 422, 'auth/authenticate:challengeMismatch', false);
    expectError(await post(env, authDoc(env, identity, c)), 422, 'auth/authenticate:challengeNotFound', false);
    expect(sessionCount(env)).toBe(0);
  });

  it('S-44 the challenge was bound to subject A; a document signed by B → 422 subjectMismatch', async () => {
    const env = makeEnv();
    const a = mintDidKey();
    const b = mintDidKey();
    const c = await getChallenge(env, a);
    expectError(await post(env, authDoc(env, b, c)), 422, 'auth/authenticate:subjectMismatch', false);
    expect(sessionCount(env)).toBe(0);
  });

  it('S-44 a subject-agnostic challenge can be completed by any did:key', async () => {
    const env = makeEnv();
    const c = await getChallenge(env, mintDidKey(), { subject: null });
    const other = mintDidKey();
    const res = await post(env, authDoc(env, other, c));
    expect(res.status).toBe(200);
    expect((res.body as AuthResponse).payload.session.subject).toBe(other.did);
  });

  it('S-44 first failure wins: expired AND mismatched → challengeExpired', async () => {
    const env = makeEnv();
    const identity = mintDidKey();
    const c = await getChallenge(env, identity);
    env.clock.advance(120_001);
    expectError(await post(env, authDoc(env, identity, { challenge: 'Q'.repeat(43), sessionId: c.sessionId })), 422, 'auth/authenticate:challengeExpired', true);
  });

  it('S-44 first failure wins: mismatched challenge AND wrong subject → challengeMismatch', async () => {
    const env = makeEnv();
    const c = await getChallenge(env, mintDidKey());
    expectError(await post(env, authDoc(env, mintDidKey(), { challenge: 'Q'.repeat(43), sessionId: c.sessionId })), 422, 'auth/authenticate:challengeMismatch', false);
  });

  it('S-44 the challenge store failing on lookup → 503 unavailable (retryable); the claim is released so an identical resend is re-executed', async () => {
    const env = makeEnv();
    const identity = mintDidKey();
    const c = await getChallenge(env, identity);
    const d = authDoc(env, identity, c);
    env.fake.failAll('P3', 'reject');
    expectError(await post(env, d), 503, 'unavailable', true);
    expect(env.fake.callsOf('P10')).toHaveLength(1);
    expect(env.fake.tables.app_tt_replay).toHaveLength(0);
    env.fake.failAll('P3', null);
    const again = await post(env, d);
    expect(again.status, JSON.stringify(again.body)).toBe(200);
  });

  it('S-44 a retryable refusal (challengeExpired) releases the claim: the identical resend is re-executed and gets challengeNotFound', async () => {
    const env = makeEnv();
    const identity = mintDidKey();
    const c = await getChallenge(env, identity);
    env.clock.advance(120_001);
    const d = authDoc(env, identity, c);
    expectError(await post(env, d), 422, 'auth/authenticate:challengeExpired', true);
    expectError(await post(env, d), 422, 'auth/authenticate:challengeNotFound', false);
  });

  it('S-44 refusal messages name no DID, challenge, sessionId or token', async () => {
    const env = makeEnv();
    const a = mintDidKey();
    const b = mintDidKey();
    const c1 = await getChallenge(env, a);
    const c2 = await getChallenge(env, a);
    const c3 = await getChallenge(env, a);
    const errs = [
      await post(env, authDoc(env, a, { challenge: 'Q'.repeat(43), sessionId: crypto.randomUUID() })),
      await post(env, authDoc(env, a, { challenge: 'Q'.repeat(43), sessionId: c1.sessionId })),
      await post(env, authDoc(env, b, c2)),
      await post(env, authDoc(env, a, c3, { extraPayload: { sessionKey: mintDidKey().did } })),
    ];
    for (const r of errs) {
      const msg = JSON.stringify((r.body as { payload: unknown }).payload);
      for (const secret of [a.did, b.did, c1.challenge, c1.sessionId, c2.challenge, c2.sessionId, c3.challenge, c3.sessionId]) {
        expect(msg).not.toContain(secret);
      }
      expect(r.status).toBe(422);
    }
  });

  it('S-44 constantTimeEqual: equal → true; differing, prefix, longer, empty → false', () => {
    expect(constantTimeEqual('abcdef', 'abcdef')).toBe(true);
    expect(constantTimeEqual('', '')).toBe(true);
    expect(constantTimeEqual('abcdef', 'abcdeg')).toBe(false);
    expect(constantTimeEqual('abc', 'abcdef')).toBe(false);
    expect(constantTimeEqual('abcdef', 'abc')).toBe(false);
    expect(constantTimeEqual('abc', '')).toBe(false);
    expect(constantTimeEqual('ÿ', 'y')).toBe(false);
  });
});

describe('sessionKey and proxied form refused in Increment 1 (S-45, S-46)', () => {
  it('S-45 payload.sessionKey present → 422 auth/authenticate:sessionKeyUnsupported (retryable false); challenge consumed; no session', async () => {
    const env = makeEnv();
    const identity = mintDidKey();
    const c = await getChallenge(env, identity);
    expectError(await post(env, authDoc(env, identity, c, { extraPayload: { sessionKey: mintDidKey().did } })), 422, CODES.sessionKeyUnsupported, false);
    expect(CODES.sessionKeyUnsupported).toBe('auth/authenticate:sessionKeyUnsupported');
    expect(env.fake.callsOf('P3')).toHaveLength(1);
    expect(env.fake.tables.app_tt_challenges[0].consumed_at).not.toBeNull();
    expect(sessionCount(env)).toBe(0);
    expect(env.fake.tables.app_members).toHaveLength(0);
  });

  it('S-46 principal ≠ issuer without delegationEvidence → 422 auth/authenticate:delegationEvidenceRequired; never a session for the principal', async () => {
    const env = makeEnv();
    const signer = mintDidKey();
    const principal = mintDidKey();
    const c = await getChallenge(env, signer, { subject: null });
    expectError(await post(env, authDoc(env, signer, c, { extraPayload: { principal: principal.did } })), 422, CODES.delegationEvidenceRequired, false);
    expect(sessionCount(env)).toBe(0);
    expect(env.fake.tables.app_members).toHaveLength(0);
  });

  it('S-46 principal ≠ issuer with delegationEvidence → 422 auth/authenticate:delegationNotRecognized', async () => {
    const env = makeEnv();
    const signer = mintDidKey();
    const principal = mintDidKey();
    const c = await getChallenge(env, signer, { subject: principal.did });
    const d = authDoc(env, signer, c, { extraPayload: { principal: principal.did, delegationEvidence: { kind: 'vtaContext', reference: 'vta-context:personal/console' } } });
    expectError(await post(env, d), 422, CODES.delegationNotRecognized, false);
    expect(sessionCount(env)).toBe(0);
    expect(env.fake.tables.app_members).toHaveLength(0);
  });

  it('S-44 / S-46 the acting party is principal ?? issuer: a challenge bound to the issuer with a different principal → subjectMismatch (before delegation checks)', async () => {
    const env = makeEnv();
    const signer = mintDidKey();
    const c = await getChallenge(env, signer);
    const d = authDoc(env, signer, c, { extraPayload: { principal: mintDidKey().did, delegationEvidence: { kind: 'vtaContext' } } });
    expectError(await post(env, d), 422, 'auth/authenticate:subjectMismatch', false);
  });

  it('S-45 / S-46 order: a proxied document that also carries sessionKey → the delegation code (S-46 before S-45)', async () => {
    const env = makeEnv();
    const signer = mintDidKey();
    const c = await getChallenge(env, signer, { subject: null });
    const d = authDoc(env, signer, c, { extraPayload: { principal: mintDidKey().did, sessionKey: mintDidKey().did } });
    expectError(await post(env, d), 422, 'auth/authenticate:delegationEvidenceRequired', false);
  });
});

describe('replay semantics end-to-end (S-48, S-11, S-24)', () => {
  it('S-48 re-sending the identical signed document → 200 with the retained #response (same accessToken), no new session row, no new handler calls', async () => {
    const env = makeEnv();
    const { doc, res } = await signInFlow(env);
    expect(res.status).toBe(200);
    const start = env.fake.calls.length;
    const again = await post(env, doc);
    expect(again.status).toBe(200);
    expect(again.body).toEqual(res.body);
    expect(sessionCount(env)).toBe(1);
    expect(env.fake.calls.slice(start).map((c) => c.id)).toEqual(['P1', 'P5', 'P6']);
  });

  it('S-11 the replay record is keyed on the document id; digest = sha256Hex(canonicalJson(document)) including proof; response retained', async () => {
    const env = makeEnv();
    const { doc, res } = await signInFlow(env);
    expect(env.fake.tables.app_tt_replay).toEqual([
      expect.objectContaining({ doc_id: doc.id, app_id: APP_A, digest: documentDigest(doc) }),
    ]);
    expect(env.fake.tables.app_tt_replay[0].response).toEqual(res.body);
    const { proof, ...withoutProof } = doc;
    void proof;
    expect(env.fake.tables.app_tt_replay[0].digest).not.toBe(documentDigest(withoutProof));
  });

  it('S-48 same id with a different body (re-signed) → 409 idConflict; the body carries no accessToken', async () => {
    const env = makeEnv();
    const { identity, doc, res } = await signInFlow(env);
    const token = (res.body as AuthResponse).payload.tokens.accessToken;
    const { proof, ...bare } = doc;
    void proof;
    const resigned = signAs(bare, identity, { proofPurpose: 'authentication', created: new Date(env.clock.ms - 1000) });
    const r = await post(env, resigned);
    expectError(r, 409, 'idConflict');
    expect(JSON.stringify(r.body)).not.toContain(token);
    expect(sessionCount(env)).toBe(1);
  });

  it('S-48 a document older than window + skew → 422 expired, and it is not recorded in app_tt_replay', async () => {
    const env = makeEnv();
    const identity = mintDidKey();
    const c = await getChallenge(env, identity);
    const issued = env.clock.ms - (DEFAULT_ACCEPTANCE_WINDOW_MS + 60_000 + 1);
    const d = authDoc(env, identity, c, { issuedAt: new Date(issued).toISOString(), created: new Date(issued) });
    expectError(await post(env, d), 422, 'expired');
    expect(env.fake.callsOf('P5')).toHaveLength(0);
    expect(env.fake.tables.app_tt_replay).toHaveLength(0);
    expect(env.fake.tables.app_tt_challenges[0].consumed_at).toBeNull();
  });

  it('S-48 / S-22 window edge: a document acceptanceWindowMs + 30 s old completes once; its record is live (until_at = issuedAt + window + 60 s pad); the identical resend gets the retained response', async () => {
    const env = makeEnv();
    const identity = mintDidKey();
    const c = await getChallenge(env, identity);
    const issued = env.clock.ms - (DEFAULT_ACCEPTANCE_WINDOW_MS + 30_000);
    const d = authDoc(env, identity, c, { issuedAt: new Date(issued).toISOString(), created: new Date(issued) });
    const first = await post(env, d);
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    expect(env.fake.tables.app_tt_replay[0].until_at).toBe(new Date(issued + DEFAULT_ACCEPTANCE_WINDOW_MS + 60_000).toISOString());
    expect(Date.parse(env.fake.tables.app_tt_replay[0].until_at)).toBeGreaterThan(env.clock.ms);
    env.clock.advance(20_000);
    const again = await post(env, d);
    expect(again.status).toBe(200);
    expect(again.body).toEqual(first.body);
    expect(sessionCount(env)).toBe(1);
  });

  it('S-48 a non-retryable refusal is retained: the identical resend returns the same error document under its status, with no calls beyond P1/P5/P6', async () => {
    const env = makeEnv();
    const identity = mintDidKey();
    const d = authDoc(env, identity, { challenge: 'Q'.repeat(43), sessionId: crypto.randomUUID() });
    const first = await post(env, d);
    expectError(first, 422, 'auth/authenticate:challengeNotFound', false);
    const start = env.fake.calls.length;
    const again = await post(env, d);
    expect(again.status).toBe(422);
    expect(again.body).toEqual(first.body);
    expect(env.fake.calls.slice(start).map((c) => c.id)).toEqual(['P1', 'P5', 'P6']);
  });

  it('S-48 / S-50 a duplicate whose first execution is still in flight → 202 with no body', async () => {
    const env = makeEnv();
    const identity = mintDidKey();
    const c = await getChallenge(env, identity);
    const d = authDoc(env, identity, c);
    env.fake.tables.app_tt_replay.push({ doc_id: d.id, app_id: APP_A, digest: documentDigest(d), response: null, until_at: new Date(env.clock.ms + 600_000).toISOString() });
    const res = await post(env, d);
    expect(res.status).toBe(202);
    expect(res.body).toBeUndefined();
    expect(env.fake.callsOf('P3')).toHaveLength(0);
  });

  it('S-48 the replay store unreachable at claim → 503 unavailable (retryable) and the handler does not run', async () => {
    const env = makeEnv();
    const identity = mintDidKey();
    const c = await getChallenge(env, identity);
    env.fake.failAll('P5', 'reject');
    expectError(await post(env, authDoc(env, identity, c)), 503, 'unavailable', true);
    expect(env.fake.callsOf('P3')).toHaveLength(0);
    expect(sessionCount(env)).toBe(0);
  });

  it('S-24 app A completes a sign-in; the identical document under app B\'s credentials → 409 and no accessToken', async () => {
    const env = makeEnv();
    const { doc, res } = await signInFlow(env);
    const token = (res.body as AuthResponse).payload.tokens.accessToken;
    const r = await post(env, doc, APP_B, KEY_B);
    expectError(r, 409, 'idConflict');
    expect(JSON.stringify(r.body)).not.toContain(token);
    expect(sessionCount(env)).toBe(1);
  });
});

/** A P-256 did:key identity (ecdsa-jcs-2019 when signed) — the producer only mints Ed25519. */
function p256Identity(): TestIdentity {
  const seed = fixedSeed(40);
  const signer = signerFromPrivateKey('p256', seed);
  return { did: signer.did, verificationMethod: signer.verificationMethod, seed, signer };
}

describe('verification is eddsa-jcs-2022 / Ed25519 only, with the did:key\'s own method (C-42)', () => {
  it('C-42 oracle 1: an authenticate signed ecdsa-jcs-2019 by a P-256 did:key → 422 proofInvalid; no member row, no P3, no P5', async () => {
    const env = makeEnv();
    const p256 = p256Identity();
    expect(p256.did).toMatch(/^did:key:zDn/);
    const c = await getChallenge(env, mintDidKey(), { subject: null });
    const d = authDoc(env, p256, c);
    expect((d.proof as { cryptosuite?: string }).cryptosuite).toBe('ecdsa-jcs-2019');
    expectError(await post(env, d), 422, 'proofInvalid');
    expect(env.fake.tables.app_members).toHaveLength(0);
    expect(env.fake.callsOf('P3')).toHaveLength(0);
    expect(env.fake.callsOf('P5')).toHaveLength(0);
    expect(sessionCount(env)).toBe(0);
  });

  it('C-42 oracle 2: an Ed25519 authenticate whose proof names verificationMethod did + "#not-the-key" → 422 proofInvalid; no P3, no P5', async () => {
    const env = makeEnv();
    const id = mintDidKey();
    const c = await getChallenge(env, id);
    const bare = unsignedAuthenticateDoc(id.did, { id: crypto.randomUUID(), now: env.clock.now(), recipient: LOCAL_VID, ...c });
    const d = signTrustTask(bare, { ...id.signer, verificationMethod: `${id.did}#not-the-key` }, { proofPurpose: 'authentication', created: env.clock.now() });
    expect((d.proof as { verificationMethod?: string }).verificationMethod).toBe(`${id.did}#not-the-key`);
    expectError(await post(env, d), 422, 'proofInvalid');
    expect(env.fake.callsOf('P3')).toHaveLength(0);
    expect(env.fake.callsOf('P5')).toHaveLength(0);
    expect(env.fake.tables.app_members).toHaveLength(0);
  });

  it('C-42 oracle 3: the normal producer flow (verificationMethod did#<multikey>, eddsa-jcs-2022) → 200', async () => {
    const env = makeEnv();
    const { identity, doc, res } = await signInFlow(env);
    expect((doc.proof as { verificationMethod?: string }).verificationMethod).toBe(`${identity.did}#${identity.did.slice('did:key:'.length)}`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
  });
});

describe('envelope timestamps must be RFC 3339; parentThreadId a string (C-43)', () => {
  async function refused(env: Env, mutate: (d: Record<string, unknown>) => void, member: string) {
    const id = mintDidKey();
    const c = await getChallenge(env, id);
    const bare = unsignedAuthenticateDoc(id.did, { id: crypto.randomUUID(), now: env.clock.now(), recipient: LOCAL_VID, ...c }) as unknown as Record<string, unknown>;
    mutate(bare);
    const d = signAs(bare as unknown as TrustTaskDocument<Record<string, unknown>>, id, { proofPurpose: 'authentication', created: env.clock.now() });
    const err = expectError(await post(env, d), 400, 'malformedRequest', false);
    expect(err.payload.message ?? '', `message names ${member}`).toContain(member);
    expect(env.fake.callsOf('P3')).toHaveLength(0);
    expect(env.fake.callsOf('P5')).toHaveLength(0);
  }

  it('C-43 issuedAt in RFC 2822 form ("Tue, 04 Mar 2031 05:06:07 GMT", which Date.parse reads as now) → 400 malformedRequest; zero P3 and P5', async () => {
    const env = makeEnv();
    expect(Date.parse('Tue, 04 Mar 2031 05:06:07 GMT')).toBe(env.clock.ms);
    await refused(env, (d) => void (d.issuedAt = 'Tue, 04 Mar 2031 05:06:07 GMT'), 'issuedAt');
  });

  it('C-43 an offset-less issuedAt ("2031-03-04T05:06:07.000") → 400 malformedRequest whatever TZ is; zero P3 and P5', async () => {
    const saved = process.env.TZ;
    try {
      for (const tz of ['UTC', 'America/Los_Angeles', 'Asia/Tokyo']) {
        process.env.TZ = tz;
        const env = makeEnv();
        await refused(env, (d) => void (d.issuedAt = '2031-03-04T05:06:07.000'), 'issuedAt');
      }
    } finally {
      if (saved === undefined) delete process.env.TZ;
      else process.env.TZ = saved;
    }
  });

  it('C-43 expiresAt with month 13 ("2031-13-01T00:00:00Z") → 400 malformedRequest; zero P3 and P5', async () => {
    await refused(makeEnv(), (d) => void (d.expiresAt = '2031-13-01T00:00:00Z'), 'expiresAt');
  });

  it('C-43 parentThreadId: 7 → 400 malformedRequest; zero P3 and P5', async () => {
    await refused(makeEnv(), (d) => void (d.parentThreadId = 7), 'parentThreadId');
  });

  it('C-43 an issuedAt with a +02:00 offset (the same instant as now) passes the shape check and completes', async () => {
    const env = makeEnv();
    const id = mintDidKey();
    const c = await getChallenge(env, id);
    const d = authDoc(env, id, c, { issuedAt: '2031-03-04T07:06:07+02:00' });
    const res = await post(env, d);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
  });
});

describe('envelope date-time range checks end to end (C-55)', () => {
  /** Set the clock to `at`, take a challenge, and send an authenticate whose issuedAt is the literal `issuedAt`. */
  async function sendWithIssuedAt(issuedAt: string, at: number) {
    const env = makeEnv();
    env.clock.ms = at;
    const id = mintDidKey();
    const c = await getChallenge(env, id);
    const p3Before = env.fake.callsOf('P3').length;
    const bare = unsignedAuthenticateDoc(id.did, { id: crypto.randomUUID(), now: env.clock.now(), recipient: LOCAL_VID, ...c, issuedAt });
    const d = signAs(bare, id, { proofPurpose: 'authentication', created: env.clock.now() });
    const res = await post(env, d);
    return { env, res, p3: env.fake.callsOf('P3').length - p3Before };
  }

  it.each([
    ['2031-02-31T05:06:07Z'],
    ['2031-04-31T05:06:07Z'],
    ['2031-03-04T24:00:00Z'],
  ])('C-55 issuedAt %s, with the clock at the instant Date.parse reads it as → 400 malformedRequest naming issuedAt; zero P3 and P5; no session', async (v) => {
    const at = Date.parse(v);
    expect(Number.isNaN(at), 'Date.parse rolls the impossible value over to a real instant').toBe(false);
    const { env, res, p3 } = await sendWithIssuedAt(v, at);
    const err = expectError(res, 400, 'malformedRequest', false);
    expect(err.payload.message ?? '').toContain('issuedAt');
    expect(p3).toBe(0);
    expect(env.fake.callsOf('P5')).toHaveLength(0);
    expect(sessionCount(env)).toBe(0);
  });

  it('C-55 issuedAt 2031-03-04T23:59:60Z (a leap second) → 400 malformedRequest from the shape check: names issuedAt, not the runtime\'s "not a valid RFC 3339 timestamp"; zero P3 and P5', async () => {
    expect(Number.isNaN(Date.parse('2031-03-04T23:59:60Z'))).toBe(true);
    const { env, res, p3 } = await sendWithIssuedAt('2031-03-04T23:59:60Z', Date.parse('2031-03-05T00:00:00Z'));
    const err = expectError(res, 400, 'malformedRequest', false);
    expect(err.payload.message ?? '').toContain('issuedAt');
    expect(err.payload.message ?? '').not.toContain('not a valid RFC 3339 timestamp');
    expect(p3).toBe(0);
    expect(env.fake.callsOf('P5')).toHaveLength(0);
    expect(sessionCount(env)).toBe(0);
  });
});

describe('the boundary millisecond and its mitigation (C-56)', () => {
  it('C-56 authenticateChecks keeps requireIssuedAt: true (the retention cap depends on it)', () => {
    const guard: ReplayGuard = { claim: () => ({ kind: 'fresh' }) };
    expect(authenticateChecks(guard, DEFAULT_ACCEPTANCE_WINDOW_MS).freshness?.requireIssuedAt).toBe(true);
  });

  async function completeAtT() {
    const env = makeEnv();
    const T = env.clock.ms;
    const id = mintDidKey();
    const c = await getChallenge(env, id);
    const d = authDoc(env, id, c, { issuedAt: new Date(T).toISOString(), created: new Date(T) });
    expect(d.expiresAt).toBeUndefined();
    const first = await post(env, d);
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    expect(sessionCount(env)).toBe(1);
    return { env, T, d };
  }

  it('C-56 issuedAt = T, no expiresAt, completes at T; the identical resend at T + window + 60 000 re-runs the handler (one more P3) and gets 422 challengeNotFound; still one session', async () => {
    const { env, T, d } = await completeAtT();
    const p3 = env.fake.callsOf('P3').length;
    env.clock.ms = T + DEFAULT_ACCEPTANCE_WINDOW_MS + 60_000;
    const again = await post(env, d);
    expectError(again, 422, 'auth/authenticate:challengeNotFound');
    expect(env.fake.callsOf('P3')).toHaveLength(p3 + 1);
    expect(sessionCount(env)).toBe(1);
  });

  it('C-56 the same resend at T + window + 60 001 → 422 expired, with zero P3 and P5', async () => {
    const { env, T, d } = await completeAtT();
    const p3 = env.fake.callsOf('P3').length;
    const p5 = env.fake.callsOf('P5').length;
    env.clock.ms = T + DEFAULT_ACCEPTANCE_WINDOW_MS + 60_001;
    expectError(await post(env, d), 422, 'expired');
    expect(env.fake.callsOf('P3')).toHaveLength(p3);
    expect(env.fake.callsOf('P5')).toHaveLength(p5);
    expect(sessionCount(env)).toBe(1);
  });
});

describe('replay retention cap and release/record failures end to end (C-39, C-40)', () => {
  it('C-39 oracle 2: an authenticate with expiresAt "9999-12-31T23:59:59Z" completes; P5 until_at ≤ now + window + 120 s, a plain YYYY-…Z string', async () => {
    const env = makeEnv();
    const id = mintDidKey();
    const c = await getChallenge(env, id);
    const res = await post(env, authDoc(env, id, c, { expiresAt: '9999-12-31T23:59:59Z' }));
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const untilAt = env.fake.callsOf('P5')[0].body as { until_at: string };
    expect(untilAt.until_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/);
    expect(untilAt.until_at.startsWith('+')).toBe(false);
    expect(Date.parse(untilAt.until_at)).toBeLessThanOrEqual(env.clock.ms + DEFAULT_ACCEPTANCE_WINDOW_MS + 120_000);
    expect(Date.parse(env.fake.tables.app_tt_replay[0].until_at)).toBeLessThanOrEqual(env.clock.ms + DEFAULT_ACCEPTANCE_WINDOW_MS + 120_000);
  });

  it('C-40 oracle 1: P3 rejects and P10 rejects → 503 unavailable, retryable, issuer localVid (never 500); the record stays in flight so the identical resend gets 202', async () => {
    const env = makeEnv();
    const id = mintDidKey();
    const c = await getChallenge(env, id);
    env.fake.failAll('P3', 'reject');
    env.fake.failAll('P10', 'reject');
    const d = authDoc(env, id, c);
    const res = await post(env, d);
    expect(res.status, JSON.stringify(res.body)).toBe(503);
    expectError(res, 503, 'unavailable', true);
    expect(env.fake.callsOf('P10')).toHaveLength(1);
    env.fake.failAll('P3', null);
    env.fake.failAll('P10', null);
    expect((await post(env, d)).status).toBe(202);
  });

  it('C-40 oracle 1: P3 rejects and P10 answers 503 → 503 unavailable, retryable, issuer localVid', async () => {
    const env = makeEnv();
    const id = mintDidKey();
    const c = await getChallenge(env, id);
    env.fake.failAll('P3', 'reject');
    env.fake.failAll('P10', 503);
    const res = await post(env, authDoc(env, id, c));
    expectError(res, 503, 'unavailable', true);
    expect(env.fake.callsOf('P10')).toHaveLength(1);
  });

  it('C-40 oracle 3: P9 failing once then succeeding → the identical resend gets 200 and the retained response', async () => {
    const env = makeEnv();
    const id = mintDidKey();
    const c = await getChallenge(env, id);
    env.fake.script('P9', 503);
    const d = authDoc(env, id, c);
    const first = await post(env, d);
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    expect(env.fake.callsOf('P9')).toHaveLength(2);
    const again = await post(env, d);
    expect(again.status).toBe(200);
    expect(again.body).toEqual(first.body);
    expect(sessionCount(env)).toBe(1);
  });

  it('C-40 oracle 4: P9 failing twice → the first answer is still 200 with the token; the identical resend gets 202', async () => {
    const env = makeEnv();
    const id = mintDidKey();
    const c = await getChallenge(env, id);
    env.fake.script('P9', 503, 'reject');
    const d = authDoc(env, id, c);
    const first = await post(env, d);
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    expect((first.body as AuthResponse).payload.tokens.accessToken).toBe(env.fake.tables.app_sessions[0].token);
    expect(env.fake.callsOf('P9')).toHaveLength(2);
    const again = await post(env, d);
    expect(again.status).toBe(202);
    expect(sessionCount(env)).toBe(1);
  });
});
