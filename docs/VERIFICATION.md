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

Initial approved Actions capture run `38051821656` submitted all six metadata snapshots but reported archive incompleteness: 171 raw records committed (university40, academicNotice34, graduateNotice32, externalInfo32, career33; news0). Database size was about2.1 MB. The fail-closed parsers exposed two observed source variants: a university detail title had trailing whitespace compared with its normalized list title; newer news public route IDs differ from internal detail/attachment-parent IDs. Local fixes retain normalization consistent with the list parser and require both canonical URL and hydrated route identity for the news mapping, while validating internal attachment parent plus public file path. Read-only checks passed all10 missing university and all34 recent news notices; no binaries were downloaded. TypeScript and195 tests passed. A collector retry was required to establish stored completion.

After approved parser-fix push, capture retry `38052885329` succeeded. Remote D1 confirmed **215 retained raw notices** across all six boards: university50, academicNotice34, graduateNotice32, externalInfo32, news34, career33. Initial backfill dispatch `38052979635` succeeded; every board's page1 was committed and its durable cursor is now page2/active, with shared immutable start `2026-10-10T12:43:31.994Z`. These first pages reused recent captures: this is the beginning of history traversal, not complete backfill. Database size was3,444,736 bytes, six live sources had no errors, and schedules remained27 total/24 active. Deliveries remained the prior one sent row, so no historical or test message was generated. Actions archive/backfill variables are true. Code CI run `38052885187` passed. Git's default archive flag stays false; the user-specific local and deployed configuration is true. No R2 resource/card registration, notice model call or binary attachment download was performed.

## Dots/NVIDIA verification — 2026-10-10 KST

The user requested a fresh Dots-five/NVIDIA-five sequence, then explicitly approved prompt-only JSON for `nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free` and one scoped third-run/$0.75 reservation allowance. Both live catalog entries advertise image input and all published prices zero; Dots advertises structured output, NVIDIA does not advertise response_format. The exception applies only to the selected model in this operator-created job. Normal model pair, daily caps and previous reservations remain unchanged.

Worker versions `a8187762-51b6-4d1c-ba60-543d9c52dc6a` and then `88792748-eaba-46ba-ae51-6349716b06b9` were deployed. All five Dots inference responses completed with `finish=length` and `content_chars=0`: no answer JSON was produced under the unchanged6000-token setting. NVIDIA's first completed response had `finish=stop`,115 content characters, and invalid answer JSON. Its second inference response lacked valid choices. Its third inference request ended in a transport failure with uncertain outcome, so no further inference was attempted.

One intervening fallback slot stopped before inference with the old generic diagnostic; its reservation stayed safe_retry. The original source hash was rechecked unchanged. Preflight image/reservation errors are now distinguished and safely retryable; changed images still stop, and unknown inference failures retain fixed diagnostics and reservations. Only the confirmed pre-inference stop was resumed, with the original attempt counter retained. The job finally stopped at9/10 attempt slots in needs_review: five Dots request attempts, three NVIDIA request attempts, and one preflight-only slot. It did not complete five NVIDIA inferences because uncertainty requires stopping, not replay.

No meal was stored and no Discord test post was made. Prior observed response costs accumulated to0, but that is not confirmation of the final uncertain request's usage or bill. Its $0.25 reservation remains reserved. No paid model or fallback was used. Exact transport cause and reasoning-token consumption are not recorded; reasoning consuming the answer budget is a hypothesis, not a measured fact.

Local TypeScript and206 tests passed; npm audit reported zero vulnerabilities and diff check passed. New tests cover model-scoped prompt-only permission, unchanged normal caps, preservation of old reservations, third-run ceiling, preflight classification and no ambiguous replay. No new GitHub CI or code push is claimed for this iteration.

## Reasoning-disabled trial and factual rejection — 2026-10-11 KST

After renewed user approval, a fresh run used the same Dots/NVIDIA pair with reasoning.enabled=false, requiring live metadata reasoning support and mandatory=false. The new KST day used normal two-run/$0.50 caps, without an extra-run override; the earlier uncertain job/reservation was not replayed or released. Worker `2a02ac43-0858-4c10-b9d1-9466930e75e2` retained6000 tokens/120 seconds and the existing format/semantic checks.

Dots attempt1 produced complete output but an uncertain/conflicting period; numeric usage was3552 completion tokens and0 reasoning tokens. Attempt2 produced schema-valid seven-day JSON, so the automatic sequence stopped and did not reach NVIDIA in this fresh trial. **This was not factual extraction success.** Visual comparison with the original941444 image confirmed invented Monday cup rice (this specific image lists it only Tuesday), fabricated Saturday dinner where the source cell is blank, and badly misread menu names. No fixed weekday rule was added.

The user approved quarantining this exact derived result. Worker `2c5964ae-4788-4431-bf3b-ae2db2385ced` adds a private Queue operation using one atomic D1 batch: preserve the full derived JSON and provenance under extraction-job payload.rejectedExtraction, mark the extraction needs_review, then delete only its matching serving-cache row with audit proof. No schema, public route, service, reservation reset or model request is added by cleanup. Idempotent replay retains the audit; a SQLite abort-trigger test verifies rollback if deletion fails.

Remote verification confirmed quarantine done, extraction audit preserved, original attempt count2 retained, and serving-meal count0. `/meal` therefore returns its official source fallback rather than this inaccurate menu. No Discord test post or paid inference was made. The older uncertain NVIDIA reservation remains preserved. This operator cleanup is not an automatic factual-quality gate for future extractions.

TypeScript and214 tests passed; previous audit reported zero vulnerabilities, and final diff check passed. These source changes were locally committed/deployed at that point; later publication and CI are recorded below.

## Controlled GitHub Actions comparison — 2026-10-11 KST

The user approved publishing the pending commits and a manual-only comparison, configured OPENROUTER_API_KEY in repository Actions secrets, and separately approved the restricted HMAC claim/report endpoint. Implementation `b3530e3` was deployed as Worker `7414a7be-6597-4a9b-be39-75d180098211` and published. The endpoint accepts only operator-preallocated normal-cap tickets: one successful claim authorizes the runner; exact outcome-report retries are idempotent. It does not allocate new reservations, invoke models, create meals, or deliver Discord messages. It respects the inference pause for new claims while allowing reports after pause/expiry. No Cloudflare write credential is added to Actions.

[Actions run38112076601](https://github.com/Hiyabye/SogangFriends/actions/runs/38112076601) used the identical original image hash `05c38bb91374f5d910ac108daee6f94bd7564424761f55a19f06f9ca2ca0104c`, shared extraction implementation, Dots free model, reasoning disabled,6000-token limit,120-second timeout, temperature0 and catalog-selected strict output when supported. One second normal-cap reservation covered at most two safe attempts, with no extra-run allowance. Node's strip-only compatibility check exposed TypeScript constructor parameter properties; they were replaced with equivalent explicit fields before the live run.

Both Actions attempts returned complete responses and were rejected as `Uncertain or conflicting meal period`:

| Attempt | Shared extraction elapsed | Completion tokens | Reasoning tokens | Finish |
| --- | --- | --- | --- | --- |
|1|46.217 seconds|4524|0|stop|
|2|13.755 seconds|1129|0|stop|

No schema-valid week was produced, so no menu could pass factual comparison. The workflow's successful exit means the diagnostic and report completed, **not that extraction succeeded**. The report records safe_retry and observed cost0; its$0.25 conservative reservation remains recorded. The earlier uncertain NVIDIA reservation remains reserved. Remote D1 confirms comparison_done with2 attempts and serving-meal count0. No comparison output was inserted into meals and no comparison Discord post was made. Diagnostic JSON is retained as an artifact for3 days, not as a long-term meal archive; notice-history policy/data were not changed by this task.

**Conclusion:** this small, non-simultaneous Dots comparison does not demonstrate that GitHub Actions is better than Workers. Both runtimes obtained complete model responses; Workers' schema-valid sample failed factual review, while Actions' samples failed date/uncertainty validation. Model/provider variation and the time gap prevent attributing differences solely to hosting. Keep production hosting unchanged; investigate model/image extraction quality before permanent migration. The earlier Gemma429 problem and NVIDIA transport uncertainty are not resolved by this Dots-only test.

Local TypeScript and235 tests passed, npm audit reported zero vulnerabilities, Node imported the actual comparison entrypoint without network calls, and diff checks passed. [GitHub CI38111983225](https://github.com/Hiyabye/SogangFriends/actions/runs/38111983225) passed. Actions reported upstream Node20-action deprecation and an upcoming ubuntu-latest image migration; these warnings did not fail the run and were left unchanged as unrelated maintenance.

## Current/upcoming meal cache and command image fallback — 2026-10-11 KST

The user approved keeping JSON while tolerating menu typos, current+next KST Monday–Sunday meal retention, an additive source-metadata migration, deployment and source-only verification. Notice history was not changed. Migration0005 adds meal_sources (official URL/image URL, dates and verification timestamp) independently of model output, plus a partial index so audit-body cleanup does not scan unrelated job history.

Cron and meal discovery prune source/derived rows outside the two-week window and remove only expired rejectedExtraction.data. Audit identity/provenance, job states/attempts and all usage reservations remain intact. Date-scoped reads exclude expired content even before physical maintenance. Stale extraction jobs stop without inference; a complete response crossing Monday is accounted for without caching its now-expired menu. The long Retry-After regression now uses the upcoming week so it tests delay behavior independently of expiry.

The prompt's certain flag now concerns observed dates/weekdays only. Minor menu spelling errors are accepted; unreadable offerings remain unknown. Date/weekday validation and blank-cell/no-invented-offering instructions remain. This does not automatically replay the old exhausted/uncertain runs, and no fresh model call was made to establish whether the prompt improves output quality.

/meal uses an explicit official image embed when extraction is missing or all displayed offerings are unknown and matching retained source metadata exists. Invalid dates and missing/out-of-window sources do not embed an unrelated image. Other commands retain text behavior, mention parsing remains disabled, and deferred replies still use idempotent PATCH. Scheduled deliveries remain on their existing text/link path. Discord image rendering requires Embed Links permission and an accessible official image; no live test post was sent.

Migration0005 was applied remotely, and Worker `e015fdc4-1327-4027-a794-52f471f6331c` was deployed. A sourceOnly meal-discovery verification finished in one attempt, cached official images for2026-10-05–11 (941444) and2026-10-12–18 (941660), and left the entire usage ledger unchanged. Serving-meal count remained0, so those dates now take the image fallback. The verification fetched source metadata, not model inference or Discord delivery.

TypeScript and251 tests across16 files passed, npm audit reported zero vulnerabilities, git diff checks and Wrangler dry-run passed. Tests cover KST week/year boundaries, content-only retention, preserved notices/reservations, source-only discovery, stale/in-flight expiry, typo tolerance and signed deferred interaction image payloads. Implementation is locally committed/deployed; publication of this feature to GitHub is not claimed.

## Direct meal-image attachment correction — 2026-10-11 KST

The user reported that the external-image embed did not render, leaving only a link. Prior payload tests did not establish actual Discord rendering, and the precise upstream/client/permission cause was not proven. The fallback now downloads the matching official image using the existing verified-TLS, redirect-rejecting, streamed5MiB PNG/JPEG boundary, then uploads bytes via multipart PATCH of the original deferred response. It uses a real file attachment without an external-image embed; the article URL remains only as attribution. No model call, binary archive or schema change is involved.

The JSON part contains only attachment placeholder metadata, never binary bytes. Explicit attachments lists replace old files on retry rather than accumulating them; mentions remain disabled. Download errors produce a clear failure/link-only message. Retention is rechecked after download, and a command expiring during download is marked needs_review without sending to its expired token. Attach Files permission and client image-display settings can still affect user-visible behavior.

TypeScript and260 tests across17 files passed, including PNG/JPEG multipart bytes, unknown/missing extraction, download failure, retry attachment replacement, invalid/out-of-window dates, Monday rollover and interaction expiry. Diff checks and Wrangler dry-run passed. With separate user approval, Worker `9e2b2cf4-7654-467b-b09a-9f0e54f2fbcf` was deployed. No model inference, test Discord message, migration or GitHub push was performed for this correction. Actual client display is left for the user to confirm with a fresh /meal command.

## Editable schedule board and operational reviews — local implementation

The user selected typo-tolerant meal text with an OCR notice, one stable daily-edited schedule message instead of deletion/reposting, and separate review annotations for historical jobs. Date/weekday validation remains unchanged; existing typo tolerance is regression-tested rather than falsely reported as a newly relaxed validator. No quarantined output was restored.

The schedule board includes approved student-facing future/ongoing entries without the command's30-day cutoff, uses D-n/D-day/ongoing labels, and retains explicit deadline semantics. Overlong content is attached completely to the same message. Additive migration0006 tracks channel/message lifecycle, claims, uncertain initial creation, safe known-ID editing and per-message Retry-After across daily job identities. Migration0007 stores execution-state/attempt snapshots with closed/deferred review dispositions, without rewriting historical jobs or reservations. Long private status results attach full diagnostics; current summary lookup remains guild/channel scoped.

Read-only production inspection succeeded after the earlier7403 access error. Eight shared failed rows and four shared needs_review rows are historical; the proposed11 closed/1 deferred annotation set is in JOB-REVIEWS.md. Twenty-three old interaction-expiry rows remain unchanged because original success/guild identity cannot be reconstructed. Closing a historical model attempt is not evidence that429 throttling or OCR quality is fixed.

Verification: `npm run check` passed TypeScript and **287 tests across19 files**; `npm audit` reported zero vulnerabilities; `git diff --check` passed; Wrangler deployment dry-run bundled444.83KiB /93.38KiB gzip. SQLite and fixture tests cover overlapping initial creation, crash recovery, safe PATCH retries, exact Unknown Message recreation, cross-date cooldown, attachment replacement, complete schedule output, review invalidation and preserved usage ledgers. Discord official Message Resource documentation confirms the2,000-character content limit and explicit complete attachment sets for edits.

At this local milestone: no remote migration/review write, deployment, Discord post, model invocation, command registration or GitHub push. Existing user-specific wrangler.toml changes are preserved and not included in the implementation commit. Real daily edits and client attachment rendering remain unverified.

## Approved schedule-board activation and historical reviews

After separate user approval, applied remote migrations0006 and0007, inserted guarded exact-ID review annotations for the12 inspected shared failures/review jobs, and deployed Worker version `8715bdb8-2ecf-46dd-8a42-5e254eff9c70`. The insert refused the complete set if any inspected state/attempt snapshot changed. Before/after read-only JSON comparisons confirmed all historical jobs' states, attempts, creation times and errors unchanged, and the complete usage ledger unchanged before reviews and after deployment.

Remote verification confirmed11 closed reviews and1 deferred uncertain NVIDIA extraction; the unresolved shared-job query now contains that1 deferred row only. Schedules remain27 total/24 active. The schedule_messages table is empty, deliveries remain2 sent, and serving meals remain0. No immediate test message, old-result restoration, inference, reservation release, command registration or GitHub push was performed. Current meal settings remain07:30 KST and the existing free31B/26B pair/two-run cap; this task did not implement the earlier unselected07:00/17:30 proposal. The next planned schedule board creation is2026-10-12 at07:30 KST, subject to Cron/Queue and channel permissions. Actual posting, next-day editing and client attachment rendering are still unverified.

## 2026-10-13: native meal OCR and conditional LLM retirement

Seven verified official menu images were processed locally with automatic table-line geometry and independent banner/seven-column date checks. Six passed, including August/September and September/October transitions. Source 940528 (September 14–20 columns, September 7–13 banner) was rejected. October 12–18 required EasyOCR after PaddleOCR missed a complete Saturday weekday. These checks establish the sampled table/date behavior, not exhaustive menu-text accuracy.

With explicit user approval, staged pipeline/cache-ingestion code was committed and pushed as `945848d`, then [Actions run 38345856766](https://github.com/Hiyabye/SogangFriends/actions/runs/38345856766) executed with `ingest=false`. Ubuntu 24.04/Python 3.11 installed the hash-locked CPU environment, passed 36 Python tests and eight Node client tests, exercised both native engines and matched all four approved weight digests. One actual October 12–18 source (SHA-256 `f8f5a60905a10f308495422d6ed5b7629f53f6e1a30594f46d386a05a36b0ff4`) was accepted via EasyOCR. Artifact review confirmed all seven observed dates/weekdays. Its `MealWeek` also passed the existing TypeScript meal validator locally; a saved identity fixture is independently checked by Worker regression tests.

The runtime gate passed, so active meal OpenRouter calls, request/prompt/model/budget settings, reservation allocation and the obsolete comparison client/workflow were removed locally. The comparison POST route returns 410. Incoming pending/retry legacy extraction messages become `needs_review` without resetting/spending attempts or touching payload/error/usage records. Running leases and terminal outcomes remain untouched; historical quarantine and ledger/review queries remain supported.

No D1 write, live OCR ingestion, secret setup, deployment, Discord post, OpenRouter inference or scheduled activation occurred. The workflow remains manual-only. At that milestone, subsequent retirement had not been pushed and operational cutover still required approval. The push-triggered general CI failure is distinct from the successful OCR verification; existing fixture discovery timeouts remain unresolved.

## 2026-10-13: approved OCR activation and paired meal reports

The user approved retirement push, dedicated-secret setup, deployment and live ingestion, then chose reports at 07:00/17:30 KST with OCR refreshes beforehand at 06:40/17:10. The 07:00 report shows today breakfast+today dinner; 17:30 shows today dinner+tomorrow breakfast. Schedule-board updates stay at 07:30. Sunday next-week lookup, per-section unknown fallback, deduplicated/two-week image attachments, combined 5MiB cap, slot expiry and no uncertain replay have regression coverage. `/meal` retains full-day/cup-rice behavior.

Pushed retirement `ba8679e` and scheduling `06ed164`. Configured a new dedicated `MEAL_OCR_INGEST_SECRET` in Worker/Actions without displaying it, and the public Actions endpoint variable. Deployed Worker version `33e7c279-3409-4625-bc90-84fa4b962873`; no resources or migrations were created. Unsigned OCR POST returns 401 and retired comparison POST returns 410. Existing remote OpenRouter secrets were not deleted; deployed code does not use them.

[Live ingestion run 38352388180](https://github.com/Hiyabye/SogangFriends/actions/runs/38352388180) passed with `ingest=true`. D1 contains one `ocr-v1`/`easyocr` serving week for October 12–18 with seven validated days; meal health last success is `2026-10-13T05:40:08.026Z`, error NULL. Local validation of the actual serving row confirmed today breakfast/dinner and tomorrow breakfast identities. Exact before/after comparisons show the entire usage ledger, historical extraction jobs and Discord delivery counts unchanged. No immediate Discord test post, historical replay, paid/model API call or reservation release occurred.

Twenty TypeScript files excluding `tests/sources.test.ts` passed 273 tests; the 12 new report cases passed, and Python/client tests passed in the live workflow. Typecheck, dry-run and workflow UTC/KST/default-input checks passed. The full suite still has the same four pre-existing 5-second discovery timeouts; general CI remains red for those tests, not for native OCR verification.

GitHub automatic schedules can be delayed/dropped; a 20-minute lead is not a readiness guarantee. Exact cached identities skip menu re-extraction, while source/image download is still needed for hash verification. Missing results retain matching-week image/link fallback. Actual first 17:30/07:00 scheduled delivery, automatic Actions timing and Discord client rendering have not yet been observed; no immediate post was used to substitute for that verification.

## 2026-10-13: editable embed boards and CI fixture correction (local only)

User chose one meal board plus same-day schedule change detection, native embed cards, and fixing CI tests. Additive migration 0008 retains all existing schedule message IDs, uncertain outcomes and leases, and creates independent meal tracking. Existing boards are checked every 15min; unchanged visible projections skip Discord requests. Meal bootstrap stays in the 07:00/17:30 windows, schedule bootstrap at 07:30. Edits generally do not generate new-message notifications. No old messages are deleted/adopted, and historical deliveries/reservations remain untouched. Ingestion still creates no board/delivery jobs.

Shared board transport preserves uncertain-create freeze, safe known-ID PATCH retry, exact Unknown Message deletion proof, full attachment/embed replacement, and board-wide cooldowns. Regressions cover A → uncertain edit B → A reconciliation, interrupted edits whose target equals the last successful hash, confirmed rejected creates after bootstrap, concurrent claims, slot/midnight transitions during downloads AND the final D1 configuration read, and recovery of temporary image preparation failures after a 15min cooldown. Permanent aggregate image-size omissions remain link-only. Per-channel queue jobs isolate recipients. Embed schedule overflow retains the complete schedule file, with no silent truncation.

The four old CI failures were a test clock/pacing mismatch: discovery tests moved Date.now backward while retaining module-local lastStart and real timers. Test-only fresh imports plus coordinated fake timers resolve it; a regression asserts actual production pacer requests are one virtual second apart. Production collection pacing was not altered.

Local verification: npm run check passed typecheck and all **320 tests in 23 files**; Node ingestion client **8 tests** and Python OCR **36 tests** passed. npm audit reported **0 vulnerabilities**, Wrangler deployment dry-run succeeded, and git diff --check passed. The Python suite deliberately emits an existing-output rejection in a negative CLI test; overall unittest result is OK.

The user subsequently approved push, migration and deployment. Pushed test-clock fix `14dc294` and embed boards `a6c18ac`; [checks run 38359081304](https://github.com/Hiyabye/SogangFriends/actions/runs/38359081304) passed the full check, audit and dry-run. Confirmed 0008 was the ONLY pending migration, applied it, and verified no pending migrations remain. Exact pre/post migration comparisons preserved every original schedule tracking column, the entire usage ledger, historical extraction jobs and delivery counts. New meal tracking was empty; no immediate post occurred. Deployed Worker version `58cb21ea-b45d-4641-a5c3-27304f576508`. Post-deployment read-only inspection shows an existing ready schedule message without error, no meal board yet, and the current serving week retained. Next normal Cron can update the existing schedule board; initial meal creation remains at the next approved slot. Actual Discord card/attachment rendering and effective Embed Links/Attach Files permissions remain unverified. No source inference, migration beyond 0008, historical replay, immediate Discord test post or secret change occurred in this rollout.

## 2026-10-14: meal replacement notifications and eleven-board notice cards deployed

User explicitly approved pushing and deploying all three pending changes: meal replacement notifications (`6f04cdb`), five additional official notice sources (`e6e3519`), and automatic notice Components V2 cards (`5439362`). Local `npm run check` passed TypeScript and **354 tests across 26 files**, `npm audit` reported **0 vulnerabilities**, and `git diff --check` passed. The new notice adapters also passed read-only HTTPS list/raw-detail/terminal-page checks with the existing verified intermediate CA.

Deployed Worker version `e01c94ec-502e-49ee-9ab7-f1c09f246a11` at `https://sogang-friends-bot.hiyabye0465.workers.dev`, with the existing 15-minute Cron, D1 and Queue bindings. Then pushed `main` through `5439362` so the scheduled Node collector can submit the eleven-source catalog to the compatible Worker. No migrations, resource creation, secret changes, manual collection/ingestion dispatch, new historical-backfill start, or immediate Discord test post occurred. Existing baselines/checkpoints and uncertain delivery handling remain intact. New sources establish silent baselines on their first normal successful collection; initializing their historical cursors still requires separate approval.

Deployment and Git push succeeded. Actual new-source production ingestion, notice/meal client rendering, replacement cleanup and subsequent scheduled deliveries remain unverified; this rollout did not fabricate a live test to demonstrate them.
