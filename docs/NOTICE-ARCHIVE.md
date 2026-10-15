# Notice originals and slow backfill

## Current state and rollout boundary

The archive uses the **existing D1 database only**. Node/GitHub Actions fetch official pages with verified TLS, then submit authenticated captures to the Worker. All eleven notice sources are initialized in production; source definitions and official URLs are in [NOTICE-COLLECTOR.md](NOTICE-COLLECTOR.md).

`NOTICE_ARCHIVE_ENABLED=true` is checked into `wrangler.toml`; production archive activation and the initial six-source historical start were approved in 2026-10. This does **not** establish complete history or authorize starting missing historical cursors for the five later sources. See [VERIFICATION.md](VERIFICATION.md) for observed outcomes rather than inferring them from flags.

**Production now includes the chunk implementation.** With explicit approval on2026-10-14, migrations0009 and0011 were applied and main `a4ce2b6` deployed as Worker `23c106c8-77c3-45de-b6a9-411c3070f54c`. All migrations0001–0011 are applied. Meal migration0011 changes report deduplication, not notice retention. This supersedes the earlier isolated channel-only build; future rollouts still need approval.

## Storage contract

- Retain one first raw capture per `(source,id)`: exact article-body HTML, notice metadata, attachment/image URLs, capture time, version and content hash. Normal notice metadata may update independently; this is not a revision archive or proof of the latest body.
- `notice_archive_raw` holds the original; `notice_archive` is its searchable index; `notice_archive_progress` tracks historical traversal. `raw/<source>/<id>.json` is a **logical identity**, not a file or R2 object.
- An atomic D1 batch stores original content and its index. Replays retain the winning first capture. An old index without a D1 original is not acknowledged as complete; a separate import is required.
- No binary attachment/image downloads, recovered pre-collection deletions, notice-model calls, derived-result tables or fake `processed/` outputs. Inline images and Office-pasted author-local `file:` image paths already present in original HTML are not stripped. Inline `data:` and local `file:` images are excluded from exported web `imageUrls`; they are never fetched. Proven attachment metadata still requires valid web URLs. Treat retained HTML as untrusted data, never executable content.

### Size limits

| Boundary | Deployed code |
|---|---|
| Original body, UTF-8 | 8 MiB |
| Detail-response transport | 9 MiB |
| Signed archive JSON request | 16 MiB |
| Attachment / image references | 100 / 100 |

Bodies up to 1 MiB stay inline. Larger bodies use ordered `notice_archive_raw_chunks` with metadata `body_storage='chunked'`, chunk count and byte count. Readers must concatenate by `ordinal`; original identity/hash remain unchanged. Metadata, chunks and index commit atomically. JSON escaping can exhaust the request limit before the body limit. Validated stored columns remain below **1,900,000 bytes per metadata row**, with bounded chunk rows below D1's **2,000,000-byte row ceiling**. Raw HTML is not copied into job payloads.

D1 Free is limited to **500 MB per database**, shared with live bot data. New captures stop at a reported size of **400 MB**, or when size metadata is missing. Existing captures remain replayable. This guard is not a reservation: concurrent writes or the final capture may cross the threshold slightly. The2026-10-14 live verification stored four chunked originals up to3,837,519 bytes; their48 stored chunks matched metadata counts and byte totals. Full-history capacity and worst-case8MiB Worker CPU/memory feasibility remain unproven. Do not delete retained originals or independently delete indexes/progress to make space.

## Authentication and setup

POST `/internal/notice-archive` uses the same `NOTICE_INGEST_SECRET` and exact-byte HMAC contract as [recent snapshots](NOTICE-COLLECTOR.md#authentication-and-retries). Archive responses acknowledge synchronous storage with HTTP 200, not snapshot HTTP 202. Clients retry the same signed bytes at most three times. Body reads have a ten-second deadline; signatures expire after five minutes.

For a new environment, separately approve the following external changes:

1. Inspect **every** pending migration. Archive indexes/progress require `0003`, raw storage `0004`; main's chunk implementation additionally requires `0009`. Existing production must not be treated as an empty database.
2. Keep the existing D1 binding and shared secret. Enable Worker `NOTICE_ARCHIVE_ENABLED=true` only with the matching schema, then deploy the approved code. No R2 resource or Cloudflare write token in Actions is needed.
3. Set Actions `NOTICE_ARCHIVE_ENABLED=true`. Run recent collection first; a raw-capture failure must not suppress an otherwise valid recent snapshot. HTTP 202 alone does not prove archival.
4. Historical activation/start is a separate decision: enable `NOTICE_BACKFILL_ENABLED=true` and use the workflow's `start` input **once** for missing cursors. It never resets existing/completed cursors; scheduled runs do not create them automatically.

Historical starts, workflow dispatch, uploads, migrations, deployment and Git push are mutating operations requiring approval. Do not repeat prior activation merely because this setup procedure exists.

## Historical traversal and live-alert boundary

The backfill workflow runs at **09:40, 15:40, 21:40 and 03:40 KST** (00:40/06:40/12:40/18:40 UTC), gated by `NOTICE_BACKFILL_ENABLED`. It shares the `notice-collector` concurrency group with recent polling. Its recent-collection step runs before historical work so imports cannot suppress fresh alerts.

Each invocation attempts at most **six list pages total**, preferring oldest progress, with additional three-second source spacing and a roughly seven-minute processing budget. In-flight requests may extend that budget; the workflow has a thirty-minute job timeout. There is no completion SLA.

A page cursor advances only after every ID is stored or definitively unavailable. Historical metadata and cursor movement commit together. Actual detail HTTP **404/410** creates an unavailable marker, not fake content; transport failures, 429/5xx, parser errors, mismatched identity and HTTP-200 error shapes are never EOF. Recent polling may capture an article restored after an old unavailable marker.

Historical imports never create alerts, reset baselines or update live collection health. They do not overwrite existing live metadata. A cursor's immutable `started_at` defines its KST start date: publications on/after that date are excluded from historical live deduplication so regular polling can still notify them. Deliberately backdated new posts remain a limitation. Mutable page numbers also prevent a guaranteed point-in-time site snapshot.

## Inspection, pause and bounded checks

Read-only SQL, after access approval as required by the environment:

```sql
SELECT source,page,state,started_at,updated_at FROM notice_archive_progress ORDER BY source;
SELECT source,COUNT(*) AS captured FROM notice_archive_raw GROUP BY source;
SELECT source,id,version,captured_at,content_hash FROM notice_archive_raw LIMIT 10;
SELECT source,status,COUNT(*) AS unavailable FROM notice_archive_unavailable GROUP BY source,status;
```

- Offline checks: `npm run check`, `npm audit`, Wrangler `deploy --dry-run`.
- `npm run notices:backfill -- --dry-run` makes **real read-only source requests** for at most one first page and its articles; it is not an offline test.
- Set Actions `NOTICE_BACKFILL_ENABLED=false` to pause future runs, then re-enable to resume existing progress. Do not reset cursors.
- Only with upload approval and securely configured environment:

  ```sh
  npm run notices:backfill -- --send --start  # add missing cursors, then bounded work
  npm run notices:backfill -- --send          # resume
  npm run notices:backfill -- --send --pages 2
  ```

The launcher requires `NOTICE_ARCHIVE_ENABLED=true`, the verified CA, `NOTICE_INGEST_URL` and shared secret. Unlike the workflow, direct backfill CLI does not run recent polling first. No active meal inference or notice processing exists; historical free-model quota policy is not an active meal limit or an implemented cross-feature limiter.

References: [D1 limits](https://developers.cloudflare.com/d1/platform/limits/), [D1 batch transactions](https://developers.cloudflare.com/d1/worker-api/d1-database/#batch).
