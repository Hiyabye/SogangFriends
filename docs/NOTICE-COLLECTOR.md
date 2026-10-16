# Independent notice collector

## Scope and current operation

The project-owned Node/GitHub Actions collector uses the shared `src/sources.ts` catalog and parsers. Production supports24 official boards across eight institution/department routes. The Psychology/Business expansion was deployed with explicit approval on2026-10-16 KST and initialized32/34-notice silent baselines. The earlier Engineering run38893089176 completed all22 then-current D1 snapshot jobs and established four silent Engineering baselines:

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
| `engineeringNotice` | <https://eng.sogang.ac.kr/board/notice> |
| `engineeringRecruit` | <https://eng.sogang.ac.kr/board/recruit> |
| `engineeringAcademic` | <https://eng.sogang.ac.kr/board/academic> |
| `engineeringResearch` | <https://eng.sogang.ac.kr/board/research> |
| `psychologyNotice` | <https://psychology.sogang.ac.kr/front/cmsboardlist.do?siteId=psychology&bbsConfigFK=1002> |
| `businessNotice` | <https://sbs.sogang.ac.kr/bbs/sbs/649/artclList.do> |

All24 sources have initialized live baselines and stored production rows. Five pre-Engineering institution channels have confirmed manual Components V2 verification messages; a2026-10-14 live run verified one new `externalInfo` notice through ingestion, Queue processing, routing and Discord readback. Engineering's first collection stored94 notices and94 originals without creating delivery intents, as required for a silent baseline. Psychology/Business's initial run38909891939 accepted metadata for all24 sources, and both new D1 snapshot jobs completed on their first claim without errors or new-source `notice-alert` jobs. Raw capture initially failed after storing2 Psychology and1 Business originals. After parser fixes, retry38913727845 succeeded: all24 snapshot jobs completed, and D1 retained32 Psychology/34 Business notices with matching originals and no new-source alert jobs. This proves recent-scope retention, not full history or new Engineering/department Discord delivery. Current production has migrations0001–0017, including the separately approved [dispatch reservation rollout](QUEUE-DISPATCH.md); see [rollout evidence](VERIFICATION.md) and [archive limits](NOTICE-ARCHIVE.md#size-limits) for observed verification and remaining capacity limits.

```text
Official sources → Node → HMAC /internal/notices → D1 snapshot job → Queue → Discord
                       └→ optional /internal/notice-archive → D1 original + index
```

The collector needs no Discord, model or Cloudflare account API token and sends no Discord messages directly. First successful collection establishes a silent baseline; stable official IDs suppress duplicate/reordered/pinned posts. Later title/link updates do not become new alerts. A source failure does not stop healthy sources, but makes the run fail. A raw-capture failure likewise reports failure without suppressing an otherwise valid recent snapshot.

The six university lists use official JSON; the remaining eighteen sources are HTML. Big-data wrappers `4305` and `4306` embed WebSTYLIST boards `bbsid=5256` (notices) and `bbsid=5255` (photo-style News); wrapper IDs are not article IDs. Photo News validates page counts against its advertised total rather than table-row ordinals. Recent polling is bounded to **50 rows per university board** and **three pages per HTML board** (15 regular rows/page for SW boards, 10 for the others), not full-history traversal.

Node uses one scoped, verified public intermediate to fix the official site's incomplete certificate chain. Never disable TLS or add unrelated trust material; see [certificate provenance](../certificates/README.md). There is no dependency on reference repositories' code, feeds or infrastructure.

## Engineering expansion — deployed

The approved scope is the four public Engineering boards above, grouped under `engineering` (공과대학). Newsletter, Dean's List student rosters and separate department sites are not included. Channel `1560465047128514640` in guild `1558118900347183374` passed ownership/type/effective View Channel and Send Messages validation and is configured in D1. No channel ID is hard-coded in source definitions.

`src/engineering-notice-sources.ts` validates source-bound canonical URLs, board headings and active navigation. Lists have ten regular rows per page; pinned rows appear only on page1 and are included in the displayed total but excluded from regular ordinals. Pagination and contiguous ordinals must prove final-page coverage; empty/out-of-range responses reject rather than imply EOF. Details preserve exact inner HTML, compare visible publication dates with timestamp-derived KST dates, and extract proven attachment/image URLs without downloading binaries.

Read-only native Node checks collected36/23/5/30 recent entries from General/Recruitment/Academic/Research respectively, parsed an original article from each, and verified final pages36/3/1/28. This establishes the observed markup contract, not full-history ingestion, capacity or Discord delivery.

Deployed migration `0012_engineering_channel.sql` adds nullable `guilds.engineering_channel`; registered `/setup engineering` follows the existing institution validation and override/fallback rules. A guarded D1 update changed only the Engineering destination and update timestamp; readback confirmed the five old institution routes, meal/schedule settings and NULL fallback unchanged. The initial live collection retained36/23/5/30 notices and originals for General/Recruitment/Academic/Research. All four sources are initialized with no errors; no Engineering delivery intents were created.

This expansion required schema and command-definition changes: migration0012 preceded Worker deployment, then guild command registration and channel validation/configuration preceded collector push. The five known guild commands were replaced and read back; the empty global scope was untouched. No historical backfill was started/dispatched. Future external changes require fresh approval. New Engineering Discord delivery and visual rendering remain unverified; silent baselines are not delivery proof.

## Psychology and Business expansion — deployed

The explicitly approved rollout added two independent routes, bringing production to24 sources across eight routes. Both destinations in guild `1558118900347183374` passed ownership/type/effective View Channel and Send Messages validation and are configured in D1, not hard-coded in source definitions.

| Source | Official list | Route | Validated destination |
|---|---|---|---|
| `psychologyNotice` | <https://psychology.sogang.ac.kr/front/cmsboardlist.do?siteId=psychology&bbsConfigFK=1002> | `psychology` | `1560644512672649309` |
| `businessNotice` | <https://sbs.sogang.ac.kr/bbs/sbs/649/artclList.do> | `business` | `1560644541982445680` |

Psychology reuses the strict CMS parser. The supplied Business wrapper `/sbs/2088/subview.do?enc=...` resolves board649; direct official list/article endpoints are used as canonical identities, not the wrapper. This source is 경영대학 학부 공지사항, routed under the requested 경영학과 name. No other Business boards are included.

`src/business-notice-sources.ts` binds list/detail `og:url`, form actions and article links to SBS board649. Lists have ten regular rows/page; pins repeat across pages and can also occur in the regular rows. Matching duplicates are deduplicated, conflicting metadata rejects. Total count, contiguous regular ordinals and current/total/next/last pagination jointly prove EOF. Details verify title/date and preserve exact `.viewCont .txt` inner HTML. Explicit attachment URLs must use board649's download endpoint; attachment IDs differ from article IDs. Empty or malformed pages never imply EOF. No attachment/image binaries are downloaded.

Read-only native Node checks through the integrated collector returned32 Psychology and34 Business recent notices. Business pages1/2/36 were checked against official HTML. Initial live run38909891939 accepted all24 source snapshots but failed original capture after2 Psychology and1 Business originals. D1 readback confirmed both new snapshot jobs `done` on their first claim, source initialization with no errors,32/34 retained notices and no `notice-alert` jobs for either source. That initial readback verified silent baselines, not complete recent archival; the successful retry below supplied the latter evidence.

The detail-parser follow-up handles nested pasted CMS `.post_cont` wrappers, K2Web's explicit no-attachment marker, double-escaped hidden title entities and the exact encoded100-character list preview, including mid-entity cuts. The full visible detail title still must match, alongside source/article/date checks. Retry38913727845 succeeded; D1 readback confirmed all32 Psychology and34 Business originals retained, both sources healthy and their repeat snapshot jobs done on the first claim. Full-history capacity, new department Discord delivery and client rendering remain unverified.

Applied migration `0016_department_channels.sql` added nullable Psychology/Business channel columns before initial Worker `8b0abaf7-52fd-4405-8e9f-8a56740eb121` from `6fe51c9`. Follow-up Worker `8d7e471b-1b33-41a4-a88d-edae2c981851` from `a35f96c` deployed on2026-10-16 at approximately23:11 KST. Five guild commands were replaced and read back with `/setup psychology` and `/setup business`; empty global scope was untouched. Guarded D1 configuration readback confirmed the six existing institution routes, meal/schedule/library settings and NULL fallback unchanged. Main push CI38909891919 and follow-up CI38913728703 passed.

This rollout explicitly authorized push, migration, deployment, command registration, route configuration and collection uploads. No test messages or historical backfill were sent/dispatched. Future external changes still need fresh approval; never replay old notices or reset baselines for verification. See [current deployment boundary](../AGENTS.md#current-deployment-boundary--do-not-bypass) and [verification history](VERIFICATION.md) for final retry evidence.

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

Production is already configured; these are requirements for a new environment, not instructions to repeat activation. **Secret changes, Git push, deployment, workflow dispatch and uploads need approval.** Current production Worker `a78d19fc-2a5c-4c34-8019-72291f476e91` was deployed from main `5a93604` after the separately approved migration0017 (0001–0017 applied; local library live-board0018 is pending separately). The automatic23:45 KST Cron verified direct planning/reservation but hit the already exhausted daily Queue quota; post-reset consumption and savings remain unverified. The earlier department Worker `8d7e471b-1b33-41a4-a88d-edae2c981851` deployed from `a35f96c` after migration0016. Department command/channel configuration preceded collector push. Initial run38909891939 accepted all24 metadata snapshots and D1 readback confirmed both new silent baselines, but raw capture initially failed. After parser fixes, retry38913727845 succeeded; all24 D1 snapshot jobs completed and all66 recent department originals were retained. The earlier Engineering Worker `9a0aafa2-0716-403b-8c84-8c642e0f3054` from `802615b` and run38893089176 verified the then-current22 boards and four silent Engineering baselines. Future expansions likewise require compatible schema/Worker before collector push; a new institution route also needs command/channel configuration. Preserve existing baselines and historical cursors. Historical traversal was not started/dispatched during this rollout. Future changes still require their own approval.

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

The deployed Queue optimization applied migration0017 before Worker deployment; see the [dispatch contract](QUEUE-DISPATCH.md). It reserves dispatch for two minutes, including after unknown Queue send outcomes. Signed replays reuse an active reservation rather than immediately sending another message; a replay's202 confirms durable acceptance even if the initial send failed. Recovery runs at the next dispatcher invocation after lease expiry. Native retries reserve through their due time plus the same grace, preventing competing Cron sends. Deployment is confirmed, but successful processing after the exhausted daily quota resets remains unverified.

Accepted snapshots expire after30 minutes. Caught processing failures use native Queue retry delays120/240 seconds, at most three D1 claims, without waiting for Cron. Crash/lease recovery and delayed delivery retries still depend on Worker Cron. Stable snapshot and source/notice keys prevent duplicate work after an ambiguous acceptance response. A Discord POST with unknown outcome remains `uncertain`, never an automatic retry; exact-once external delivery is not guaranteed.

## Verification boundaries

`npm run check` covers fixture parsers, canonical identities, signature/freshness/body limits, exact retry reuse, source isolation, baseline/deduplication, routing and durable send behavior with mocked external calls. Read-only dry-run tests real source access but not ingress/Queue/Discord. Manual verification messages prove destination/card transport, not automatic ingestion. Historical run details and remaining live verification gaps belong in [VERIFICATION.md](VERIFICATION.md), not duplicated counts here.
