# Raw notice archive and slow backfill

## Approved scope

- Keep the project's Node/GitHub Actions → Worker architecture. University HTTPS remains Node-side with the verified, scoped intermediate certificate.
- Archive all six current notice boards: original article-body HTML, attachment links and image links. Do **not** download attachment/image binaries or recover posts already removed from the official site.
- Use the **existing D1 database only** for original article content, searchable metadata, raw indexes and resumable progress. R2 is no longer required: there is no bucket, new storage service or Cloudflare card-registration step for this archive.
- Separate source data from future derived results. This phase makes **no notice OpenRouter calls** and creates no fake processed objects.
- Keep existing recent title/link notifications. Historical imports must not create alerts or reset live baselines.

```text
Official site → Node parser → authenticated Worker
                                ├─ D1 notice_archive_raw (original HTML + links)
                                ├─ D1 notice_archive / notice_archive_progress
                                └─ ordinary recent snapshot → existing Discord outbox

Later, separately implemented:
D1 raw → OpenRouter → separately stored derived results → Discord
```

`raw/<source>/<id>.json` remains a **logical identity** in `notice_archive.raw_key`, not a physical file, Git path or R2 object. Original content lives in `notice_archive_raw`: `notice_json`, `body_html TEXT`, `attachments_json`, `image_urls_json`, `version`, `content_hash` and `captured_at`, keyed by `(source,id)`. These columns preserve the raw JSON record's fields without escaping the HTML into one large JSON column. `processed/` is reserved terminology for a later real processing stage; no processed table or fake outputs are created now. No new npm dependencies are required.

## Storage contract

Raw JSON contains `version`, `notice` (source/ID/title/date/official URL), exact `bodyHtml`, `attachments`, `imageUrls`, `capturedAt`, and `contentHash`. College bodies preserve the original article fragment, not the entire page template. University bodies come from the official detail API. HTML is untrusted data: never execute or publicly render it as trusted HTML.

**One first capture per `(source,id)` is retained.** An atomic D1 batch inserts raw content and its index together; `INSERT OR IGNORE` retains the first stored row, and the index is derived from that winning row. A failed transaction can be retried without leaving a body/index mismatch. This is not a notice-revision archive or a guarantee of the latest body. Normal metadata can still update independently. Do not describe a future summary of this capture as newly verified current content. Same-date meal revision handling is not added or changed.

Bodies are limited to 1 MiB UTF-8; signed archive requests to 2 MiB; references to 100 attachment and 100 image URLs. The sum of UTF-8 body/metadata/reference column bytes must be at most **1,900,000 bytes**, leaving headroom below D1's **2,000,000-byte row maximum**. Raw HTML is not duplicated into D1 jobs. Do not independently delete raw rows or their indexes.

D1 Free has a **500 MB per-database limit**, even though the account-wide storage allowance is larger. The full historical archive has not been sized, so fitting all notices is not guaranteed. This shares capacity with existing notices, schedules, meals, jobs and deliveries. New captures stop when supported D1 query metadata reports database size at or above **400 MB**, leaving approximately 100 MB for live bot state. Existing capture replays remain available; missing size metadata also stops new captures. This is a headroom guard, not an exact storage reservation: concurrent writes and the last accepted capture may cross 400 MB slightly. Monitor size during backfill. No old captures are deleted; the last committed cursor is retained.

Image-only notices retain original HTML and image references, **not image bytes**. Later vision processing depends on those images still being accessible. Recognized file references are preserved; unknown historical attachment formats fail explicitly rather than silently dropping files.

## Activation — external changes require separate approval

The checked-in Worker default is `NOTICE_ARCHIVE_ENABLED = "false"`. Existing notice polling continues without raw capture until activation. This D1 conversion does not itself apply remote migrations, deploy, enable Actions variables, dispatch a workflow or execute live backfill.

After separate operating approval:

1. Apply additive **0003 and 0004** to the existing database, keeping notices/baselines/resources:

   ```sh
   npx wrangler d1 migrations apply sogang-friends --remote
   ```

   `0003_notice_archive.sql` creates archive indexes, progress and unavailable markers; `0004_notice_archive_raw.sql` adds D1 original-content storage. No R2 binding or bucket is needed. The conversion does **not** import old R2 captures: on a different deployment with existing R2-only indexes, a separately approved content import is required. An index without a D1 raw row is not acknowledged as complete.
2. Set Worker `[vars]` `NOTICE_ARCHIVE_ENABLED = "true"`, then deploy. The route requires this flag, the existing `DB` binding and a valid shared secret; do not enable it before the tables exist.
3. Push reviewed code after approval. Keep existing Actions variable `NOTICE_INGEST_URL` and secret `NOTICE_INGEST_SECRET`; no Cloudflare account API token is given to Actions. Set Actions variable `NOTICE_ARCHIVE_ENABLED=true`.
4. Manually run **collect notices** first. It attempts missing recent raw captures and sends the existing metadata snapshots. Raw-capture failure reports an incomplete run but does not prevent submission of successfully collected live metadata. Check raw-capture outcomes as well as accepted snapshot counts; HTTP202 for a snapshot does not prove its raw body was archived. The initial capture may take longer, and saved articles are reused after partial failures.
5. Set Actions variable `NOTICE_BACKFILL_ENABLED=true`. Run **backfill notice archive** with its `start` input checked **once**. `start` inserts absent page-1 cursors and never resets existing or completed progress. Scheduled runs do not auto-start a backfill.
6. Inspect Actions source/page logs, database size, stored raw rows and D1 progress:

   ```sql
   SELECT source,page,state,started_at,updated_at
   FROM notice_archive_progress ORDER BY source;
   SELECT source,COUNT(*) AS captured FROM notice_archive_raw GROUP BY source;
   SELECT source,id,version,captured_at,content_hash FROM notice_archive_raw LIMIT 10;
   SELECT source,status,COUNT(*) AS unavailable
   FROM notice_archive_unavailable GROUP BY source,status;
   ```

The original `NOTICE_INGEST_SECRET` authenticates POST `/internal/notice-archive`; archive responses are synchronous HTTP 200 acknowledgements, not the ordinary queued-snapshot HTTP 202. Exact signed bytes are retried at most three times. Body reads have a ten-second deadline and signatures a five-minute freshness window.

## Slow, resumable historical traversal

The new workflow runs at **00:40, 06:40, 12:40, 18:40 UTC** (09:40, 15:40, 21:40, 03:40 KST), gated off unless `NOTICE_BACKFILL_ENABLED=true`. It shares the `notice-collector` concurrency group with recent polling.

Each invocation attempts at most **six list pages total**, not six per board. Oldest persisted progress is preferred so boards share the budget. Historical source requests have additional three-second spacing. A roughly seven-minute processing budget pauses between records; a slow in-flight request can extend that budget. The workflow has a separate thirty-minute job timeout for initial recent capture and historical work. There is no guaranteed completion date: source counts, pins, latency and failures vary.

Raw records are durable individually, but a cursor moves only when **every ID on its page** is durably captured or marked definitively unavailable. The historical metadata insert and cursor update are one D1 transaction. Restarting reuses prior raw rows/markers rather than repeating their detail fetches. A failed source does not stop healthy sources; any incomplete recent or historical phase still makes the Actions run report failure.

Historical completion uses official pagination evidence. A malformed page, unexpected API shape, title/detail mismatch, 429, 5xx or transport failure is **not** EOF. Actual detail HTTP **404/410** receives a durable unavailable marker, no fake raw record and no alert; that ID does not block the historical page. Unverified HTTP-200 error payloads are not guessed to mean deletion.

Normal polling remains limited to the recent window. It does not treat an old unavailable marker as proof that a recent article is still unavailable. An article restored in the recent range can be captured normally.

### Live-alert boundary

Backfill commits never create alert/delivery jobs or update live collection health. They insert old metadata without overwriting an existing live row. A source's immutable `started_at` defines its KST start day: publications on/after that day are **not** inserted into live deduplication by backfill, so regular polling can still notify them. This boundary uses the official publication date; a newly added, deliberately backdated post can still be classified as historical.

The site uses mutable page numbers, not a snapshot API. Insertion/deletion during a long traversal can shift page boundaries. Completion means validated traversal of exposed pages, **not a guaranteed immutable point-in-time copy of the whole site**. Do not try to recover already deleted content.

## Pause / resume / local checks

- Set Actions `NOTICE_BACKFILL_ENABLED=false` to pause future historical runs. Recent raw capture can continue. Re-enable it to resume existing cursors; do not reset/delete progress or captured rows.
- Do not independently delete D1 raw rows, archive indexes or progress. Source failures need investigation, not a fabricated terminal-page flag.
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

Sources: [D1 limits](https://developers.cloudflare.com/d1/platform/limits/), [D1 `batch` transactions](https://developers.cloudflare.com/d1/worker-api/d1-database/#batch).
