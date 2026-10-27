import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { AuthAuthenticate_v0_3, AuthChallenge_v0_1 } from '@openvtc/trust-tasks';
import { SUPPORTED_SCHEMA_KEYWORDS, assertSchemaSupported, subsetSchemaValidator } from '../../supabase/functions/app-trust-tasks/core.ts';
import { thrownBy } from './helpers.ts';

const SPECS = fileURLToPath(new URL('../../.spike-deps/dtgwg-trust-tasks-tf/specs/auth/', import.meta.url));

function ok(schema: unknown, payload: unknown): boolean {
  const r = subsetSchemaValidator.validate(schema, payload);
  return typeof r === 'boolean' ? r : r.ok;
}

interface Example { note: string; payload: unknown }
const invalid = (dir: string): Example[] => JSON.parse(readFileSync(`${SPECS}${dir}/payload.invalid-examples.json`, 'utf8'));

/** Every ```json block in a task spec.md whose `type` is the request or #response URI. */
function examples(dir: string, typeUri: string): { requests: unknown[]; responses: unknown[] } {
  const md = readFileSync(`${SPECS}${dir}/spec.md`, 'utf8');
  const blocks = [...md.matchAll(/```json\n([\s\S]*?)```/g)].map((m) => JSON.parse(m[1]) as { type?: string; payload?: unknown });
  return {
    requests: blocks.filter((b) => b.type === typeUri).map((b) => b.payload),
    responses: blocks.filter((b) => b.type === `${typeUri}#response`).map((b) => b.payload),
  };
}

const SCHEMAS = {
  challengeRequest: AuthChallenge_v0_1.SPEC.payloadSchema,
  challengeResponse: AuthChallenge_v0_1.RESPONSE_SPEC.payloadSchema,
  authenticateRequest: AuthAuthenticate_v0_3.SPEC.payloadSchema,
  authenticateResponse: AuthAuthenticate_v0_3.RESPONSE_SPEC.payloadSchema,
};

describe('subsetSchemaValidator / assertSchemaSupported (S-25)', () => {
  it('S-25 assertSchemaSupported passes for the request and response schemas of both pinned tasks; SUPPORTED_SCHEMA_KEYWORDS is exactly the listed 20', () => {
    for (const [name, s] of Object.entries(SCHEMAS)) expect(() => assertSchemaSupported(s), name).not.toThrow();
    expect([...SUPPORTED_SCHEMA_KEYWORDS].sort()).toEqual(
      ['$schema', '$id', '$anchor', 'title', 'description', '$defs', '$ref', 'type', 'properties', 'additionalProperties', 'required', 'items',
        'minLength', 'maxLength', 'pattern', 'format', 'minimum', 'minItems', 'minProperties', 'propertyNames'].sort(),
    );
  });

  it('S-25 accepts every valid request and response example in auth/challenge/0.1 spec.md', () => {
    const ex = examples('challenge/0.1', AuthChallenge_v0_1.TYPE_URI);
    expect(ex.requests.length).toBeGreaterThanOrEqual(2);
    expect(ex.responses.length).toBeGreaterThanOrEqual(1);
    for (const p of ex.requests) expect(ok(SCHEMAS.challengeRequest, p), JSON.stringify(p)).toBe(true);
    for (const p of ex.responses) expect(ok(SCHEMAS.challengeResponse, p), JSON.stringify(p)).toBe(true);
  });

  it('S-25 accepts every request and response example in auth/authenticate/0.3 spec.md (the proxied ones are schema-valid)', () => {
    const ex = examples('authenticate/0.3', AuthAuthenticate_v0_3.TYPE_URI);
    expect(ex.requests.length).toBeGreaterThanOrEqual(3);
    expect(ex.responses.length).toBeGreaterThanOrEqual(2);
    for (const p of ex.requests) expect(ok(SCHEMAS.authenticateRequest, p), JSON.stringify(p)).toBe(true);
    for (const p of ex.responses) expect(ok(SCHEMAS.authenticateResponse, p), JSON.stringify(p)).toBe(true);
  });

  it('S-25 rejects every entry of auth/challenge/0.1 payload.invalid-examples.json', () => {
    const list = invalid('challenge/0.1');
    expect(list.length).toBeGreaterThan(0);
    for (const e of list) expect(ok(SCHEMAS.challengeRequest, e.payload), e.note).toBe(false);
  });

  it('S-25 rejects every entry of auth/authenticate/0.3 payload.invalid-examples.json', () => {
    const list = invalid('authenticate/0.3');
    expect(list.length).toBeGreaterThan(0);
    for (const e of list) expect(ok(SCHEMAS.authenticateRequest, e.payload), e.note).toBe(false);
  });

  it('S-25 any other keyword (oneOf, const, enum, default, $comment) makes both the validator and assertSchemaSupported throw', () => {
    const bad = [
      { oneOf: [{ type: 'string' }, { type: 'number' }] },
      { type: 'object', properties: { a: { const: 1 } } },
      { type: 'string', enum: ['a'] },
      { type: 'string', default: 'x' },
      { $comment: 'hi', type: 'string' },
      { type: 'object', $defs: { X: { anyOf: [] } }, properties: { a: { $ref: '#/$defs/X' } } },
    ];
    for (const s of bad) {
      thrownBy(() => assertSchemaSupported(s));
      thrownBy(() => subsetSchemaValidator.validate(s, 'x'));
    }
  });

  it('S-25 $ref is restricted to #/$defs/<name>; other forms throw', () => {
    for (const ref of ['other.json#/$defs/X', '#/properties/a', 'https://example.org/s', '#anchor']) {
      const s = { type: 'object', $defs: { X: { type: 'string' } }, properties: { a: { $ref: ref } } };
      thrownBy(() => assertSchemaSupported(s));
      thrownBy(() => subsetSchemaValidator.validate(s, { a: 'x' }));
    }
    const good = { type: 'object', $defs: { X: { type: 'string', minLength: 2 } }, properties: { a: { $ref: '#/$defs/X' } } };
    expect(ok(good, { a: 'xy' })).toBe(true);
    expect(ok(good, { a: 'x' })).toBe(false);
  });

  it('S-25 annotations ($schema, $id, $anchor, title, description) are ignored', () => {
    const s = { $schema: 'https://json-schema.org/draft/2020-12/schema', $id: 'x', $anchor: 'a', title: 't', description: 'd', type: 'string' };
    expect(() => assertSchemaSupported(s)).not.toThrow();
    expect(ok(s, 'x')).toBe(true);
    expect(ok(s, 1)).toBe(false);
  });

  it('S-25 string length counts Unicode code points', () => {
    expect(ok({ type: 'string', maxLength: 2 }, '😀😀')).toBe(true);
    expect(ok({ type: 'string', minLength: 3 }, '😀😀')).toBe(false);
    expect(ok({ type: 'string', minLength: 2, maxLength: 2 }, 'é😀')).toBe(true);
  });

  it('S-25 format date-time is RFC 3339 (offset required)', () => {
    const s = { type: 'string', format: 'date-time' };
    for (const v of ['2026-10-26T12:00:00Z', '2026-10-26T12:00:00.123Z', '2026-10-26T12:00:00+02:00', '2026-10-26t12:00:00z']) expect(ok(s, v), v).toBe(true);
    for (const v of ['2026-10-26', '2026-10-26T12:00:00', 'not a date', '2026-13-01T00:00:00Z', '2026-10-26 12:00Z']) expect(ok(s, v), v).toBe(false);
  });

  it('S-25 type, required, additionalProperties (bool and schema), items, pattern, minimum, minItems, minProperties, propertyNames', () => {
    expect(ok({ type: 'object' }, [])).toBe(false);
    expect(ok({ type: 'object' }, null)).toBe(false);
    expect(ok({ type: 'array' }, {})).toBe(false);
    expect(ok({ type: 'integer' }, 1.5)).toBe(false);
    expect(ok({ type: 'integer' }, 3)).toBe(true);
    expect(ok({ type: 'boolean' }, 'true')).toBe(false);
    expect(ok({ type: 'object', required: ['a'] }, {})).toBe(false);
    expect(ok({ type: 'object', properties: { a: { type: 'string' } }, additionalProperties: false }, { a: 'x', b: 1 })).toBe(false);
    expect(ok({ type: 'object', additionalProperties: { type: 'string' } }, { a: 'x' })).toBe(true);
    expect(ok({ type: 'object', additionalProperties: { type: 'string' } }, { a: 1 })).toBe(false);
    expect(ok({ type: 'array', items: { type: 'string', minLength: 1 } }, ['a', ''])).toBe(false);
    expect(ok({ type: 'array', minItems: 1 }, [])).toBe(false);
    expect(ok({ type: 'string', pattern: '^did:' }, 'did:x')).toBe(true);
    expect(ok({ type: 'string', pattern: '^did:' }, 'x:did:')).toBe(false);
    expect(ok({ type: 'integer', minimum: 1 }, 0)).toBe(false);
    expect(ok({ type: 'object', minProperties: 1 }, {})).toBe(false);
    expect(ok({ type: 'object', propertyNames: { pattern: '^[a-z]+\\.[a-z]+$' } }, { 'org.x': 1 })).toBe(true);
    expect(ok({ type: 'object', propertyNames: { pattern: '^[a-z]+\\.[a-z]+$' } }, { bare: 1 })).toBe(false);
  });

  it('S-25 response schema: the Ext namespace org.relationalbuilder.cloud satisfies the reverse-DNS propertyNames pattern; a bare ext key does not', () => {
    const base = {
      session: { id: 's', subject: 'did:key:z6Mk1', issuedAt: '2031-01-01T00:00:00.000Z', expiresAt: '2031-01-31T00:00:00.000Z', amr: ['did'], acr: 'aal1' },
      tokens: { accessToken: 'a'.repeat(64), tokenType: 'Bearer', expiresIn: 2592000 },
    };
    expect(ok(SCHEMAS.authenticateResponse, { ...base, ext: { 'org.relationalbuilder.cloud': { member: {} } } })).toBe(true);
    expect(ok(SCHEMAS.authenticateResponse, { ...base, ext: { member: {} } })).toBe(false);
    expect(ok(SCHEMAS.authenticateResponse, { ...base, tokens: { ...base.tokens, expiresIn: 0 } })).toBe(false);
  });
});
