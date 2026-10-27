import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { TRUST_SIGNIN_GUIDANCE, TRUST_SIGNIN_KEYS, communityCloudConnected, trustSigninConnected } from '../../src/integrations/catalog.ts';
import type { EnvVar } from '../../src/store/env-store.ts';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const BASE_SHA = readFileSync(`${ROOT}docs/spikes/openvtc-signin/BASE_SHA`, 'utf8').split('\n')[0].trim();

/** The source text of `export const NAME = [ … ].join('\n');`. */
function constSource(src: string, name: string): string {
  const start = src.indexOf(`export const ${name} = [`);
  expect(start, name).toBeGreaterThan(-1);
  const end = src.indexOf("].join('\\n');", start);
  expect(end, `${name} terminator`).toBeGreaterThan(start);
  return src.slice(start, end);
}


describe('prompt guidance (S-70)', () => {
  it('S-70 TRUST_SIGNIN_GUIDANCE tells the model how to use the helper: import, the exact signIn call, alongside email, member_token, browser-only identity, no DID explanations, framework projects only', () => {
    const s: string = TRUST_SIGNIN_GUIDANCE;
    expect(s.length, 'guidance must not be empty').toBeGreaterThan(200);
    expect(s).toContain('./lib/trust-signin');
    expect(s).toMatch(/import\s*\{[^}]*\bsignIn\b[^}]*\}\s*from\s*["']\.\/lib\/trust-signin["']/);
    expect(s).toContain('signIn(env.TRUST_TASKS_URL, env.APP_ID, env.APP_KEY, { recipient: env.TRUST_TASKS_VID })');
    expect(s).toContain('Sign in with this device');
    expect(s).toMatch(/alongside/i);
    expect(s).toMatch(/email/i);
    expect(s).toContain('member_token');
    expect(s).toMatch(/auth_verify/);
    expect(s).toMatch(/this browser|this device/i);
    expect(s).toMatch(/new member/i);
    expect(s).toMatch(/DID/);
    expect(s).toMatch(/React|Vite/);
  });

  it('S-70 COMMUNITY_CLOUD_GUIDANCE is byte-identical to the base commit', () => {
    const base = execFileSync('git', ['show', `${BASE_SHA}:src/integrations/catalog.ts`], { cwd: ROOT, encoding: 'utf8' });
    const now = readFileSync(`${ROOT}src/integrations/catalog.ts`, 'utf8');
    expect(constSource(now, 'COMMUNITY_CLOUD_GUIDANCE')).toBe(constSource(base, 'COMMUNITY_CLOUD_GUIDANCE'));
  });

  it('S-70 trustSigninConnected(vars) is true iff Community Cloud is connected and TRUST_TASKS_URL and TRUST_TASKS_VID (= TRUST_SIGNIN_KEYS) are non-blank (C-26)', () => {
    expect(TRUST_SIGNIN_KEYS).toEqual(['TRUST_TASKS_URL', 'TRUST_TASKS_VID']);
    const v = (key: string, value: string): EnvVar => ({ key, value, isSecret: false });
    const cloud = [v('COMMUNITY_CLOUD_URL', 'https://x/functions/v1/app-data'), v('APP_ID', 'a'), v('APP_KEY', 'k')];
    const url = v('TRUST_TASKS_URL', 'https://x/functions/v1/app-trust-tasks');
    const vid = v('TRUST_TASKS_VID', 'did:web:x');
    expect(communityCloudConnected(cloud)).toBe(true);
    expect(trustSigninConnected([...cloud, url, vid])).toBe(true);
    expect(trustSigninConnected([...cloud, url])).toBe(false);
    expect(trustSigninConnected([...cloud, vid])).toBe(false);
    expect(trustSigninConnected([...cloud, url, v('TRUST_TASKS_VID', '   ')])).toBe(false);
    expect(trustSigninConnected([...cloud, v('TRUST_TASKS_URL', ''), vid])).toBe(false);
    // Community Cloud not connected → false even with both keys.
    expect(trustSigninConnected([url, vid])).toBe(false);
    expect(trustSigninConnected([cloud[0], cloud[1], url, vid])).toBe(false);
    expect(trustSigninConnected([...cloud.slice(0, 2), v('APP_KEY', ' '), url, vid])).toBe(false);
    expect(trustSigninConnected([])).toBe(false);
  });

  it('S-70 ChatPanel appends TRUST_SIGNIN_GUIDANCE right after COMMUNITY_CLOUD_GUIDANCE, gated by trustSigninConnected (C-26, grep)', () => {
    const src = readFileSync(`${ROOT}src/components/Chat/ChatPanel.tsx`, 'utf8');
    const cc = src.indexOf('COMMUNITY_CLOUD_GUIDANCE', src.indexOf('COMMUNITY_CLOUD_GUIDANCE') + 1);
    const usage = src.search(/trustSigninConnected\([^)]*\)[\s\S]{0,120}TRUST_SIGNIN_GUIDANCE/);
    expect(usage, 'trustSigninConnected(envVars) … TRUST_SIGNIN_GUIDANCE').toBeGreaterThan(-1);
    expect(cc).toBeGreaterThan(-1);
    expect(usage).toBeGreaterThan(cc);
    expect(usage - cc).toBeLessThan(400);
  });
});

describe('Builder wiring (S-71)', () => {
  it('S-71 community-cloud.ts sets TRUST_TASKS_URL = <supabase>/functions/v1/app-trust-tasks and TRUST_TASKS_VID = did:web:<hostname>[%3A<port>] (C-25), both public (false) next to APP_KEY', () => {
    const src = readFileSync(`${ROOT}src/cloud/community-cloud.ts`, 'utf8');
    const url = src.match(/setVar\(\s*['"]TRUST_TASKS_URL['"]\s*,([\s\S]*?),\s*false\s*\)/);
    const vid = src.match(/setVar\(\s*['"]TRUST_TASKS_VID['"]\s*,([\s\S]*?),\s*false\s*\)/);
    expect(url, "setVar('TRUST_TASKS_URL', …, false)").toBeTruthy();
    expect(vid, "setVar('TRUST_TASKS_VID', …, false)").toBeTruthy();
    // The URL / VID expressions may go through a helper; the rule is checked on the file.
    expect(src).toMatch(/functions\/v1\/app-trust-tasks|['"`/]app-trust-tasks['"`]/);
    expect(src).toContain('did:web:');
    // C-25: same rule as S-30 — hostname plus %3A<port>, never URL.host with a raw ':'.
    expect(src).toMatch(/\.hostname\b/);
    expect(src).toContain('%3A');
    expect(src).not.toMatch(/did:web:\$\{[^}]*\.host\}/);
    const appKey = src.indexOf("setVar('APP_KEY'");
    expect(appKey).toBeGreaterThan(-1);
    expect(Math.abs(src.indexOf("setVar('TRUST_TASKS_URL'") - appKey)).toBeLessThan(800);
  });
});
