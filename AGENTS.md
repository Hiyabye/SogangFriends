# Sogang Friends Bot — agent development instructions

This file is for AI coding agents. Keep [README.md](README.md) short and user-facing: features, Discord commands, notification times and limitations. Put development constraints here; link specialized contracts rather than duplicating them. Historical experiments belong in [docs/VERIFICATION.md](docs/VERIFICATION.md), not current runtime instructions.

## Scope and approvals

- Work locally unless the user explicitly approves external mutations. Do not deploy, apply remote migrations, create resources, register Discord commands, send/delete live messages, dispatch ingesting Actions, change secrets, or push without approval for that action.
- Package installation, dependency changes, model downloads/initialization and paid services require approval. Prefer the installed environment for offline checks.
- Preserve unrelated work. Review the final diff and create coherent Conventional Commits. Report checks actually run and remaining limitations; never equate dry-run, accepted ingestion, job completion and Discord delivery.
- No current LLM inference exists. Do not recreate retired meal callers, comparison workflows or notice-model processing. Historical approvals are not new permission. Future model work needs an explicit design/approval; only verified zero-priced `:free` models and zero-price routing are allowed, never a paid fallback.
- The account's previously confirmed free-model allowance (1,000 requests/day, 20/minute after a credit purchase) is shared across all uses, not a feature budget. No shared model limiter is implemented. Preserve all historical reservations; do not infer active OCR limits from old LLM caps.
- Reference repositories are read-only and unlicensed; write original code against official sources. Never depend on their code, feeds, deployments or settings. See [provenance](docs/REFERENCES.md).

## Runtime and source map

Use **Node >=24**, npm and the committed `package-lock.json`. TypeScript runs in a Cloudflare Worker and native Node scripts. Keep explicit `.ts` extensions on runtime imports reachable from Node entry points; tests/bundlers can otherwise conceal Node resolution failures. Python Actions use 3.11; the existing macOS diagnostic environment supports 3.9.

| Area | Implementation |
|---|---|
| HTTP signature verification, defer, commands | `src/worker.ts`, `src/discord.ts` |
| Cron planning and Queue consumption | `src/jobs.ts` |
| D1 claims, outbox, baselines and recovery | `src/storage.ts`, `migrations/` |
| Eighteen official notice sources | `src/sources.ts`, `src/university-notice-sources.ts`, `src/legacy-notice-sources.ts` |
| Five institution routes | `src/notice-channels.ts` |
| Snapshot HMAC ingress | `src/notice-ingest.ts` |
| Raw archive, pagination and D1 limits | `src/notice-archive*.ts`, `scripts/notice-archive-client.mjs` |
| Recent collection / historical traversal | `scripts/notice-collector.mjs`, `scripts/backfill-notices.mjs` |
| Meal observations, cache and retention | `src/meal-ocr.ts`, `src/meal-cache.ts`, `src/meals.ts` |
| Native OCR and ingestion client | `scripts/meal-ocr/` |
| Discord presentation / board state | `src/*-card.ts`, `src/message-board.ts`, `src/schedule-summary.ts` |
| Schedule validation / reviewed seed | `src/schedule.ts`, `scripts/import-schedule.mjs`, `data/` |
| Operational diagnostics | `src/status.ts`, `docs/JOB-REVIEWS.md` |

The Worker handles HTTP, scheduled and Queue events. Node collectors authenticate with dedicated HMAC secrets, not Discord or Cloudflare write tokens. D1 is truth; Queues carry only job IDs, never images or webhook tokens. Original notices use **D1 only**, not R2. Native OCR must not run inside Workers.

## Verification

```sh
# Install only when approved/needed:
npm ci

# Offline TypeScript, Vitest/real SQLite, and standalone Node OCR-client tests:
npm run check
npm audit
WRANGLER_SEND_METRICS=false npx wrangler deploy --dry-run

# Python synthetic tests; image-dependent cases explicitly skip without Pillow/OpenCV:
python3 -m unittest discover -s scripts/meal-ocr -p 'test_*.py' -q
# Existing full local environment, when present (tests use injected engines):
scripts/meal-ocr/.venv/bin/python -m unittest discover -s scripts/meal-ocr -p 'test_*.py' -q

# Native Node registration-definition import only, no registration/API call:
node --input-type=module -e "import('./src/discord.ts').then(({COMMANDS})=>console.log(COMMANDS.length))"
git diff --check
```

- Vitest fixtures use `node:sqlite` via `tests/helpers/db.ts`, which applies every local migration. Test real SQL transactions, conditional claims, lease recovery and unique IDs; mock external requests.
- `npm test` is Vitest only; `npm run test:ocr` is Node's standalone OCR-client suite. Python is separate. Report skipped geometry tests honestly.
- Ordinary CI performs offline checks/audit/dry-run and lightweight Python tests. The OCR workflow retains the full pinned Python environment and real engine verification. Do not treat lightweight CI as native model verification.
- Operational collector workflows install runtime npm dependencies only; ordinary CI needs dev tools. Notice collection/backfill share `notice-collector` concurrency without cancellation. Keep recent collection **before** historical import.
- Notice collection/backfill `--dry-run` and OCR `prepare` without `--cache` make real read-only official-site requests. Wrangler bundle dry-run and fixture tests do not. Running `evaluate.py`/`runtime-check.py` with real engines can download weights; it is not an offline test.

## Data and delivery invariants

- Preserve official source IDs, `(source,id)` identity, initial silent baselines and last-good timestamps. Failed collection updates attempt/error information, not last-success or good data.
- Dates are KST calendar dates. Never invent cutoff hours, infer dates by array position, move offerings across dates or impose fixed cup-rice weekdays.
- Use D1 conditional claims and atomic batches for durable intent/proof. Repeated Queue delivery must not create a second send. A confirmed Discord POST and D1 tracking are not a distributed transaction: exact-once delivery is not guaranteed.
- Unknown/interrupted Discord **POST** is `uncertain`, never an automatic retry, even if a prior message ID exists. Confirmed rejection/pre-send failure is different. PATCH of a known message can retry; explicitly replace attachment/embed sets so stale content cannot survive.
- New atomic notice plans mark their send payloads with optional `noticePlanVersion:1`. Absence is valid legacy data. Never rewrite an existing plan's destination/content or automatically fill ambiguous old partial plans.
- Admin commands require Manage Guild, server allowlisting and private responses. Validate channel ownership/type and effective permissions before writing settings. Never interpolate untrusted SQL identifiers.
- Never log tokens, webhook payloads, source authors, full upstream error bodies or image bytes. Interaction tokens are transient D1 fields and must be cleared on terminal completion/expiry. `.dev.vars` and `.env` are ignored secrets, not documentation or commit inputs.

## Notices

The eighteen boards map to five groups (expanded Worker deployed and collector pushed with approval on2026-10-16; new baselines await first successful collection):

| Setup group | Source IDs |
|---|---|
| `university` | `university`, `universityStudent`, `universityScholarship`, `universityGeneral`, `universityEvent`, `universityOnestop` |
| `computing` | `academicNotice`, `graduateNotice`, `externalInfo`, `news`, `career` |
| `swedu` | `sweduNotice`, `sweduNews`, `sweduPress` |
| `convedu` | `conveduNotice`, `conveduNews` |
| `bdata` | `bdataNotice`, `bdataNews` |

- Dedicated institution channel overrides `notices_channel`; never also send to fallback. With neither configured, skip that group. Group by destination **before** card batching, preserving existing delivery IDs/committed plans.
- Current production uses all five institution channels with **NULL fallback**; the former combined channel was deleted. Do not restore it from historical verification records.
- `legacy-notice-sources.ts` is **active** CMS/WebSTYLIST support, not dead bot code. The big-data wrapper ID is not its article ID. Keep canonical detail URL checks in ingestion.
- `NOTICE_COLLECTION_MODE=external` must skip both new and previously queued direct collection jobs. Node supplements TLS with exactly the single pinned public intermediate; never disable verification or add unrelated trust material. Follow [certificate checks](certificates/README.md).
- University board configs are source-bound:2/34/141/1/142/3; preserve existing `university` identity. Big-data News is photo board5255, not notice board5256. Convergence subsidiary-program notices are explicitly deferred; candidates and scope are recorded in [collector contract](docs/NOTICE-COLLECTOR.md#deferred-scope-convergence-education-subsidiary-programs).
- Recent scope: 50 entries per university board; at most three HTML pages (SW board pages have 15 regular posts, other HTML boards 10). Source requests are spaced by one second, redirects rejected, timeout 20 seconds. Do not silently turn a parser/transport failure into an empty board or EOF.
- Recent snapshots expire after 30 minutes; notice alerts/intents after 24 hours. Changes to titles/links are not new IDs. Do not reset baselines or replay history to test routing.
- [Collector contract](docs/NOTICE-COLLECTOR.md): HMAC freshness, bounded exact-byte retries and Actions setup.
- [Archive contract](docs/NOTICE-ARCHIVE.md): first retained raw capture, cumulative metadata, capacity guard and slow resumable backfill. Historical imports create no alerts and do not change live baselines/health. Preserve start-day protection so backfill cannot suppress fresh alerts.
- Store original HTML and attachment/image **URLs**, no notice binary downloads. Preserve Office-pasted `file:` image markup in exact originals but omit it (like inline `data:` images) from exported web image references; proven attachment metadata remains strict. `raw/<source>/<id>.json` is a logical key, not a file. `processed/` is reserved; no fake derived outputs or notice models.
- Free D1: 500 MB/database and 2,000,000 bytes/row. Validated raw row columns stay within 1,900,000 bytes. Stop new originals at 400 MB or missing size metadata; preserve captures/cursors. Full-history capacity and worst-case8MiB request feasibility are unproven; the2026-10-14 live run stored four chunked originals up to3,837,519 bytes.
- Deployed migration0009 supports exact HTML up to 8 MiB, detail transport 9 MiB and signed archive JSON 16 MiB; rows above 1 MiB use ordinal chunks. Metadata/chunks/index commit atomically; readers concatenate ordinal order. Migration0009 and the chunk-capable Worker were deployed with explicit approval on 2026-10-14; full-size live feasibility remains unproven.

## Meals and boards

- Actions CPU PaddleOCR primary, EasyOCR fallback; dedicated `MEAL_OCR_INGEST_SECRET`. Observe the banner and all seven column dates/weekdays independently, detect ruling lines, suppress ambiguous merged cells and reject contradictory dates. Do not repair image evidence from article metadata. Spelling errors are acceptable; unreadable offerings are `unknown`.
- Verified official inline PNGs are allowed within existing bounds. Persist canonical article identity, never data URLs or image bytes. D1 cache is keyed by official source, image hash and extraction version; dependency/model caches are not serving truth.
- Retain meal source metadata, derived meals and rejected-result bodies only for **current+next KST Monday–Sunday weeks**. Preserve audit identity/provenance, jobs and all reservations. Notice retention is independent.
- OCR refresh: **06:40 / 17:10 KST**. Morning report **07:00** = today's breakfast+dinner; evening **17:30** = today's dinner+tomorrow's breakfast. Separate slot IDs. Reports omit cup rice; `/meal` remains full-day. Ingestion creates no delivery jobs.
- Bootstrap meal reports only within the current slot's 15-minute window; polling/ingestion cannot bootstrap. Existing boards poll every 15 minutes. Do not replay missed, failed or uncertain historical posts.
- Changed meal display: POST replacement → atomically persist new message tracking + cleanup job → DELETE only the previously tracked message. Cleanup retries independently, never by reposting. Unchanged rendered content must be silent even when image preparation is retrying. Keep intended `content_hash` separate from confirmed `display_hash` (deployed migration0011).
- Components V2 meal containers contain source links and the exact plain text caution **outside/below all cards**: `OCR 판독 결과로 메뉴명에 오탈자가 있을 수 있습니다. 미확인 항목은 원문을 확인하세요.` No mentions.
- When selected offerings are all unknown/missing, attach the matching-week official PNG/JPEG, not an external-image embed. Enforce verified TLS and combined 5 MiB transient files; deduplicate same-week images and support Sunday→Monday two-week reports. Out-of-window/missing sources remain dated links, never a stale image labelled current.
- Recheck date/slot/configuration after downloads. Morning reports expire at 17:30, evening at midnight KST. Legacy delivery payloads without date metadata remain text/link-only.
- Keep `/internal/meal-compare` at410 and retire delayed `meal-extract` jobs **before** claim increments without changing original payload, attempts, errors or reservations. Keep legacy job readers and operator quarantine; these protect durable history, not active inference. No automatic restoration of rejected menus.
- [OCR implementation/tests](scripts/meal-ocr/README.md) documents supported layouts, model hashes, locked environments and local verification. Evaluation snapshots and `evaluate.py` helpers have active consumers; do not remove them as obsolete experiments.

## Schedules

- `data/schedule.json` contains 27 verified entries, not examples. Seed rows are inactive; production previously approved 24 student entries. Importing without `--approve` generates inactive rows, even if JSON says otherwise.
- Official dates/audience need human review. Use stable IDs when dates change; do not delete absent IDs automatically. Mark obsolete entries inactive. Never infer an application deadline from an exam/event end.
- Generate locally: `npm run schedule:import` or, **after review**, `npm run schedule:import -- --approve`. Apply generated `data/schedule.sql` separately to local D1 first. Remote application needs approval. Do not add explicit BEGIN/COMMIT: remote D1 imports manage transactions.
- `/schedule` queries today/ongoing through the exclusive day-30 boundary. The automatic board displays all approved upcoming student entries and ongoing periods, without that upper horizon. No LLM or automated calendar scraping.
- First daily creation opportunity: **07:30 KST** (`MEAL_TIME_KST` is the historical setting name). Existing schedule messages PATCH only changed content every 15 minutes; keep schedule behavior distinct from meal replacement POSTs.
- Keep unknown initial POST frozen. Only exact Discord Unknown Message10008 permits replacing a missing tracked message. Changing channel must not delete/adopt old schedule posts. Oversized embeds fall back to a complete text file.
- [Schedule evidence](docs/schedule-evidence.md) records source discrepancies and import semantics.

## Local setup and approved-operation runbook

- `wrangler.toml` contains the existing project's public resource IDs. Do not create replacement D1/Queues or copy settings from reference projects. Local secrets follow `.env.example`; no OpenRouter key is needed.
- Local D1: `npx wrangler d1 migrations apply sogang-friends --local`; then optionally apply reviewed generated SQL with `npx wrangler d1 execute sogang-friends --local --file=data/schedule.sql`.
- `npm run dev -- --test-scheduled` enables local Cron testing; `/__scheduled` can fetch real sources. Do not mistake it for a fixture-only command.
- Discord installation: `bot` + `applications.commands`, Guild Install, no Administrator or privileged Gateway intents. Require View Channels/Send Messages, Embed Links for schedules and Attach Files for image/text-file fallback. Verify effective permissions in restricted channels.
- For a new installation, configure app ID/public key/allowed guilds, set Worker secrets securely, deploy only approved code/schema and point the Discord interactions URL to `https://<worker>/interactions`. Empty allowlist rejects every server.
- Command registration uses the safely loaded `DISCORD_APPLICATION_ID`/`DISCORD_TOKEN` environment and `npm run register -- --guild GUILD_ID`; `--global` intentionally replaces the global scope. PUT replaces **all** commands in the chosen scope; inspect unknown outcomes before retrying. Do not reset a bot token merely because the local copy is unavailable without explaining production impact.
- Diagnose with `/status` first. `done` is not delivery success; `closed` is review closure, not success; stale review annotations do not match changed attempts/state. Preserve original audit history. Never bulk-reset failed/uncertain jobs, clear baselines or release unknown reservations to clean a dashboard.
- Useful read-only SQL: `SELECT id,state,attempts,error FROM jobs WHERE state!='done' LIMIT 30`; `SELECT id,state,message_id,error FROM deliveries WHERE state!='sent' LIMIT 30`; `SELECT id,initialized,last_success,last_attempt,error FROM sources`. Avoid dumping job payloads/tokens.
- Regular jobs have three claims; leases last20 minutes and recovery conservatively freezes interrupted sends/interactions. Snapshot caught retries use native Queue delays; Cron recovery/dispatch remains necessary for crash recovery and other delayed work. Keep unique history/idempotency keys; no general job-history retention deletion has been approved.

## Current deployment boundary — do not bypass

- Verified production Worker: **`46e9f550-86d7-4692-b14c-b6fc1771e9c3`**, deployed from main **`a87212a`** on2026-10-16 KST with explicit approval, followed by collector push in that order. It supports18 notice boards; the seven new sources had no production baselines at rollout readback and await first successful collection. Existing five institution routes and NULL fallback were confirmed unchanged. Earlier archive-reference, temporary meal-image and meal-label fixes remain included. This rollout did not dispatch collection/backfill/OCR workflows or verify new-source delivery; see [verification history](docs/VERIFICATION.md).
- Production has migrations**0001–0011**, including separately approved0009 and0011. No migrations remained pending after application. Existing original captures, notice baselines and guild routing were preserved.
- This was a scoped rollout, not blanket permission for subsequent migrations/deployments. Inspect every future pending migration and obtain approval; keep schema/code compatible.
- Five manual channel cards containing25 already collected notices were confirmed by Discord API readback. The2026-10-14 live collection also completed22 snapshots and one new `externalInfo` notice delivery to computing, with marker1 and Components V2 readback; this does not prove every route or visual client rendering. Old combined channel is deleted and fallback is NULL.
- The2026-10-14 follow-up explicitly approved push, migration0009/0011, deployment and workflow verification: notices/backfill in normal mode with `start=false`, OCR with `ingest=false`. The2026-10-15 follow-up separately approved push/deploy and actual backfill retry plus OCR `ingest=false` verification followed by `ingest=true` only after verification passed. These scoped approvals do not authorize future executions or secret changes. A cleanup request alone never authorizes external mutations. See [verification history](docs/VERIFICATION.md) for exact rollout provenance and unresolved limits.
