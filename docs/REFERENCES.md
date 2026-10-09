# Reference inspection and provenance

Inspected 2026-10-09, read-only local clones; no old resource IDs/settings copied.

- Hiyabye/discord-bot @ 84d2051a3b8c9ae40da57024184d9bbd7f69c0ea: README, src/server.ts, src/register.ts, src/messages.ts, tests. Raw-body Ed25519, REST registration and ambiguous-send behavior informed new original implementations. Package UNLICENSED; inherited MIT template notices belong to that repository. No source copied.
- Hiyabye/sogang-notices @ 5d53d9575c3f92ef2f36d39cecc2c8a406e5be64: README, sources.mjs, collect.mjs, computing.mjs, cms.mjs, pacing.mjs, meal/bellarmine.mjs, meal/extract.mjs, meal/publish.mjs, tests. No license found; original adapters written from official source structure. Date-by-array-position, Pages recovery coupling, old operating rules deliberately not adopted.
- Hiyabye/SogangLife @ 8e606b57d67a8877752e5ed4a858d6721f1bf215: README, MealFeed/NoticeFeed, repositories and UpcomingMeal. Period-aware caches useful; Pages endpoints and Tuesday assumptions not adopted. No license found; no source copied.

Official APIs/documentation:
- https://discord.com/developers/docs/interactions/receiving-and-responding
- https://discord.com/developers/docs/resources/channel#create-message
- https://developers.cloudflare.com/queues/reference/delivery-guarantees/
- https://developers.cloudflare.com/queues/platform/limits/
- https://developers.cloudflare.com/d1/worker-api/d1-database/
- https://developers.cloudflare.com/workers/runtime-apis/nodejs/https/ — `ca` unsupported; Node compatibility does not add custom CA support to Workers fetch.
- https://developers.cloudflare.com/queues/configuration/batching-retries/ — per-message delayed `retry` used for accepted notice snapshots.
- https://openrouter.ai/blog/tutorials/send-image-to-llm/
- https://openrouter.ai/docs/guides/features/structured-outputs
- https://openrouter.ai/docs/guides/routing/provider-selection#max-price
- https://openrouter.ai/api/v1/models

Public model metadata checked, not OCR quality. Free-only policy: default google/gemma-4-31b-it:free currently advertises image input + response_format, but not structured_outputs. Use JSON mode with schema in prompt and unchanged runtime semantic validation; strict schema remains preferred for supporting free models. Every configured ID must end in :free and all published prices must be zero; provider max_price is also zero. Metadata is rechecked before each extraction; changes fail closed. No paid fallback.

Free quota reference: https://openrouter.ai/docs/api/reference/limits — verify account limits; 1000/day is conditional, not universal. Current public guidance reports 50/day by default and 1000/day after at least $10 of credit purchase, with 20/minute for free models.

Limited source live checks: Computing first pages, Bellarmine list/article/image, university API, academic calendar. University Node fetch required an added public intermediate CA; no TLS bypass. Production direct Workers collection is now verified for Computing and Bellarmine; the university origin yields HTTP 526. Follow-up Playwright inspection covered the six supplied pages and their official identities. The project-owned Node collector with the verified Sectigo intermediate succeeded on all six; this does not establish production ingestion or Actions execution. Current direct official snapshots were also parsed offline. Synthetic test fixtures are newly written, not copied menu images/content archives.

Certificate follow-up: reference README's [bundle explanation](https://github.com/Hiyabye/sogang-notices/blob/5d53d9575c3f92ef2f36d39cecc2c8a406e5be64/README.md#why-a-certificate-bundle-is-included) accurately identifies missing intermediates. Only the relevant public CA was independently obtained from the issuer and cryptographically verified; see [certificate provenance](../certificates/README.md). No runtime dependency on that repository or its infrastructure was added.

School content/image reproduction permission is not established. Bot links to originals and limits collection to lists and one necessary image; do not redistribute source images or expand crawling without checking terms. npm dependencies retain their own license notices; no license grant over referenced code is claimed.
