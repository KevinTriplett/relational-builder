import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { KIT_FILES, kitFilesUsed, withKitFiles } from '../../src/kit/index.ts';
import { PINNED_VERSIONS, cdnUrl } from '../../src/preview/bundler/versions.ts';

const HELPER = fileURLToPath(new URL('../../src/kit/files/lib/trust-signin.ts', import.meta.url));

describe('kit wiring (S-63)', () => {
  it('S-63 kitFilesUsed materializes /src/lib/trust-signin.ts for ./lib/trust-signin and @/lib/trust-signin imports, with the file\'s exact contents', () => {
    const a = kitFilesUsed({ '/src/App.tsx': "import { signIn } from './lib/trust-signin'" });
    expect(Object.keys(a)).toContain('/src/lib/trust-signin.ts');
    const b = kitFilesUsed({ '/src/components/Login.tsx': "import { signIn } from '@/lib/trust-signin'" });
    expect(Object.keys(b)).toContain('/src/lib/trust-signin.ts');
    expect(KIT_FILES['/src/lib/trust-signin.ts']).toBe(readFileSync(HELPER, 'utf8'));
    expect(withKitFiles({ '/src/App.tsx': "import { signIn } from './lib/trust-signin'" })['/src/lib/trust-signin.ts']).toBe(readFileSync(HELPER, 'utf8'));
  });

  it('S-63 PINNED_VERSIONS pins @openvtc/trust-tasks-proof 0.1.3 and @noble/curves 2.4.0 for esm.sh', () => {
    expect(PINNED_VERSIONS['@openvtc/trust-tasks-proof']).toBe('0.1.3');
    expect(PINNED_VERSIONS['@noble/curves']).toBe('2.4.0');
    expect(cdnUrl('@openvtc/trust-tasks-proof')).toContain('@0.1.3');
    expect(cdnUrl('@noble/curves/ed25519.js')).toContain('@noble/curves@2.4.0/ed25519.js');
  });

  it('S-63 the helper uses bare specifiers only: @openvtc/trust-tasks (type-only), @openvtc/trust-tasks-proof, @noble/curves/ed25519.js — no npm: or @/ aliases', () => {
    const src = readFileSync(HELPER, 'utf8');
    const imports = [...src.matchAll(/^\s*(import|export)\s+(type\s+)?[^'"]*?from\s+['"]([^'"]+)['"]/gm)].map((m) => ({ typeOnly: !!m[2], spec: m[3] }));
    const dynamic = [...src.matchAll(/import\(\s*['"]([^'"]+)['"]\s*\)/g)].map((m) => m[1]);
    const specs = [...imports.map((i) => i.spec), ...dynamic];
    for (const s of specs) {
      expect(s, s).not.toMatch(/^npm:|^@\//);
      expect(['@openvtc/trust-tasks', '@openvtc/trust-tasks-proof', '@noble/curves/ed25519.js']).toContain(s);
    }
    expect(specs).toContain('@openvtc/trust-tasks-proof');
    expect(specs).toContain('@noble/curves/ed25519.js');
    for (const i of imports.filter((x) => x.spec === '@openvtc/trust-tasks')) expect(i.typeOnly, 'type-only import of @openvtc/trust-tasks').toBe(true);
  });
});
