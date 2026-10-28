# TEST-DISPUTE — tests the implementation agent believes are wrong

Per BRIEF-I.md §1 rule 1: the tests are not edited; each disputed test is listed here with the
spec sentence it contradicts, quoted exactly.

## D-1 · `tests/app-trust-tasks/app-data.snapshot.test.ts` — `stripDid` eats the space before `}`

**RESOLVED (T):** the test was wrong. `stripDid`'s greedy `[^,}]+` swallowed the space before `}`. Changed it to the lazy `[^,}]*?`, so the whitespace before `}` survives. All three S-52 tests now pass, and they still go red on an unpermitted hunk (checked, then restored).

**Tests (both fail):**
- `S-52 every hunk in app-data/index.ts since BASE_SHA is a member select list gaining did, a member object gaining did, or the Member type tolerating email null / gaining did`
- `S-52 the email path is otherwise byte-identical: removing the permitted did changes from the current file yields the base file`

**Spec sentence contradicted (SPIKE-SPEC §8, S-52):**
> `git diff <BASE_SHA> -- supabase/functions/app-data/index.ts` touches only: `select=id,email,name` → `select=id,email,name,did` in `resolveMember` and `authVerify`; returned `member` objects gain `did` (null for email members). No other hunk.

**Why the tests are wrong.** The diff contains only the permitted hunks (four: the two
`select=` lists, the two `interface Member` lines per C-30, and the returned member object).
The member-object hunk is

```diff
-  return json({ ok: true, member_token: token, member: { id: member.id, email: member.email, name: member.name } });
+  return json({ ok: true, member_token: token, member: { id: member.id, email: member.email, name: member.name, did: member.did } });
```

`stripDid` undoes it with `/,\s*did:\s*[^,}]+(?=\s*})/g`. The greedy `[^,}]+` also consumes
the space before `}` (the lookahead `\s*}` then matches zero spaces), so the line strips to
`…name: member.name} });`, one space short of the base `…name: member.name } });`.

The only spelling that survives `stripDid` puts a space *before* the comma
(`name: member.name , did: member.did }`). That spelling fails the third test in the same file,
`S-52 resolveMember and authVerify select did … and authVerify's returned member carries did`,
whose regex requires `name: member\.name, did: member\.did`. No single line satisfies all
three, so the file contradicts itself; the third test matches the spec and the conventional
spelling, so the implementation follows it.

**Suggested fix (for the test agent):** make the lookahead keep the whitespace, e.g.
`/,\s*did:\s*[^,}]*?(?=\s*})/g` (lazy), which maps the natural line back to the base exactly. Checked outside the test tree: with that
regex, the current `app-data/index.ts` reduces to the BASE_SHA file byte for byte.
