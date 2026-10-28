/**
 * S-52: `git diff <BASE_SHA> -- supabase/functions/app-data/index.ts` touches
 * only the member `select` lists (resolveMember, authVerify) and adds `did`
 * to returned member objects. Pure-spec: it passes or fails depending on the
 * state of app-data relative to the base.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const BASE_SHA = readFileSync(`${ROOT}docs/spikes/openvtc-signin/BASE_SHA`, 'utf8').split('\n')[0].trim();
const FILE = 'supabase/functions/app-data/index.ts';

function hunks(): Array<{ removed: string[]; added: string[] }> {
  const diff = execFileSync('git', ['diff', '--no-color', '-U0', BASE_SHA, '--', FILE], { cwd: ROOT, encoding: 'utf8' });
  const out: Array<{ removed: string[]; added: string[] }> = [];
  for (const line of diff.split('\n')) {
    if (line.startsWith('@@')) out.push({ removed: [], added: [] });
    else if (out.length && line.startsWith('-') && !line.startsWith('---')) out.at(-1)!.removed.push(line.slice(1));
    else if (out.length && line.startsWith('+') && !line.startsWith('+++')) out.at(-1)!.added.push(line.slice(1));
  }
  return out;
}

/** An added line with every permitted `did` addition removed. */
const stripDid = (l: string) =>
  l.replace(/select=id,email,name,did\b/g, 'select=id,email,name').replace(/,\s*did:\s*[^,}]*?(?=\s*})/g, '').replace(/email: string \| null;/, 'email: string;');
const isDidField = (l: string) => /^\s*did\??:\s*string(\s*\|\s*null)?;\s*$/.test(l);

describe('app-data changes (S-52)', () => {
  it('S-52 every hunk in app-data/index.ts since BASE_SHA is a member select list gaining did, a member object gaining did, or the Member type tolerating email null / gaining did', () => {
    for (const h of hunks()) {
      const added = h.added.filter((l) => !isDidField(l));
      expect(added.length, JSON.stringify(h)).toBe(h.removed.length);
      added.forEach((l, i) => expect(stripDid(l), JSON.stringify(h)).toBe(h.removed[i]));
    }
  });

  it('S-52 the email path is otherwise byte-identical: removing the permitted did changes from the current file yields the base file', () => {
    const base = execFileSync('git', ['show', `${BASE_SHA}:${FILE}`], { cwd: ROOT, encoding: 'utf8' });
    const now = readFileSync(ROOT + FILE, 'utf8');
    const back = now.split('\n').filter((l) => !isDidField(l)).map(stripDid).join('\n');
    expect(back).toBe(base);
  });

  it('S-52 resolveMember and authVerify select did (select=id,email,name,did) and authVerify\'s returned member carries did', () => {
    const now = readFileSync(ROOT + FILE, 'utf8');
    const resolve = now.slice(now.indexOf('async function resolveMember'), now.indexOf('async function ownershipCheck'));
    const verify = now.slice(now.indexOf('async function authVerify'));
    expect(resolve).toContain('select=id,email,name,did');
    expect(verify.slice(0, verify.indexOf('\n}\n'))).toContain('select=id,email,name,did');
    expect(verify).toMatch(/member:\s*\{\s*id: member\.id, email: member\.email, name: member\.name, did: member\.did/);
  });
});
