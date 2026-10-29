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
const HELPER = `${ROOT}src/kit/files/lib/trust-signin.ts`;

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

  it('NF-5 / C-49 per-file // SPIKE: markers, each listed phrase on the same line as a // SPIKE: (core.ts ≥ 9, status.ts ≥ 1, replay.ts ≥ 1, index.ts ≥ 1, trust-signin.ts ≥ 2)', () => {
    const files = {
      core: read(`${FN}core.ts`),
      status: read(`${FN}status.ts`),
      replay: read(`${FN}replay.ts`),
      index: read(`${FN}index.ts`),
      helper: read(HELPER),
    };
    const missing: string[] = [];
    const need = (file: keyof typeof files, ...phrases: string[]) => {
      if (!hasMarker(files[file], ...phrases)) missing.push(`${file}: ${phrases.join(' + ')}`);
    };
    if (!spikeLines(files.core).some((l) => l.trim() === '// SPIKE: unsigned responses; local_vid is a label')) missing.push('core: exact S-30 line');
    need('core', 'consume-before-compare');
    need('core', 'unsigned', '#response');
    need('core', 'subset validator');
    need('core', 'per-app', 'rateLimited');
    need('core', 'expiry before mismatch');
    need('core', 'envelope');
    need('core', 'self-enrolment');
    need('core', 'audience');
    need('status', 'retained error');
    need('replay', 'retention pad');
    need('index', 'OPTIONS');
    need('helper', 'software');
    need('helper', 'shared origin');
    expect(missing, 'C-49 phrases not found on a // SPIKE: line').toEqual([]);
    const minimum: Record<keyof typeof files, number> = { core: 9, status: 1, replay: 1, index: 1, helper: 2 };
    for (const [f, n] of Object.entries(minimum)) expect(spikeLines(files[f as keyof typeof files]).length, f).toBeGreaterThanOrEqual(n);
  });

  it('C-38 the helper\'s shared origin marker sits at the key-storage site: inside identityKeyForApp, or in the comment immediately above the store.put in getOrCreateIdentity', () => {
    expect(markerAtKeyStorage(read(HELPER))).toBe(true);
  });

  it('C-38 the helper\'s header comment no longer says, without qualification, that the private key never leaves the device: it says the key cannot be exported and that any script on the same origin can use it', () => {
    const header = headerComment(read(HELPER));
    expect(header.length).toBeGreaterThan(0);
    expect(header).toMatch(/export/i);
    expect(header).toMatch(/same[- ]origin/i);
  });

  it('C-49 / C-38 (G2 self-check) the marker matchers on concrete inputs', () => {
    const src = [
      '// header line one',
      '// The key cannot be exported, but any script on the same origin can use it.',
      '',
      'import x from "y";',
      '// SPIKE: per-app limiter; never auth/challenge:rateLimited',
      '// rateLimited on a plain comment does not count',
      'export function identityKeyForApp(appId: string): string {',
      '  // SPIKE: shared origin — every hosted app can use this key',
      '  return PREFIX + appId;',
      '}',
      'async function getOrCreateIdentity() {',
      '  // SPIKE: software custody',
      '  //   continued',
      '  await store.put(key, record);',
      '}',
    ].join('\n');
    expect(spikeLines(src)).toHaveLength(3);
    expect(hasMarker(src, 'per-app', 'rateLimited')).toBe(true);
    expect(hasMarker(src, 'per-app', 'missing')).toBe(false);
    expect(hasMarker(src, 'does not count')).toBe(false);
    expect(headerComment(src)).toMatch(/same origin/);
    expect(headerComment(src)).not.toMatch(/SPIKE/);
    expect(markerAtKeyStorage(src)).toBe(true);
    const abovePut = src.replace('// SPIKE: shared origin — every hosted app can use this key', '// nothing').replace('// SPIKE: software custody', '// SPIKE: shared origin, software custody');
    expect(markerAtKeyStorage(abovePut)).toBe(true);
    const elsewhere = src.replace('  // SPIKE: shared origin — every hosted app can use this key', '  // nothing').replace('import x from "y";', 'import x from "y";\n// SPIKE: shared origin');
    expect(markerAtKeyStorage(elsewhere)).toBe(false);
  });
});

/** Lines that carry a `// SPIKE:` marker. */
function spikeLines(src: string): string[] {
  return src.split('\n').filter((l) => l.includes('// SPIKE:'));
}
/** True when one `// SPIKE:` line contains every phrase (C-49: same line). */
function hasMarker(src: string, ...phrases: string[]): boolean {
  return spikeLines(src).some((l) => phrases.every((p) => l.includes(p)));
}
/** The leading `//` comment block of a file, before the first non-comment line. */
function headerComment(src: string): string {
  const out: string[] = [];
  for (const l of src.split('\n')) {
    if (!l.trim().startsWith('//')) break;
    out.push(l);
  }
  return out.join('\n');
}
/** C-38 placement: a `// SPIKE: … shared origin` line inside identityKeyForApp, or in the comment run directly above a `store.put(`. */
function markerAtKeyStorage(src: string): boolean {
  const lines = src.split('\n');
  const fn = lines.findIndex((l) => /function identityKeyForApp\s*\(/.test(l));
  const fnEnd = fn === -1 ? -1 : lines.findIndex((l, i) => i > fn && /^}\s*$/.test(l));
  return lines.some((l, i) => {
    if (!(l.includes('// SPIKE:') && l.includes('shared origin'))) return false;
    if (fn !== -1 && i > fn && i < fnEnd) return true;
    let j = i + 1;
    while (j < lines.length && lines[j].trim().startsWith('//')) j++;
    return j < lines.length && lines[j].includes('store.put(');
  });
}
