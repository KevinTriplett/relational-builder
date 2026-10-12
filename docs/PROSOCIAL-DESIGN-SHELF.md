# Prosocial Design shelf

The Prosocial Design Network's [Digital Intervention Library](https://www.prosocialdesign.org)
as a commons shelf (`prosocial-design`): all 57 public patterns plus one
reference card that explains PDN's evidence ratings and how to read them at
neighborhood scale. Seed file: `scripts/seed/prosocial-design-commons.json`.

- **License:** library content is CC BY-SA 4.0 (PDN Terms of Use, section 4).
  Every item carries `license: "CC BY-SA 4.0"`, PDN attribution, the source
  page URL, and a footer naming the change (reformatted only) and the
  library's citation DOI (10.17605/OSF.IO/Q4RMB).
- **Each pattern** (`kind: recipe`, slug `psd-<pdn-slug>`): PDN's goal,
  evidence rating, civic signal and when-to-use up top, then What it is /
  Intended impact / Evidence / Why it matters / Special considerations /
  Citations, text as published. Rating, signal and citations are also in
  `metadata`; retrieval filters ride as tags (`pdn-rating:likely`,
  `civic-signal:connect`, `when:proactive`). Card images are PDN's own
  illustrations, linked from their CDN.
- **In the app:** a "Prosocial design" chip in the Commons Gallery
  (`fetchProsocialDesignCards`); pattern cards are labeled "design pattern".

## Seeding (needs the commons Supabase token)

```bash
SUPABASE_ACCESS_TOKEN=... node scripts/seed-commons-shelf.mjs scripts/seed/prosocial-design-commons.json --apply
```

Then run the `embed-commons` job for the new rows so retrieval surfaces them.

Seeded and embedded 2026-10-12 (58 rows, `embed-commons` with `item_ids`,
all 58 processed).

## Known cleanup

About 60 of the 102 `metadata.citations` entries carry a stray icon glyph
(U+F08E) as `id` where the scraper caught PDN's external-link icon instead
of a DOI. Nothing renders that field yet; fix in the seed file and re-run
the seeder with `--apply` (upsert is safe), then re-embed those ids.

Imported 2026-10-11 from the library pages as published that day.
