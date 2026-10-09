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
- https://openrouter.ai/blog/tutorials/send-image-to-llm/
- https://openrouter.ai/docs/guides/features/structured-outputs
- https://openrouter.ai/docs/guides/routing/provider-selection#max-price
- https://openrouter.ai/api/v1/models

Public model metadata checked, not OCR quality. Default qwen/qwen3-vl-32b-instruct currently advertises image input + structured_outputs + response_format and budgetable pricing. Routing requires parameter support. Metadata is rechecked before each extraction; changes fail closed. Other models remain configurable but unsupported additional charge dimensions are conservatively blocked.

Limited source live checks: Computing first pages, Bellarmine list/article/image, university API, academic calendar. University Node fetch required an added public intermediate CA; no TLS bypass. Native Workers compatibility is not proven until an approved staging deployment. Current direct official snapshots were also parsed offline. Synthetic test fixtures are newly written, not copied menu images/content archives.

School content/image reproduction permission is not established. Bot links to originals and limits collection to lists and one necessary image; do not redistribute source images or expand crawling without checking terms. npm dependencies retain their own license notices; no license grant over referenced code is claimed.
