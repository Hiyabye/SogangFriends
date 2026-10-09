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
