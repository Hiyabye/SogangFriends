# Independent notice collector

## Scope and current operation

The project-owned Node/GitHub Actions collector uses the shared `src/sources.ts` catalog and parsers. Production supports eighteen official boards. The seven additions were deployed to the Worker before the updated collector was pushed, with approval on2026-10-16 KST; their initial live baselines remain unverified. Four Engineering boards are additional local-only work, bringing the local catalog to22; they are not deployed or collecting in production:

| Source ID | Official page |
|---|---|
| `university` | <https://www.sogang.ac.kr/ko/academic-support/notices> |
| `universityStudent` | <https://www.sogang.ac.kr/ko/campus/student-support/notice> (config34) |
| `universityScholarship` | <https://www.sogang.ac.kr/ko/scholarship-notice> (config141) |
| `universityGeneral` | <https://www.sogang.ac.kr/ko/story/notification-general> (config1) |
| `universityEvent` | <https://www.sogang.ac.kr/ko/story/notification-event> (config142) |
| `universityOnestop` | <https://www.sogang.ac.kr/ko/announcement> (config3) |
| `academicNotice` | <https://computing.sogang.ac.kr/ko/community/academicNotice/list> |
| `graduateNotice` | <https://computing.sogang.ac.kr/ko/community/graduateNotice/list> |
| `externalInfo` | <https://computing.sogang.ac.kr/ko/community/externalInfo/list> |
| `news` | <https://computing.sogang.ac.kr/ko/community/news/list> |
| `career` | <https://computing.sogang.ac.kr/ko/community/career/list> |
| `sweduNotice` | <https://scc.sogang.ac.kr/front/cmsboardlist.do?siteId=sweducenter&bbsConfigFK=7250> |
| `sweduNews` | <https://scc.sogang.ac.kr/front/cmsboardlist.do?siteId=sweducenter&bbsConfigFK=7251> |
| `sweduPress` | <https://scc.sogang.ac.kr/front/cmsboardlist.do?siteId=sweducenter&bbsConfigFK=7252> |
| `conveduNotice` | <https://convedu.sogang.ac.kr/front/cmsboardlist.do?siteId=convedu&bbsConfigFK=5551> |
| `conveduNews` | <https://convedu.sogang.ac.kr/front/cmsboardlist.do?siteId=convedu&bbsConfigFK=5550> |
| `bdataNotice` | <https://sc.sogang.ac.kr/bdata/4305.html> |
| `bdataNews` | <https://sc.sogang.ac.kr/bdata/4306.html> |
| `engineeringNotice` (local only) | <https://eng.sogang.ac.kr/board/notice> |
| `engineeringRecruit` (local only) | <https://eng.sogang.ac.kr/board/recruit> |
| `engineeringAcademic` (local only) | <https://eng.sogang.ac.kr/board/academic> |
| `engineeringResearch` (local only) | <https://eng.sogang.ac.kr/board/research> |

The original eleven sources have initialized live baselines and stored production rows; five institution channels have confirmed manual Components V2 verification messages. A subsequent2026-10-14 live run verified one new `externalInfo` notice through ingestion, Queue processing, institution routing and Discord readback. This does not prove full history or every source/destination route. Current production includes the approved oversized-original change and migrations0009/0011; see [rollout evidence](VERIFICATION.md) and [archive limits](NOTICE-ARCHIVE.md#size-limits) for observed verification and remaining capacity limits.

```text
Official sources → Node → HMAC /internal/notices → D1 snapshot job → Queue → Discord
                       └→ optional /internal/notice-archive → D1 original + index
```

The collector needs no Discord, model or Cloudflare account API token and sends no Discord messages directly. First successful collection establishes a silent baseline; stable official IDs suppress duplicate/reordered/pinned posts. Later title/link updates do not become new alerts. A source failure does not stop healthy sources, but makes the run fail. A raw-capture failure likewise reports failure without suppressing an otherwise valid recent snapshot.

The six university lists use official JSON; the remaining local sources are HTML. Big-data wrappers `4305` and `4306` embed WebSTYLIST boards `bbsid=5256` (notices) and `bbsid=5255` (photo-style News); wrapper IDs are not article IDs. Photo News validates page counts against its advertised total rather than table-row ordinals. Recent polling is bounded to **50 rows per university board** and **three pages per HTML board** (15 regular rows/page for SW boards, 10 for the others), not full-history traversal.

Node uses one scoped, verified public intermediate to fix the official site's incomplete certificate chain. Never disable TLS or add unrelated trust material; see [certificate provenance](../certificates/README.md). There is no dependency on reference repositories' code, feeds or infrastructure.

## Engineering expansion — local only

The approved scope is the four public Engineering boards above, grouped under `engineering` (공과대학). Newsletter, Dean's List student rosters and separate department sites are not included. Intended destination: channel `1560465047128514640`; this is user-provided intent, not verified live configuration. No channel ID is hard-coded in source definitions.

`src/engineering-notice-sources.ts` validates source-bound canonical URLs, board headings and active navigation. Lists have ten regular rows per page; pinned rows appear only on page1 and are included in the displayed total but excluded from regular ordinals. Pagination and contiguous ordinals must prove final-page coverage; empty/out-of-range responses reject rather than imply EOF. Details preserve exact inner HTML, compare visible publication dates with timestamp-derived KST dates, and extract proven attachment/image URLs without downloading binaries.

Read-only native Node checks collected36/23/5/30 recent entries from General/Recruitment/Academic/Research respectively, parsed an original article from each, and verified final pages36/3/1/28. This establishes the observed markup contract, not full-history ingestion, capacity or Discord delivery.

Local migration `0012_engineering_channel.sql` adds nullable `guilds.engineering_channel`; `/setup engineering` follows the existing institution validation and override/fallback rules. Omitted setup options remain unchanged. Existing baselines, last-good data, committed delivery plans and historical cursors must remain intact. Engineering's first successful collection must establish silent baselines, not send retained posts.

This expansion differs from the earlier seven-board rollout: a sixth institution requires a schema addition and changed Discord command definitions. With explicit approval for each external operation, apply the additive migration **before** deploying Worker code that queries the column; update registered commands and validate/configure the Engineering channel; only then push the expanded collector. No migration application, deployment, command registration, channel configuration, push, workflow dispatch or historical traversal is authorized by approval of local implementation alone. New-source delivery remains unverified until an approved run is observed end to end.

## Deferred scope: Convergence Education subsidiary programs

The user explicitly deferred subsidiary-program sites; do not add them automatically to the `convedu` route. Candidates found through official program links include Big Data Science (`bds`,2067), Convergence Software (`csw`,1343), Artificial Intelligence (`aix`,2066), and Digital Humanities (`digihum`,5590). Their separate public notice lists were verified read-only. Other program menus also expose boards; a future expansion needs a fresh scope/ownership review, source verification and approval. Application/Q&A boards are not notice feeds by default. Only the parent site's center news5550 is included in this expansion.

## Schedule and read-only checks

`.github/workflows/notices.yml` runs at **09:10, 15:10, 21:10 and 03:10 KST** (00:10/06:10/12:10/18:10 UTC), sharing serialized `notice-collector` concurrency with backfill, without cancellation. Its thirty-minute timeout allows initial raw capture. GitHub schedules may be delayed or disabled; monitor freshness rather than treating cron as an SLA.

Worker Cron is separately active every **15 minutes** for meal/schedule planning and job recovery. `NOTICE_COLLECTION_MODE=external` skips both newly planned and previously queued direct notice collection; do not run two collection paths. External polling does not replace Worker recovery.

From the repository root, with Node24+ and dependencies installed:

```sh
npm run notices:collect -- --dry-run
```

No arguments also means dry-run. This performs **real read-only HTTPS requests**, not fixture tests. The launcher scopes `NODE_EXTRA_CA_CERTS=certificates/sogang-ov-r36.pem` to Node; startup rejects missing/wrong CA configuration and `NODE_TLS_REJECT_UNAUTHORIZED=0`. Output contains source IDs/counts, not authors, credentials or full upstream bodies. Avoid tight polling loops.

## Upload configuration and approval

Production is already configured; these are requirements for a new environment, not instructions to repeat activation. **Secret changes, Git push, deployment, workflow dispatch and uploads need approval.** Production Worker `46e9f550-86d7-4692-b14c-b6fc1771e9c3` was deployed from main `a87212a` on2026-10-16 KST, then the expanded collector was pushed, in the user-approved order. No migrations were pending or applied; previously approved0009/0011 remain applied. All18 boards are supported by deployed code, but the seven new baselines were absent at rollout readback and await collection. No collector workflow was manually dispatched. Future source expansions likewise require Worker deployment before collector push; no schema migration or command registration was needed for this expansion. Each new source establishes its own silent baseline without resetting the original sources or historical cursors. Starting historical traversal for the new sources remains a separately approved action. Future changes still require their own approval.

1. Configure the **same** dedicated `NOTICE_INGEST_SECRET` in Worker and Actions, privately. Keep the existing D1/Queue/baselines. Do not paste secrets into chat, Git, command arguments or logs.
2. Deploy the approved Worker/schema with `NOTICE_COLLECTION_MODE=external`. Raw capture additionally requires its own matching schema and flag; follow [NOTICE-ARCHIVE.md](NOTICE-ARCHIVE.md).
3. Set Actions variable `NOTICE_INGEST_URL` to exactly `https://<worker>.workers.dev/internal/notices`. The same-named secret is a fallback; the variable takes precedence. No URL credentials, query, fragment or redirects.
4. Push only reviewed, approved code. Confirm repository Actions/billing policy before activation; included minutes are not unlimited or a permission to incur cost.
5. After an approved run, inspect source counts and `/status` or D1 results. HTTP202 means durable snapshot acceptance, **not** Queue completion, raw archival or a Discord post. New source baselines must not broadcast old records.

For an explicitly approved local upload, securely set the endpoint/shared secret in the process environment:

```sh
npm run notices:collect -- --send
```

Worker-stored secrets cannot be read into the local process automatically. No Cloudflare write token belongs in these Actions jobs.

## Authentication and retries

Each source is submitted as JSON with `source` and `notices`; every notice has official `id`, matching `source`, `title`, canonical `published` date and official `url`. Headers:

- `content-type: application/json`
- `x-collector-timestamp`: 13-digit Unix milliseconds
- `x-collector-signature`: HMAC-SHA256 hex over the **exact** `${timestamp}.${body}` bytes

The Worker allows **256 KiB / 100 notices per snapshot**, a ten-second body-read deadline and a five-minute signature window, checked again before acceptance. The client makes at most **three attempts**, reusing identical signed bytes after transport ambiguity, 429 or 5xx. Each request times out after20 seconds. Waits default to1/2 seconds; valid Retry-After up to30 seconds is honored, while longer waits stop that source rather than retrying early. Redirects, auth/other4xx and unexpected non202 responses are terminal. Response bodies and transport exception details are not logged; classifications distinguish collection from upload failure.

Accepted snapshots expire after30 minutes. Caught processing failures use native Queue retry delays120/240 seconds, at most three D1 claims, without waiting for Cron. Crash/lease recovery and delayed delivery retries still depend on Worker Cron. Stable snapshot and source/notice keys prevent duplicate work after an ambiguous acceptance response. A Discord POST with unknown outcome remains `uncertain`, never an automatic retry; exact-once external delivery is not guaranteed.

## Verification boundaries

`npm run check` covers fixture parsers, canonical identities, signature/freshness/body limits, exact retry reuse, source isolation, baseline/deduplication, routing and durable send behavior with mocked external calls. Read-only dry-run tests real source access but not ingress/Queue/Discord. Manual verification messages prove destination/card transport, not automatic ingestion. Historical run details and remaining live verification gaps belong in [VERIFICATION.md](VERIFICATION.md), not duplicated counts here.
