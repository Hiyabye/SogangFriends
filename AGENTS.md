# Sogang Friends Bot

- One TypeScript Worker plus a standalone Node/GitHub Actions notice collector. Worker handles authenticated snapshots, Discord interactions, scheduled meal/reminder planning and durable Queues; D1 is state/index truth, private R2 stores notice raw files when enabled.
- Six-board catalog/parsers are shared. Node TLS stays verified with the single pinned public intermediate; never disable verification or load extra trust material. External collection mode must skip legacy direct collection jobs too.
- Use npm and commit package-lock.json. Node >=24. Tests use node:sqlite.
- Commands: npm ci; npm run check; npm audit; npx wrangler deploy --dry-run.
- Never issue live Discord posts, paid model calls, create Cloudflare resources, register commands, or deploy without user approval.
- References are read-only and unlicensed; write original code. Never depend on old feeds/services/settings.
- Preserve official IDs, last-good timestamps, initial notice baseline, KST date-only semantics.
- Unknown Discord POST outcome is uncertain, not a retry. Idempotent webhook PATCH can retry.
- OpenRouter free models only: require :free ID, verified zero prices and zero-price routing. No paid fallback. Use strict schema when supported, otherwise JSON mode plus the same semantic validation.
- User confirmed purchasing at least US$10 in OpenRouter credits (2026-10-10): free-model quota is 1,000 requests/day and 20 requests/minute. Treat this as an account-wide allowance shared by meals, future notice processing and other uses, not a separate allowance per feature. Purchased credits do not authorize paid models. These account limits are not the current meal-specific daily cap; do not automatically increase that cap or claim a shared limiter is already implemented.
- Notice archive requirements: retain collected notices cumulatively; separate source/raw content from derived LLM results; slowly backfill currently accessible official history once, then poll only recent ranges. Historical imports must never create Discord alerts or reset live baselines. Do not try to recover articles deleted before collection. Approved scope: all six boards, original article HTML + attachment/image URLs (no binary downloads), private R2 raw/<source>/<id>.json + existing D1 metadata/checkpoints. One retained raw capture per notice; no revision archive. processed/ is reserved for later LLM results; do not create fake outputs or run notice models in this phase. Archive/backfill activation, resource creation, remote migrations, deployment and live execution require separate approval.
- Meal retry policy approved 2026-10-10: primary google/gemma-4-31b-it:free up to five attempts, then google/gemma-4-26b-a4b-it:free up to five, with per-model 1/2/4/8-minute waits and longer Retry-After honored. Only pre-inference failures, confirmed rejections and completely received invalid outputs retry; uncertain inference stops. Both models exhausted means operator choice, never an automatic third model. The meal daily cap counts new runs, not HTTP attempts; preserve unknown reservations and historical ledgers. Release only explicitly approved confirmed-rejection reservations.
- Assume no meaningful same-date meal revisions; do not add revision-history machinery for hypothetical menu edits. Keep strict extraction/date validation.
- AI JSON validity is not factual accuracy; require observed dates/weekdays and evidence. No fixed cup-rice weekday rules.
- D1 conditional claims/unique keys protect duplicate deliveries. Test SQL using SQLite and external calls with fixtures.
- Never log tokens, webhook payloads, source authors, or full upstream error bodies. Keep admin replies ephemeral.
- Update README limitations honestly and review final diff.
