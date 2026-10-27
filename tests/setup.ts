/**
 * NF-2: no network. Every test starts with a global `fetch` that refuses; the
 * code under test only ever receives the fake PostgREST's `fetch` (or a
 * scripted one) by injection.
 */
import { afterEach, beforeEach, vi } from 'vitest';

beforeEach(() => {
  vi.stubGlobal('fetch', (input: unknown) => {
    throw new Error(`NF-2: real network access attempted in a test: ${String(input)}`);
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
