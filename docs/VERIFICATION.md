# Verification record — 2026-10-09

Executed locally:

- `npm run check`: strict TypeScript check and **78 tests passed across six files**; no skipped tests.
- `npm audit`: **0 vulnerabilities** after selecting current Vitest; no automatic force-fix used.
- `WRANGLER_SEND_METRICS=false npx wrangler deploy --dry-run --outdir /tmp/sogang-bot-build`: Worker bundle succeeded; no deployment.
- `wrangler d1 migrations apply sogang-friends --local`: both migrations succeeded in local workerd D1.
- `npm run schedule:import`: generated 27 validated inactive schedule UPSERTs.
- `wrangler d1 execute sogang-friends --local --file=data/schedule.sql`: 27 local statements succeeded.
- Synthetic fixtures, real generated Ed25519 keys, node:sqlite transactions, mocked HTTP. Integration tests include transient webhook PATCH replay, token cleanup, overlapping snapshot locks, rejected-model usage costs, delayed 429, expiry and ambiguous delivery.
- Limited read-only official source/metadata checks and offline parsing of captured official responses are described in REFERENCES.md and schedule-evidence.md.

Free-only policy follow-up: public model catalog confirmed Gemma 4 31B :free supports image + JSON mode, not schema enforcement. Fixture tests cover paid-ID rejection before network, nonzero-price rejection, zero-price routing, JSON-mode schema prompt and unchanged semantic rejection. Repeat typecheck/tests, npm audit and dry-run succeeded. No free inference was issued either.

At the initial offline milestone, not executed: full-history notice backfill (not implemented), remote migration/resource creation, command registration, Discord posts, paid inference, Cloudflare deploy, staging Workers source TLS, actual Queue redelivery/service concurrency, OCR quality or provider billing verification. SQLite proves SQL behavior, not service equivalence; dry-run proves bundling, not production correctness. GitHub CI workflow is provided but has not run on GitHub.

## Approved production recovery — 2026-10-10 KST

The user created resources and explicitly approved remote recovery. This supersedes the initial no-deployment/no-remote-validation status above.

- Reproduced remote schedule import rejection of explicit `BEGIN TRANSACTION`. Removed transaction wrapper from the generator; remote D1 provides the import transaction. Applied and queried **27 schedules, 0 approved**. Regression verifies inactive/idempotent output without explicit transactions.
- Deployed fixes after typecheck and **86 tests across seven files** passed.
- Reproduced Workers rejection of `fetch(..., {redirect:'error'})` in every collection job. Changed both source and model fetches to `manual`; non-2xx redirects remain rejected. Tests verify manual mode and no redirect following.
- Submitted bounded durable collection IDs through the existing production Queue. Confirmed computing sources initialized successfully, storing **34 academicNotice + 32 externalInfo + 33 career = 99 notices**. No delivery intents were created during this baseline.
- University JSON fetch reaches **HTTP 526** from Workers. Local verified Node TLS also reports `UNABLE_TO_VERIFY_LEAF_SIGNATURE` for both www and bare university hosts. No TLS bypass, HTTP downgrade or external proxy was introduced. This source remains blocked by origin certificate validation.
- Reproduced meal discovery poisoning by an unrelated old four-day menu on page 2 (post 939194). Stop paging when page 1 already provides a validated applicable full week; strict period validation remains unchanged. Production discovery and image fetch succeeded for current post **941444**, period 2026-10-05–11.
- Disabled LLM discovery no longer enqueues an extraction that would become permanently blocked before later enablement. Production `LLM_ENABLED=false` remained unchanged; `llm_usage` and `deliveries` both remained empty at verification.
- Cron trigger is registered and has been reapplied. Scheduled handler presence is confirmed through script metadata, but automatic invocation is not yet confirmed. Added durable `health.id='cron'` last-attempt/success/error and public-source failure details for `/status`. Queue-driven initial collection is verified independently and must not be reported as Cron success.
- Historical failed collection jobs are retained for audit, not reset or deleted. Resource IDs and unrelated user configuration were preserved.

## Six-board Node collector — 2026-10-10 KST

The user approved adding an independent Node/GitHub Actions collector and authenticated Worker ingestion. Activation, push and live ingestion remain separate approval gates.

- Used installed `playwright-cli` with the already-installed Chromium executable (no browser installation) to inspect all six supplied public pages. Confirmed university list JSON endpoint and a working canonical detail URL; college graduate/news boards share the existing strict table structure and independent IDs. Browser artifacts are ignored, not committed.
- Independently retrieved the single relevant Sectigo OV R36 intermediate from its issuer and verified fingerprint, CA constraint, validity, issuer and signature against Node's trusted R46 root. No reference code/bundle copied, TLS disabling, third-party proxy or system trust changes.
- `npm run check`: **109 tests across nine files** and TypeScript checking passed. Tests include actual Node-signer-to-Worker-verifier compatibility, replay deduplication, tampering, canonical URLs for six sources, read timeout/freshness recheck, baseline suppression, streaming size limit, bounded retries, certificate bundle single-block enforcement and external-mode legacy-job suppression.
- `npm run notices:collect -- --dry-run`: all six verified HTTPS sources succeeded, **50 university + 34 academicNotice + 32 graduateNotice + 32 externalInfo + 34 news + 33 career = 215 notices**. Counts only; no Worker upload or Discord posting.
- Accepted snapshots use delayed native Queue retries for caught transient processing failures (120/240 seconds, up to three D1 claims), with a thirty-minute snapshot lifetime. Crash/lease recovery and downstream delayed delivery retries remain subject to the existing recovery/dispatch limits; this task does not claim to fix native Cron.
- `npm audit`: **0 vulnerabilities**. Wrangler dry-run packaged **397.28 KiB / 82.12 KiB gzip**; no deployment.
- No new dependencies, remote migrations, Cloudflare resources, GitHub Secrets, command registration, push, workflow execution, inference or ingestion upload. GitHub Node 24 runner behavior and production ingestion completion remain unverified.
- Latest local `wrangler.toml` selects external notice collection. Its pre-existing user-specific application/resource configuration remains uncommitted and preserved.

## Subsequent Actions activation

With explicit approval, pushed the URL-variable compatibility fix and ran Actions `37963706848` successfully. Read-only production D1 verification showed 215 notices across six initialized sources, no current source errors, and six completed snapshot jobs. This verifies ordinary recent ingestion, not the new raw archive.

## Raw archive / slow backfill — local implementation

User approved original article HTML + attachment/image links (no binaries), all six boards, private R2 files + existing D1 indexes, and deferring notice LLM processing.

- `npm run check`: TypeScript and **154 tests across 12 files** passed. Coverage includes source/detail identity, original fragments, image-only content, inert Nuxt metadata parsing, valid terminal pages, raw-before-live ordering, signed archive acknowledgements, conditional first-object writes, R2-success/D1-failure reconciliation, atomic cursor rollback, fifty-row D1 query/binding limits, immutable KST start-day boundary, bounded retries, budget pauses and permanent historical HTTP404/410 markers versus transient failures.
- Direct native Node import and a bounded verified-HTTPS probe succeeded: university page1 returned 50 entries; one body was 71,847 UTF-8 bytes. No upload. Additional bounded parser checks established all five college detail formats, representative file references and selected terminal pages, not a historical traversal.
- Local Miniflare R2 conditional-put probe preserved the first object. Fake-R2 + real SQLite integration verifies coordination invariants, not remote R2/D1 operation.
- `npm audit`: zero vulnerabilities. Final Wrangler dry-run packaged 407.67 KiB / 84.36 KiB gzip. No deployment.
- Worker archive flag defaults false; new historical workflow is off without its separate Actions variable. No bucket creation, remote migration0003, archive deployment/upload, historical workflow execution, live backfill, binary downloads, notice model call or processed placeholder occurred.
- Raw objects are first captures, not refreshed latest bodies. Historical attachment-layout changes can fail closed. Mutable upstream pagination does not guarantee an immutable snapshot. HTTP200 'not found' payloads are not inferred without verified official semantics.
- Account free-model quota 1,000/day and 20/minute is recorded from the user's credit-purchase confirmation, not independently authenticated. Meal-specific limits remain unchanged; cross-feature model rate limiting is not implemented in this phase.
- See [NOTICE-ARCHIVE.md](NOTICE-ARCHIVE.md) for separate activation gates, storage limits and pause/resume.

## Follow-up operational check — 2026-10-10 KST

Read-only verification found scheduled Actions runs `37999910845` and `38028448587` successful; each accepted all six source snapshots. D1 confirmed 18 completed snapshot jobs, 215 accumulated notice rows, six initialized sources with no current errors, and latest collection around 14:43 KST. Cron health recorded success at 19:00 KST; meal discovery succeeded at 15:00 KST. Earlier unconfirmed Cron propagation is therefore no longer an active blocker.

Production remains `LLM_ENABLED=false`: zero extracted meals and zero model reservations are expected, not an extraction failure. The 27 schedule records remain inactive. Raw archive tables/binding and Actions flags are absent, consistent with deferred activation. Older failed collection jobs are retained repair history, not recent failures. One delivery is recorded sent; this does not prove a successful vision extraction.

Found and locally fixed token recovery overwriting all terminal interaction jobs with `needs_review` / `interaction expired`. Recovery now preserves terminal outcomes/errors while purging secrets, and only expires unfinished interactions. Existing mislabeled history is not guessed or rewritten. TypeScript and **156 tests** passed; deployment remains a separate gate. The initial read-only D1 request returned transient code7403; subsequent authenticated list/queries succeeded without login or configuration changes.

## Meal and schedule activation — 2026-10-10 KST

The user approved deployment, schedule activation, the first live free-model extraction, and later changing the model from Gemma 31B to Gemma 26B. Worker version `774de537-520a-4437-83f8-24d1f65d8f77` runs `LLM_ENABLED=true`, `google/gemma-4-26b-a4b-it:free`, and `meal-v3-gemma26-free`; the meal-specific two-job/day limit and zero-price routing remain unchanged. Raw archive/backfill remains disabled.

Remote D1 has 27 schedules with **24 active**, excluding three faculty grade-submission entries. The official headquarters calendar was fetched again with verified Node TLS and checked against the existing dates. User-approved reminders now cover event/period starts and explicit student deadlines separately at D-7/D-1/D-day, with same-date targets combined and existing deadline delivery keys preserved. This path makes no LLM requests. First upcoming reminder is midterms start D-7, **2026-10-13 07:30 KST**. No historical or immediate test Discord alerts were generated; future actual schedule deliveries are not yet observed.

**Meal extraction is enabled but not operationally successful yet.** Two distinct approved extraction jobs (31B and 26B) each exhausted three safely spaced HTTP 429 rejections; no meal was stored. Diagnostics confirmed the final failures came from inference, not catalog discovery. Authenticated read-only `/api/v1/key` reported daily used=0, limit=1000, remaining=1000 (UTC). Daily exhaustion is therefore not the cause; provider/minute/platform throttling remains unconfirmed. No raw error bodies, key profiles or tokens are logged/stored; only fixed stage labels, allowlisted numeric rate-limit headers and numeric daily counters are retained. Rejections retain their safe-retry reservations. Neither failed image job is automatically resurrected; a later operator-approved retry or next-period discovery is required. No paid model or paid fallback was invoked. Absent response usage must not be represented as verified billed cost.

Local TypeScript and **162 tests** passed, including non-LLM start/deadline delivery deduplication and sensitive-body diagnostic redaction. OCR accuracy and seven-day output validation cannot be verified without a successful model response.

## D1-only archive and durable meal retries — 2026-10-10 KST

The user declined Cloudflare card registration and selected the existing D1 database instead of R2. Original HTML and URL references now live in `notice_archive_raw`; the unchanged raw path is a logical index identity. First captures and their indexes commit atomically, historical imports do not alert, and no binaries or notice models are used. New captures stop at observed database size 400 MB to preserve live-state headroom; replays remain possible. Archive failure no longer blocks live metadata submission.

User-approved remote migrations 0003 and 0004 succeeded. Worker version `28daf235-f380-488c-94fc-4c5cf1f7403c` enables D1 archival without an R2 binding or new resource. Scheduled/manual Actions activation and real capture/backfill outcomes are recorded separately below; migration and deployment alone do not prove collection.

The user-approved 31B-five/26B-five sequence ran all ten attempts, with per-model 1/2/4/8-minute waits and a one-minute transition. All ten were inference HTTP429, with daily counters still 0/1000. The job stopped at `needs_review` without choosing a third model. Exactly two earlier approved 429-only reservations were released as `confirmed_rejected` with zero reserved amount; history and absent cost remain preserved. The new run's reservation was not released. The two-run daily cap is unchanged; it counts reservations, not HTTP attempts. `/status` now excludes released reservations from its run count.

The user subsequently approved a one-attempt verification with `dots-studio/dots-3-note-preview:free`. Public catalog image input, structured output support and all-zero published prices were verified. This operator-only verification does not retry or automatically switch models on rejection. The regular configured 31B/26B pair is not silently replaced. The Dots run received a complete response but rejected its extraction output, stopped after one attempt, and stored no meal. Reported response cost was 0; the conservative reservation remains. The generic diagnostic does not distinguish answer parsing, finish reason, schema or date/evidence rejection, so the precise invalid-output cause is unconfirmed. No further model calls were made.

The existing `/meal` command was reused, not duplicated or re-registered. Added end-to-end fixture tests cover signed deferral, current KST date, explicit date, stored validated menus, source fallback, invalid dates and no inference on read. No test Discord messages were posted.

Local verification: TypeScript and **193 tests** passed, npm audit reported zero vulnerabilities, diff check passed, and Wrangler dry-run packaged 413.73 KiB (85.97 KiB gzip). These checks do not establish real OCR quality, complete historical storage capacity, or production Discord command output.

Initial approved Actions capture run `38051821656` submitted all six metadata snapshots but reported archive incompleteness: 171 raw records committed (university40, academicNotice34, graduateNotice32, externalInfo32, career33; news0). Database size was about2.1 MB. The fail-closed parsers exposed two observed source variants: a university detail title had trailing whitespace compared with its normalized list title; newer news public route IDs differ from internal detail/attachment-parent IDs. Local fixes retain normalization consistent with the list parser and require both canonical URL and hydrated route identity for the news mapping, while validating internal attachment parent plus public file path. Read-only checks passed all10 missing university and all34 recent news notices; no binaries were downloaded. TypeScript and195 tests passed. A collector retry is required to establish stored completion.
