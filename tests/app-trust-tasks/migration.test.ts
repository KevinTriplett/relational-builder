/**
 * S-10 / S-11 by statement-level parsing. No Postgres is available (pg-mem and
 * embedded Postgres cannot be installed — NF-3), so the behavioural oracles
 * that need a real database are `it.todo` (SPIKE-SPEC §12).
 */
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const DIR = fileURLToPath(new URL('../../supabase/migrations/', import.meta.url));

function migration(): { name: string; sql: string } {
  const matches = readdirSync(DIR).filter((f) => /_trust_tasks_signin\.sql$/.test(f));
  expect(matches, 'exactly one supabase/migrations/<timestamp>_trust_tasks_signin.sql').toHaveLength(1);
  return { name: matches[0], sql: readFileSync(DIR + matches[0], 'utf8') };
}

/** Lower-cased, comments stripped, whitespace collapsed. */
function normalize(sql: string): string {
  return sql
    .replace(/--[^\n]*/g, ' ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/\s*([(),;])\s*/g, '$1')
    .toLowerCase()
    .trim();
}

/** Split into top-level statements, keeping `do $$ … $$` blocks whole. */
function statements(sql: string): string[] {
  const n = normalize(sql);
  const out: string[] = [];
  let cur = '';
  let inDollar = false;
  for (let i = 0; i < n.length; i++) {
    if (n.startsWith('$$', i)) {
      inDollar = !inDollar;
      cur += '$$';
      i++;
      continue;
    }
    if (n[i] === ';' && !inDollar) {
      if (cur.trim()) out.push(cur.trim());
      cur = '';
      continue;
    }
    cur += n[i];
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

function createTable(stmts: string[], table: string): string {
  const s = stmts.find((x) => new RegExp(`^create table if not exists (public\\.)?${table}\\(`).test(x));
  expect(s, `create table if not exists public.${table}(…)`).toBeTruthy();
  return s!;
}

/** Column definitions of a create-table statement, by name. */
function columns(stmt: string): Map<string, string> {
  const body = stmt.slice(stmt.indexOf('(') + 1, stmt.lastIndexOf(')'));
  const parts: string[] = [];
  let depth = 0;
  let cur = '';
  for (const ch of body) {
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (ch === ',' && depth === 0) {
      parts.push(cur.trim());
      cur = '';
    } else cur += ch;
  }
  if (cur.trim()) parts.push(cur.trim());
  return new Map(parts.map((p) => [p.split(' ')[0], p.slice(p.indexOf(' ') + 1)]));
}

describe('migration (S-10, S-11)', () => {
  it('S-10 file is supabase/migrations/<14-digit timestamp>_trust_tasks_signin.sql', () => {
    const { name } = migration();
    expect(name).toMatch(/^\d{14}_trust_tasks_signin\.sql$/);
  });

  it('S-10 app_members: email drops NOT NULL; did added if not exists; unique partial index (app_id, did) where did is not null', () => {
    const s = statements(migration().sql);
    expect(s).toContain('alter table public.app_members alter column email drop not null');
    expect(s).toContain('alter table public.app_members add column if not exists did text');
    expect(s).toContain('create unique index if not exists app_members_app_did_idx on public.app_members(app_id,did)where did is not null');
  });

  it('S-10 app_members_identity_chk check (email is not null or did is not null), added inside a guarded do $$ … $$ block', () => {
    const s = statements(migration().sql);
    const block = s.find((x) => x.startsWith('do $$') && x.includes('app_members_identity_chk'));
    expect(block, 'constraint add wrapped in do $$ … $$').toBeTruthy();
    expect(block).toMatch(/add constraint app_members_identity_chk check\(\(?email is not null or did is not null\)?\)/);
    expect(block).toMatch(/pg_constraint|duplicate_object/);
    // No unguarded add constraint anywhere.
    for (const x of s.filter((y) => !y.startsWith('do $$'))) expect(x).not.toContain('add constraint');
  });

  it('S-10 cloud_apps.trust_signin_enabled boolean not null default false (if not exists)', () => {
    expect(statements(migration().sql)).toContain('alter table public.cloud_apps add column if not exists trust_signin_enabled boolean not null default false');
  });

  it('S-10 app_tt_challenges table: columns, types, FK on delete cascade, and index (app_id, expires_at)', () => {
    const s = statements(migration().sql);
    const cols = columns(createTable(s, 'app_tt_challenges'));
    expect([...cols.keys()].sort()).toEqual(['app_id', 'challenge', 'consumed_at', 'created_at', 'expires_at', 'session_id', 'subject']);
    expect(cols.get('session_id')).toBe('text primary key');
    expect(cols.get('app_id')).toBe('uuid not null references public.cloud_apps(id)on delete cascade');
    expect(cols.get('subject')).toBe('text');
    expect(cols.get('challenge')).toBe('text not null');
    expect(cols.get('expires_at')).toBe('timestamptz not null');
    expect(cols.get('consumed_at')).toBe('timestamptz');
    expect(cols.get('created_at')).toBe('timestamptz not null default now()');
    expect(s.some((x) => /^create index if not exists \w+ on public\.app_tt_challenges\(app_id,expires_at\)$/.test(x))).toBe(true);
  });

  it('S-10 / S-11 app_tt_replay table keyed on doc_id alone: columns, types, FK, index (until_at)', () => {
    const s = statements(migration().sql);
    const cols = columns(createTable(s, 'app_tt_replay'));
    expect([...cols.keys()].sort()).toEqual(['app_id', 'digest', 'doc_id', 'response', 'until_at']);
    expect(cols.get('doc_id')).toBe('text primary key');
    expect(cols.get('app_id')).toBe('uuid not null references public.cloud_apps(id)on delete cascade');
    expect(cols.get('digest')).toBe('text not null');
    expect(cols.get('response')).toBe('jsonb');
    expect(cols.get('until_at')).toBe('timestamptz not null');
    expect(s.some((x) => /^create index if not exists \w+ on public\.app_tt_replay\(until_at\)$/.test(x))).toBe(true);
  });

  it('S-10 RLS enabled on both new tables, with no policies (service-role only)', () => {
    const s = statements(migration().sql);
    expect(s).toContain('alter table public.app_tt_challenges enable row level security');
    expect(s).toContain('alter table public.app_tt_replay enable row level security');
    expect(s.filter((x) => x.includes('create policy'))).toEqual([]);
  });

  it('S-10 additive and re-runnable: every create/add is guarded, nothing is dropped or rewritten', () => {
    const s = statements(migration().sql);
    for (const x of s) {
      if (/^create (unique )?index/.test(x)) expect(x).toContain('if not exists');
      if (/^create table/.test(x)) expect(x).toContain('if not exists');
      if (/add column/.test(x)) expect(x).toContain('add column if not exists');
      expect(x).not.toMatch(/\bdrop (table|column|index|constraint|policy)\b/);
      expect(x).not.toMatch(/^(delete from|truncate|update )/);
    }
  });

  it.todo('S-10 (needs real Postgres) applying the migration twice: the second run is a no-op');
  it.todo('S-10 (needs real Postgres) existing app_members rows remain valid after the migration');
  it.todo('S-10 (needs real Postgres) inserting an app_members row with did null and email null fails app_members_identity_chk');
  it.todo('S-10 (needs real Postgres) a duplicate (app_id, did) fails; two rows with did null in one app succeed');
  it.todo('S-10 (needs real Postgres) deleting a cloud_apps row cascades to app_tt_challenges and app_tt_replay');
  it.todo('S-10 (needs real Postgres) RLS: the anon/authenticated roles can read nothing from app_tt_challenges / app_tt_replay');
});
