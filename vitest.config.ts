/**
 * Vitest config for the app-trust-tasks spike tests (SPIKE-SPEC §12).
 *
 * Kept separate from vite.config.ts (which is untouched): discovery is limited
 * to tests/**, and .spike-deps/** (upstream repos with their own test files)
 * and node_modules/** are excluded. The aliases let Node resolve the edge
 * function's Deno `npm:` specifiers to the pinned devDependencies, and `@/`
 * to src/ as in the app.
 */
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const src = fileURLToPath(new URL('./src/', import.meta.url));

export default defineConfig({
  resolve: {
    alias: [
      { find: /^npm:@openvtc\/trust-tasks@[^/]+$/, replacement: '@openvtc/trust-tasks' },
      { find: /^npm:@openvtc\/trust-tasks@[^/]+\/(.*)$/, replacement: '@openvtc/trust-tasks/$1' },
      { find: /^npm:@openvtc\/trust-tasks-proof@[^/]+$/, replacement: '@openvtc/trust-tasks-proof' },
      { find: /^npm:@noble\/curves@[^/]+\/(.*)$/, replacement: '@noble/curves/$1' },
      { find: /^@\//, replacement: src },
    ],
  },
  test: {
    include: ['tests/**/*.test.ts'],
    exclude: ['.spike-deps/**', 'node_modules/**', '**/node_modules/**'],
    environment: 'node',
    setupFiles: ['tests/setup.ts'],
    testTimeout: 15_000,
  },
});
