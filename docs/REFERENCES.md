# Reference inspection and provenance

Historical provenance record: inspected 2026-10-09 using read-only local clones; no old resource IDs/settings copied. Statements about checks below describe those inspections, not the current rollout state. For current development rules see [AGENTS.md](../AGENTS.md); later operating evidence is in [VERIFICATION.md](VERIFICATION.md).

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

Historical meal LLM research (replaced by OCR after the 2026-10-13 verification; no current meal inference): public model metadata was checked, not OCR quality. The former free-only policy used primary `google/gemma-4-31b-it:free` and explicitly approved `google/gemma-4-26b-a4b-it:free` fallback, five attempts per model with progressive backoff (approved 2026-10-10). At inspection they advertised image input and `response_format`, but not `structured_outputs`; the former implementation therefore used JSON mode plus semantic validation. IDs required the `:free` suffix, all published prices had to be zero, and provider `max_price` was zero. Metadata was rechecked before each extraction and changes failed closed; there was no paid fallback. See [native OCR verification](../scripts/meal-ocr/actions-verification.json) for the replacement. Historical references do not enable model calls.

Free quota reference: https://openrouter.ai/docs/api/reference/limits — verify account limits; 1000/day is conditional, not universal. Current public guidance reports 50/day by default and 1000/day after at least $10 of credit purchase, with 20/minute for free models.

Limited source live checks: Computing first pages, Bellarmine list/article/image, university API, academic calendar. University Node fetch required an added public intermediate CA; no TLS bypass. At that inspection, direct Workers collection was verified for Computing and Bellarmine; the university origin yielded HTTP 526. Follow-up Playwright inspection covered the six supplied pages and their official identities. The project-owned Node collector with the verified Sectigo intermediate succeeded on all six; this does not establish production ingestion or Actions execution. Current direct official snapshots were also parsed offline. Synthetic test fixtures are newly written, not copied menu images/content archives.

Certificate follow-up: reference README's [bundle explanation](https://github.com/Hiyabye/sogang-notices/blob/5d53d9575c3f92ef2f36d39cecc2c8a406e5be64/README.md#why-a-certificate-bundle-is-included) accurately identifies missing intermediates. Only the relevant public CA was independently obtained from the issuer and cryptographically verified; see [certificate provenance](../certificates/README.md). No runtime dependency on that repository or its infrastructure was added.

School content/image reproduction permission is not established. The current approved implementation collects official notice metadata and original article HTML with attachment/image URLs, and uses bounded official meal images for OCR and matching-week Discord image fallback. Notice attachment/image binaries are not downloaded. This implementation scope is not a copyright license: do not expand crawling, image redistribution or public HTML rendering without checking terms and obtaining approval. npm dependencies retain their own license notices; no license grant over referenced code is claimed.
