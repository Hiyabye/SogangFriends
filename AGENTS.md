# Sogang Friends Bot

- One TypeScript Worker: fetch interactions, scheduled planning, durable Queue consumers; D1 is source of truth.
- Use npm and commit package-lock.json. Node >=24. Tests use node:sqlite.
- Commands: npm ci; npm run check; npm audit; npx wrangler deploy --dry-run.
- Never issue live Discord posts, paid model calls, create Cloudflare resources, register commands, or deploy without user approval.
- References are read-only and unlicensed; write original code. Never depend on old feeds/services/settings.
- Preserve official IDs, last-good timestamps, initial notice baseline, KST date-only semantics.
- Unknown Discord POST outcome is uncertain, not a retry. Idempotent webhook PATCH can retry.
- AI JSON validity is not factual accuracy; require observed dates/weekdays and evidence. No fixed cup-rice weekday rules.
- D1 conditional claims/unique keys protect duplicate deliveries. Test SQL using SQLite and external calls with fixtures.
- Never log tokens, webhook payloads, source authors, or full upstream error bodies. Keep admin replies ephemeral.
- Update README limitations honestly and review final diff.
