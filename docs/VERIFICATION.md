# Verification record — 2026-10-09

Executed locally:

- `npm run check`: strict TypeScript check and **76 tests passed across six files**; no skipped tests.
- `npm audit`: **0 vulnerabilities** after selecting current Vitest; no automatic force-fix used.
- `WRANGLER_SEND_METRICS=false npx wrangler deploy --dry-run --outdir /tmp/sogang-bot-build`: Worker bundle succeeded; no deployment.
- `wrangler d1 migrations apply sogang-friends --local`: both migrations succeeded in local workerd D1.
- `npm run schedule:import`: generated 27 validated inactive schedule UPSERTs.
- `wrangler d1 execute sogang-friends --local --file=data/schedule.sql`: 27 local statements succeeded.
- Synthetic fixtures, real generated Ed25519 keys, node:sqlite transactions, mocked HTTP. Integration tests include transient webhook PATCH replay, token cleanup, overlapping snapshot locks, rejected-model usage costs, delayed 429, expiry and ambiguous delivery.
- Limited read-only official source/metadata checks and offline parsing of captured official responses are described in REFERENCES.md and schedule-evidence.md.

Not executed: remote migration/resource creation, command registration, Discord posts, paid inference, Cloudflare deploy, staging Workers source TLS, actual Queue redelivery/service concurrency, OCR quality or provider billing verification. SQLite proves SQL behavior, not service equivalence; dry-run proves bundling, not production correctness. GitHub CI workflow is provided but has not run on GitHub.
