# Raw notice archive and slow backfill

## Approved scope

- Keep the project's Node/GitHub Actions → Worker architecture. University HTTPS remains Node-side with the verified, scoped intermediate certificate.
- Archive all six current notice boards: original article-body HTML, attachment links and image links. Do **not** download attachment/image binaries or recover posts already removed from the official site.
- Use one private R2 bucket for files and existing D1 for searchable metadata, raw indexes and resumable progress.
- Separate source data from future derived results. This phase makes **no notice OpenRouter calls** and creates no fake processed objects.
- Keep existing recent title/link notifications. Historical imports must not create alerts or reset live baselines.

```text
Official site → Node parser → authenticated Worker
                                ├─ R2 raw/<source>/<id>.json
                                ├─ D1 archive index / progress
                                └─ ordinary recent snapshot → existing Discord outbox

Later, separately implemented:
R2 raw → OpenRouter → R2 processed/<source>/<id>.json → Discord
```

`raw/` and `processed/` are object-key prefixes, not Git folders or persistent directories on an Actions runner. `processed/` has no objects until real processing is implemented. No new npm dependencies are required.

## Storage contract

Raw JSON contains `version`, `notice` (source/ID/title/date/official URL), exact `bodyHtml`, `attachments`, `imageUrls`, `capturedAt`, and `contentHash`. College bodies preserve the original article fragment, not the entire page template. University bodies come from the official detail API. HTML is untrusted data: never execute or publicly render it as trusted HTML.

**One first capture per `(source,id)` is retained.** Conditional R2 writes preserve that first object; retries reconcile a successful object write with a failed index write. This is not a notice-revision archive or a guarantee of the latest body. Normal metadata can still update independently. Do not describe a future summary of this object as newly verified current content. Same-date meal revision handling is not added or changed.

Bodies are limited to 1 MiB UTF-8; signed archive requests to 2 MiB; references to 100 attachment and 100 image URLs. Raw HTML is not duplicated into D1 jobs. The private bucket must not have public access enabled. Do not independently delete its objects: an existing D1 index assumes its object is retained.

Image-only notices retain original HTML and image references, **not image bytes**. Later vision processing depends on those images still being accessible. Recognized file references are preserved; unknown historical attachment formats fail explicitly rather than silently dropping files.

## Activation — external changes require separate approval

The checked-in Worker default is `NOTICE_ARCHIVE_ENABLED = "false"`. Existing notice polling continues without raw capture until activation. No bucket, remote migration, deployment, workflow dispatch or live backfill was performed by adding this implementation.

After approval:

1. Enable R2 for the account and create a **private Standard** bucket, for example `sogang-notice-archive`. Check billing first. R2 Standard includes 10 GB-month storage, 1 million Class A and 10 million Class B operations monthly; usage above the free allowance can be billed. This is not an absolute free-cost ceiling.
2. Add the binding to `wrangler.toml`:

   ```toml
   [[r2_buckets]]
   binding = "NOTICE_ARCHIVE"
   bucket_name = "sogang-notice-archive"
   ```

3. Apply the additive migration, keeping existing notices/baselines/resources:

   ```sh
   npx wrangler d1 migrations apply sogang-friends --remote
   ```

4. Set Worker `[vars]` `NOTICE_ARCHIVE_ENABLED = "true"`, then deploy. The archive route returns 503 until the flag, binding and existing shared secret are present.
5. Push reviewed code after approval. Keep existing Actions variable `NOTICE_INGEST_URL` and secret `NOTICE_INGEST_SECRET`; no R2/account token is given to Actions. Set Actions variable `NOTICE_ARCHIVE_ENABLED=true`.
6. Manually run **collect notices** first. It captures missing recent raw articles before sending the existing metadata snapshot. The initial raw capture may take longer; successfully saved articles are reused after partial failures. Check all six source outcomes.
7. Set Actions variable `NOTICE_BACKFILL_ENABLED=true`. Run **backfill notice archive** with its `start` input checked **once**. `start` inserts absent page-1 cursors and never resets existing or completed progress. Scheduled runs do not auto-start a backfill.
8. Inspect R2 `raw/`, Actions source/page logs and D1 progress:

   ```sql
   SELECT source,page,state,started_at,updated_at
   FROM notice_archive_progress ORDER BY source;
   SELECT source,COUNT(*) AS captured FROM notice_archive GROUP BY source;
   SELECT source,status,COUNT(*) AS unavailable
   FROM notice_archive_unavailable GROUP BY source,status;
   ```

The original `NOTICE_INGEST_SECRET` authenticates POST `/internal/notice-archive`; archive responses are synchronous HTTP 200 acknowledgements, not the ordinary queued-snapshot HTTP 202. Exact signed bytes are retried at most three times. Body reads have a ten-second deadline and signatures a five-minute freshness window.

## Slow, resumable historical traversal

The new workflow runs at **00:40, 06:40, 12:40, 18:40 UTC** (09:40, 15:40, 21:40, 03:40 KST), gated off unless `NOTICE_BACKFILL_ENABLED=true`. It shares the `notice-collector` concurrency group with recent polling.

Each invocation attempts at most **six list pages total**, not six per board. Oldest persisted progress is preferred so boards share the budget. Historical source requests have additional three-second spacing. A roughly seven-minute processing budget pauses between records; a slow in-flight request can extend that budget. The workflow has a separate thirty-minute job timeout for initial recent capture and historical work. There is no guaranteed completion date: source counts, pins, latency and failures vary.

Raw records are durable individually, but a cursor moves only when **every ID on its page** is durably captured or marked definitively unavailable. The historical metadata insert and cursor update are one D1 transaction. Restarting reuses prior objects/markers rather than repeating their detail fetches. A failed source does not stop healthy sources; any incomplete recent or historical phase still makes the Actions run report failure.

Historical completion uses official pagination evidence. A malformed page, unexpected API shape, title/detail mismatch, 429, 5xx or transport failure is **not** EOF. Actual detail HTTP **404/410** receives a durable unavailable marker, no fake raw object and no alert; that ID does not block the historical page. Unverified HTTP-200 error payloads are not guessed to mean deletion.

Normal polling remains limited to the recent window. It does not treat an old unavailable marker as proof that a recent article is still unavailable. An article restored in the recent range can be captured normally.

### Live-alert boundary

Backfill commits never create alert/delivery jobs or update live collection health. They insert old metadata without overwriting an existing live row. A source's immutable `started_at` defines its KST start day: publications on/after that day are **not** inserted into live deduplication by backfill, so regular polling can still notify them. This boundary uses the official publication date; a newly added, deliberately backdated post can still be classified as historical.

The site uses mutable page numbers, not a snapshot API. Insertion/deletion during a long traversal can shift page boundaries. Completion means validated traversal of exposed pages, **not a guaranteed immutable point-in-time copy of the whole site**. Do not try to recover already deleted content.

## Pause / resume / local checks

- Set Actions `NOTICE_BACKFILL_ENABLED=false` to pause future historical runs. Recent raw capture can continue. Re-enable it to resume existing cursors; do not reset/delete progress or captured objects.
- Do not independently delete the R2 bucket, archive indexes or progress. Source failures need investigation, not a fabricated terminal-page flag.
- Offline verification: `npm run check`, `npm audit`, Wrangler dry-run.
- `npm run notices:backfill -- --dry-run` makes real read-only source requests for at most one first page and its articles; no uploads/checkpoints/models. Do not confuse it with offline tests.
- Only after upload approval and securely configured environment:

  ```sh
  npm run notices:backfill -- --send --start  # initialize absent cursors, then a bounded run
  npm run notices:backfill -- --send          # resume
  npm run notices:backfill -- --send --pages 2
  ```

Local send mode requires `NOTICE_ARCHIVE_ENABLED=true`, the verified CA launcher, `NOTICE_INGEST_URL` and the shared secret. Unlike the workflow, a direct CLI invocation does not first run recent polling; the immutable start-day boundary still applies.

## OpenRouter policy

The user confirmed at least US$10 in credits: free-model quota **1,000 requests/day, 20/minute**. `AGENTS.md` records that allowance as shared across uses, not per feature. Paid credit does not authorize paid models or fallbacks. Current meal-specific limits remain unchanged. A cross-feature rate limiter and notice processing are **not implemented by this archive phase**.

Sources: [D1 limits](https://developers.cloudflare.com/d1/platform/limits/), [R2 pricing](https://developers.cloudflare.com/r2/pricing/), [R2 conditional operations](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/#conditional-operations).
