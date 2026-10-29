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

interface Hunk { removed: string[]; added: Array<{ n: number; text: string }> }

/** Parse `git diff -U0` output; each added line carries its 1-based line number in the new file. */
function parseHunks(diff: string): Hunk[] {
  const out: Hunk[] = [];
  let next = 0;
  for (const line of diff.split('\n')) {
    const h = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (h) {
      out.push({ removed: [], added: [] });
      next = Number(h[1]);
    } else if (out.length && line.startsWith('-') && !line.startsWith('---')) out.at(-1)!.removed.push(line.slice(1));
    else if (out.length && line.startsWith('+') && !line.startsWith('+++')) out.at(-1)!.added.push({ n: next++, text: line.slice(1) });
  }
  return out;
}

function hunks(): Hunk[] {
  return parseHunks(execFileSync('git', ['diff', '--no-color', '-U0', BASE_SHA, '--', FILE], { cwd: ROOT, encoding: 'utf8' }));
}

/**
 * N-10: the only places a `did` change is permitted (S-52 / C-30) — `interface Member`,
 * `resolveMember` and `authVerify` — as 1-based inclusive line ranges of `src`. Each region
 * runs from its opening line to the next line that is exactly `}`.
 */
function permittedRegions(src: string): Array<[number, number]> {
  const lines = src.split('\n');
  const out: Array<[number, number]> = [];
  for (const head of [/^interface Member \{/, /^async function resolveMember\(/, /^async function authVerify\(/]) {
    const a = lines.findIndex((l) => head.test(l));
    expect(a, String(head)).toBeGreaterThan(-1);
    const b = lines.findIndex((l, i) => i > a && l === '}');
    expect(b, String(head)).toBeGreaterThan(a);
    out.push([a + 1, b + 1]);
  }
  return out;
}

/** An added line with every permitted `did` addition removed. */
const stripDid = (l: string) =>
  l.replace(/select=id,email,name,did\b/g, 'select=id,email,name').replace(/,\s*did:\s*[^,}]*?(?=\s*})/g, '').replace(/email: string \| null;/, 'email: string;');
const isDidField = (l: string) => /^\s*did\??:\s*string(\s*\|\s*null)?;\s*$/.test(l);

/** Every hunk must undo to the base once permitted `did` changes *inside the regions* are removed. */
function hunkProblems(hs: Hunk[], regions: Array<[number, number]>): string[] {
  const inRegion = (n: number) => regions.some(([a, b]) => n >= a && n <= b);
  const problems: string[] = [];
  for (const h of hs) {
    const added = h.added.filter((l) => !(inRegion(l.n) && isDidField(l.text))).map((l) => (inRegion(l.n) ? stripDid(l.text) : l.text));
    if (added.length !== h.removed.length || added.some((l, i) => l !== h.removed[i])) problems.push(JSON.stringify(h));
  }
  return problems;
}

/** The current file with permitted `did` changes inside the regions undone. */
function undoPermitted(src: string, regions: Array<[number, number]>): string {
  const inRegion = (n: number) => regions.some(([a, b]) => n >= a && n <= b);
  return src.split('\n').flatMap((l, i) => (inRegion(i + 1) ? (isDidField(l) ? [] : [stripDid(l)]) : [l])).join('\n');
}

describe('app-data changes (S-52)', () => {
  it('S-52 / N-10 every hunk in app-data/index.ts since BASE_SHA is a member select list gaining did, a member object gaining did, or the Member type tolerating email null / gaining did — inside resolveMember, authVerify or interface Member only', () => {
    const now = readFileSync(ROOT + FILE, 'utf8');
    expect(hunkProblems(hunks(), permittedRegions(now))).toEqual([]);
  });

  it('S-52 / N-10 the email path is otherwise byte-identical: undoing the permitted did changes inside the three regions yields the base file', () => {
    const base = execFileSync('git', ['show', `${BASE_SHA}:${FILE}`], { cwd: ROOT, encoding: 'utf8' });
    const now = readFileSync(ROOT + FILE, 'utf8');
    expect(undoPermitted(now, permittedRegions(now))).toBe(base);
  });

  it('N-10 (G2 self-check) the region-scoped matcher accepts in-region did changes and refuses the same changes elsewhere', () => {
    const base = [
      'interface Other {', '  id: string;', '}',
      'interface Member {', '  id: string;', '  email: string;', '}',
      'async function resolveMember(a) {', '  f(`/app_members?select=id,email,name`);', '}',
      'async function authVerify(a) {', '  return json({ member: { id: m.id } });', '}',
      'function other() {', '  f(`/x?select=id,email,name`);', '  return { id: x };', '}',
    ].join('\n');
    const good = base
      .replace('  email: string;\n}', '  email: string | null;\n  did: string | null;\n}')
      .replace('select=id,email,name`', 'select=id,email,name,did`')
      .replace('{ id: m.id }', '{ id: m.id, did: m.did }');
    const goodRegions = permittedRegions(good);
    expect(goodRegions).toEqual([[4, 8], [9, 11], [12, 14]]);
    expect(undoPermitted(good, goodRegions)).toBe(base);
    const strays = [
      base.replace('interface Other {\n  id: string;\n}', 'interface Other {\n  id: string;\n  did: string | null;\n}'),
      base.replace('{ id: x }', '{ id: x, did: y }'),
      base.replace('/x?select=id,email,name`', '/x?select=id,email,name,did`'),
    ];
    for (const stray of strays) expect(undoPermitted(stray, permittedRegions(stray)), stray).not.toBe(base);
    // parseHunks numbers added lines from the @@ header's new-file start.
    const parsed = parseHunks('@@ -2 +2,2 @@ ctx\n-  id: string;\n+  id: string;\n+  did: string | null;\n');
    expect(parsed).toEqual([{ removed: ['  id: string;'], added: [{ n: 2, text: '  id: string;' }, { n: 3, text: '  did: string | null;' }] }]);
    expect(hunkProblems(parsed, [[1, 4]])).toEqual([]);
    expect(hunkProblems(parsed, [[10, 12]])).toHaveLength(1);
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
