import { describe, expect, it } from 'vitest';
import { AuthChallenge_v0_1, type TrustTaskDocument } from '@openvtc/trust-tasks';
import { DEFAULT_CHALLENGE_TTL_MS } from '../../supabase/functions/app-trust-tasks/core.ts';
import { APP_A, LOCAL_VID, expectError, makeEnv, post } from './helpers.ts';
import { signerFromPrivateKey } from '@openvtc/trust-tasks-proof';
import { challengeDoc, fixedSeed, mintDidKey, signAs } from './producer.ts';

type ChallengeResponse = TrustTaskDocument<{ challenge: string; sessionId: string; expiresAt: string }>;

function doc(env: ReturnType<typeof makeEnv>, did: string, o: Partial<Parameters<typeof challengeDoc>[1]> = {}) {
  return challengeDoc(did, { id: crypto.randomUUID(), now: env.clock.now(), recipient: LOCAL_VID, ...o });
}

describe('challenge handler (S-43)', () => {
  it('S-43 an unsigned did:key challenge → 200 #response {challenge, sessionId, expiresAt}, issuer = localVid, recipient = document.issuer, threadId = document.id', async () => {
    const env = makeEnv();
    const id = mintDidKey();
    const d = doc(env, id.did);
    const res = await post(env, d);
    expect(res.status).toBe(200);
    const body = res.body as ChallengeResponse;
    expect(body.type).toBe(AuthChallenge_v0_1.RESPONSE_TYPE_URI);
    expect(body.issuer).toBe(LOCAL_VID);
    expect(body.recipient).toBe(id.did);
    expect(body.threadId).toBe(d.id);
    expect(body.id).not.toBe(d.id);
    expect(body.issuedAt).toBe(env.clock.now().toISOString());
    expect(Object.keys(body.payload).sort()).toEqual(['challenge', 'expiresAt', 'sessionId']);
    expect(body.payload.challenge).toMatch(/^[A-Za-z0-9_-]{43,}$/);
    expect(body.proof, 'Increment 1 responses are unsigned').toBeUndefined();
    const ttl = Date.parse(body.payload.expiresAt) - env.clock.ms;
    expect(ttl).toBeGreaterThanOrEqual(30_000);
    expect(ttl).toBeLessThanOrEqual(300_000);
    expect(ttl).toBe(DEFAULT_CHALLENGE_TTL_MS);
    expect(new Date(body.payload.expiresAt).toISOString()).toBe(body.payload.expiresAt);
  });

  it('S-43 the challenge is stored bound to app, subject and expiry (one P2 row, unconsumed)', async () => {
    const env = makeEnv();
    const id = mintDidKey();
    const res = await post(env, doc(env, id.did));
    const p = (res.body as ChallengeResponse).payload;
    expect(env.fake.tables.app_tt_challenges).toEqual([
      expect.objectContaining({ session_id: p.sessionId, app_id: APP_A, subject: id.did, challenge: p.challenge, expires_at: p.expiresAt, consumed_at: null }),
    ]);
    expect(env.fake.callIds().filter((c) => c !== 'P4')).toEqual(['P1', 'P2']);
  });

  it('S-43 a second call yields a different sessionId and challenge', async () => {
    const env = makeEnv();
    const id = mintDidKey();
    const a = (await post(env, doc(env, id.did))).body as ChallengeResponse;
    const b = (await post(env, doc(env, id.did))).body as ChallengeResponse;
    expect(b.payload.sessionId).not.toBe(a.payload.sessionId);
    expect(b.payload.challenge).not.toBe(a.payload.challenge);
  });

  it('S-43 threadId continues the document\'s threadId when present (respondWith)', async () => {
    const env = makeEnv();
    const id = mintDidKey();
    const res = await post(env, doc(env, id.did, { threadId: 'thread-xyz' }));
    expect((res.body as ChallengeResponse).threadId).toBe('thread-xyz');
  });

  it('S-43 challengeTtlMs is honoured (30 s)', async () => {
    const env = makeEnv({ challengeTtlMs: 30_000 });
    const res = await post(env, doc(env, mintDidKey().did));
    expect(Date.parse((res.body as ChallengeResponse).payload.expiresAt) - env.clock.ms).toBe(30_000);
  });

  it('S-43 subject absent → subject-agnostic challenge (row subject null)', async () => {
    const env = makeEnv();
    const res = await post(env, doc(env, mintDidKey().did, { subject: null }));
    expect(res.status).toBe(200);
    expect(env.fake.tables.app_tt_challenges[0].subject).toBeNull();
  });

  it('S-43 a non-did:key subject → 422 auth/challenge:subjectNotRecognized, retryable false, nothing stored', async () => {
    const valid = mintDidKey().did;
    for (const subject of [
      'did:web:alice.example',
      'did:key:zQ3shokFTS3brHcDQrn82RUDfCZESWL1ZdCEJwekUDPQiYBme',
      'did:keyz6Mk',
      'did:key:z6Mk0OIl', // C-31: not base58btc
      `${valid}#frag`, // C-31: no fragment (publicKeyFromDidKey would accept it)
      'did:key:z6Mkabc', // C-31: base58 but does not decode as an Ed25519 key
      `${valid} `,
    ]) {
      const env = makeEnv();
      const id = mintDidKey();
      const d = doc(env, id.did, { subject });
      const err = expectError(await post(env, d), 422, 'auth/challenge:subjectNotRecognized', false);
      expect(err.recipient).toBe(id.did);
      expect(err.threadId).toBe(d.id);
      expect(err.payload.inResponseTo).toEqual({ typeUri: AuthChallenge_v0_1.TYPE_URI, id: d.id });
      expect(env.fake.callsOf('P2')).toHaveLength(0);
      expect(env.fake.tables.app_tt_challenges).toHaveLength(0);
    }
  });

  it('S-43 the store failing on issue → 503 unavailable (retryable) and the handler does not throw', async () => {
    for (const fault of ['reject', 503] as const) {
      const env = makeEnv();
      env.fake.failAll('P2', fault);
      expectError(await post(env, doc(env, mintDidKey().did)), 503, 'unavailable', true);
    }
  });

  it('S-43 / S-23 the challenge handler fires sweep (P4: expires_at < now − 1h) after issuing', async () => {
    const env = makeEnv();
    await post(env, doc(env, mintDidKey().did));
    const p4 = env.fake.callsOf('P4');
    expect(p4).toHaveLength(1);
    expect(p4[0].query).toEqual({ expires_at: `lt.${new Date(env.clock.ms - 3_600_000).toISOString()}` });
  });

  it('S-43 / S-23 a failing sweep does not affect the response', async () => {
    const env = makeEnv();
    env.fake.failAll('P4', 'reject');
    expect((await post(env, doc(env, mintDidKey().did))).status).toBe(200);
  });
});

describe('challenge pipeline (S-42 for auth/challenge/0.1)', () => {
  it('S-42 proof is optional: a valid signed challenge (proofPurpose authentication) → 200', async () => {
    const env = makeEnv();
    const id = mintDidKey();
    const signed = signAs(doc(env, id.did), id, { proofPurpose: 'authentication', created: env.clock.now() });
    expect((await post(env, signed)).status).toBe(200);
  });

  it('S-42 a present proof is verified: tampered → 422 proofInvalid, nothing stored', async () => {
    const env = makeEnv();
    const id = mintDidKey();
    const signed = signAs(doc(env, id.did), id, { proofPurpose: 'authentication', created: env.clock.now() });
    const tampered = { ...signed, payload: { ...signed.payload, purpose: 'step-up' } };
    expectError(await post(env, tampered), 422, 'proofInvalid');
    expect(env.fake.callsOf('P2')).toHaveLength(0);
  });

  it('S-42 a proofPurpose outside SPEC §4.7.3 (keyAgreement) → 422 proofInvalid; assertionMethod is accepted', async () => {
    const env = makeEnv();
    const id = mintDidKey();
    const bad = signAs(doc(env, id.did), id, { proofPurpose: 'keyAgreement', created: env.clock.now() });
    expectError(await post(env, bad), 422, 'proofInvalid');
    const ok = signAs(doc(env, id.did), id, { proofPurpose: 'assertionMethod', created: env.clock.now() });
    expect((await post(env, ok)).status).toBe(200);
  });

  it('S-42 a challenge without issuedAt is accepted (issuedAt not required for auth/challenge)', async () => {
    const env = makeEnv();
    expect((await post(env, doc(env, mintDidKey().did, { omitIssuedAt: true }))).status).toBe(200);
  });

  it('S-42 DEFAULT_FRESHNESS: an issuedAt beyond the skew in the future → 400 malformedRequest', async () => {
    const env = makeEnv();
    const d = doc(env, mintDidKey().did, { now: new Date(env.clock.ms + 61_000) });
    expectError(await post(env, d), 400, 'malformedRequest');
  });

  it('S-42 / S-25 a payload with an unknown member → 400 malformedRequest (schema validated), nothing stored', async () => {
    const env = makeEnv();
    const d = doc(env, mintDidKey().did);
    (d.payload as Record<string, unknown>).extra = 'not-allowed';
    expectError(await post(env, d), 400, 'malformedRequest');
    expect(env.fake.callsOf('P2')).toHaveLength(0);
  });
});

describe('challenge proof is eddsa-jcs-2022 / Ed25519 only (C-42)', () => {
  it('C-42 oracle 1: a challenge carrying an optional ecdsa-jcs-2019 proof by a P-256 did:key (subject-agnostic) → 422 proofInvalid; nothing stored', async () => {
    const env = makeEnv();
    const seed = fixedSeed(40);
    const signer = signerFromPrivateKey('p256', seed);
    const p256 = { did: signer.did, verificationMethod: signer.verificationMethod, seed, signer };
    const signed = signAs(doc(env, p256.did, { subject: null }), p256, { proofPurpose: 'authentication', created: env.clock.now() });
    expect((signed.proof as { cryptosuite?: string }).cryptosuite).toBe('ecdsa-jcs-2019');
    expectError(await post(env, signed), 422, 'proofInvalid');
    expect(env.fake.callsOf('P2')).toHaveLength(0);
    expect(env.fake.tables.app_tt_challenges).toHaveLength(0);
  });
});
