/**
 * NF-3, NF-4, NF-5: static, pure-spec checks over committed files.
 * (NF-1 is the `typecheck:functions` gate and NF-2 is this harness itself —
 * see COVERAGE.md.)
 */
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const FN = `${ROOT}supabase/functions/app-trust-tasks/`;
const read = (p: string) => readFileSync(p, 'utf8');
const BASE_NOTES = read(`${ROOT}docs/spikes/openvtc-signin/BASE_SHA`);

describe('non-functional', () => {
  it('NF-3 dev dependencies only: vitest, @openvtc/trust-tasks@0.26.x, @openvtc/trust-tasks-proof, @noble/curves; none in dependencies', () => {
    const pkg = JSON.parse(read(`${ROOT}package.json`)) as { dependencies: Record<string, string>; devDependencies: Record<string, string> };
    for (const d of ['vitest', '@openvtc/trust-tasks', '@openvtc/trust-tasks-proof', '@noble/curves']) {
      expect(pkg.devDependencies[d], d).toBeTruthy();
      expect(pkg.dependencies[d], d).toBeUndefined();
    }
    expect(pkg.devDependencies['@openvtc/trust-tasks']).toMatch(/^[~^]?0\.26\./);
  });

  it('NF-3 the edge function imports npm: specifiers pinned exactly as recorded in BASE_SHA', () => {
    const pins = [...BASE_NOTES.matchAll(/npm:(@[\w-]+\/[\w-]+)@([\d.]+)/g)].map((m) => [m[1], m[2]] as const);
    expect(pins.length).toBeGreaterThanOrEqual(2);
    const pinOf = new Map(pins);
    const sources = ['core.ts', 'challenges.ts', 'replay.ts', 'members.ts', 'status.ts', 'index.ts'].filter((f) => existsSync(FN + f)).map((f) => read(FN + f)).join('\n');
    const used = [...sources.matchAll(/["']npm:(@[\w-]+\/[\w-]+)@([^/"']+)/g)].map((m) => [m[1], m[2]] as const);
    expect(used.length).toBeGreaterThan(0);
    for (const [name, ver] of used) expect(`${name}@${ver}`).toBe(`${name}@${pinOf.get(name)}`);
    expect(new Set(used.map(([n]) => n))).toContain('@openvtc/trust-tasks');
    expect(new Set(used.map(([n]) => n))).toContain('@openvtc/trust-tasks-proof');
  });

  it('NF-4 .env.example gains TRUST_TASKS_LOCAL_VID= with a comment, and no secret values', () => {
    const env = read(`${ROOT}.env.example`);
    const lines = env.split('\n');
    const i = lines.findIndex((l) => /^TRUST_TASKS_LOCAL_VID=\s*$/.test(l));
    expect(i, 'TRUST_TASKS_LOCAL_VID= (empty value)').toBeGreaterThan(-1);
    expect(lines.slice(Math.max(0, i - 3), i).some((l) => l.trim().startsWith('#')) || /#/.test(lines[i])).toBe(true);
  });

  it('NF-4 no secrets in the new committed sources (no JWTs, service keys, or sk-/pat tokens)', () => {
    const files = ['core.ts', 'challenges.ts', 'replay.ts', 'members.ts', 'status.ts', 'index.ts'].map((f) => FN + f);
    files.push(`${ROOT}src/kit/files/lib/trust-signin.ts`);
    for (const f of files.filter(existsSync)) {
      expect(read(f), f).not.toMatch(/eyJ[A-Za-z0-9_-]{20,}\.|sk-[A-Za-z0-9]{20,}|\bpat[A-Za-z0-9]{14,}\.|service_role_key\s*=\s*['"][^'"]+/);
    }
  });

  it('NF-5 per-file minimum // SPIKE: markers (C-34): core.ts ≥ 5 incl. the exact S-30 line; replay.ts, index.ts, trust-signin.ts ≥ 1', () => {
    const core = read(`${FN}core.ts`);
    expect(core).toContain('// SPIKE: unsigned responses; local_vid is a label');
    const count = (s: string) => (s.match(/\/\/ SPIKE:/g) ?? []).length;
    expect(count(core), 'core.ts: S-30 label + S-44, S-47, S-25, rate limiter (C-34)').toBeGreaterThanOrEqual(5);
    expect(count(read(`${FN}replay.ts`)), 'replay.ts: S-22 retention pad').toBeGreaterThanOrEqual(1);
    expect(count(read(`${FN}index.ts`)), 'index.ts: S-51 OPTIONS').toBeGreaterThanOrEqual(1);
    expect(count(read(`${ROOT}src/kit/files/lib/trust-signin.ts`)), 'trust-signin.ts: software custody').toBeGreaterThanOrEqual(1);
  });
});
