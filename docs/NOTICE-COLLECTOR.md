# Independent notice collector

## Architecture and scope

The project-owned Node collector reads these six official boards using the same `src/sources.ts` catalog and parsers as the Worker:

| Source ID | Official page |
| --- | --- |
| `university` | <https://www.sogang.ac.kr/ko/academic-support/notices> |
| `academicNotice` | <https://computing.sogang.ac.kr/ko/community/academicNotice/list> |
| `graduateNotice` | <https://computing.sogang.ac.kr/ko/community/graduateNotice/list> |
| `externalInfo` | <https://computing.sogang.ac.kr/ko/community/externalInfo/list> |
| `news` | <https://computing.sogang.ac.kr/ko/community/news/list> |
| `career` | <https://computing.sogang.ac.kr/ko/community/career/list> |

The university page loads its public JSON API; the five college lists are HTML. Collection is bounded to 50 university entries and at most three pages per college board. This is recent-list polling, **not full-history archival**. Original official IDs, URLs, dates and pinned-row handling are preserved. A source failure does not stop the other five; any failure makes the process exit nonzero so Actions reports the incomplete run.

Node -> authenticated Worker `/internal/notices` -> durable D1/Queue -> existing baseline/deduplication/Discord delivery. The collector does not need Discord, OpenRouter or Cloudflare account API credentials. It does not call a model or directly post to Discord. First successful collection of a new board establishes a baseline and does not notify its existing posts. Existing board baselines remain intact.

The source certificate-chain defect is solved with a verified public Sectigo intermediate, **not** by disabling TLS. See [certificate provenance and checks](../certificates/README.md). No reference-repository code, feed, deployment or infrastructure is used. Playwright CLI was used for read-only inspection of the real pages, not introduced as a production browser dependency.

This collector schedules **notices only**. It does not fix or replace the separate Worker Cron used for meals, daily academic reminders and general job recovery. The previously unresolved native Cron invocation problem must still be diagnosed independently. Worker notice polling must be switched to external collection mode when deploying this ingestion path, to avoid two active collectors.

## Local read-only verification

Node 24 or newer and the project's existing npm dependencies are required:

```sh
npm run notices:collect -- --dry-run
```

No arguments also defaults to dry-run. The launcher scopes `NODE_EXTRA_CA_CERTS=certificates/sogang-ov-r36.pem` to this Node process. Output contains source IDs and counts only, never source authors, upstream bodies or credentials. This command still makes read-only official website requests, so do not run it in a tight loop.

There is no insecure TLS fallback. Startup rejects missing/wrong CA configuration, weak send secrets, bad URL settings and `NODE_TLS_REJECT_UNAUTHORIZED=0`.

## Setup before production upload

**Implementation and offline tests do not activate the workflow, configure secrets, deploy, or send snapshots. Obtain explicit user approval for those actions.**

1. Set `NOTICE_INGEST_SECRET` using `npx wrangler secret put NOTICE_INGEST_SECRET`, then deploy (`npm run deploy`) with `NOTICE_COLLECTION_MODE = "external"` in `wrangler.toml`. Keep the existing D1 and Queue; do not create replacement resources or reset source baselines.
2. Generate a dedicated random shared secret locally, for example `openssl rand -hex 32`. Do not paste it into chat, Git or a shell command argument. Set the same value as Worker secret `NOTICE_INGEST_SECRET` and GitHub repository Actions secret `NOTICE_INGEST_SECRET`. This secret permits submission of notices and must remain private.
3. Set GitHub Actions secret `NOTICE_INGEST_URL` to the exact HTTPS production URL:

   ```text
   https://<your-worker>.workers.dev/internal/notices
   ```

   No URL credentials, query string or fragment. Never put the authentication secret in the URL. The script refuses other paths and never follows an ingestion redirect.
4. Push the reviewed code/workflow to the project's own GitHub repository **only after approval**. Scheduled workflows run from the default branch. Check GitHub Actions availability and billing for the repository before enabling it; private-repository usage may consume included minutes or incur charges. No paid service is assumed.
5. Run the `collect notices` workflow manually once through `workflow_dispatch`, then inspect its six source counts and Worker `/status`/D1 outcomes. An HTTP 202 confirms durable acceptance, not completion of downstream processing or Discord delivery.
6. Confirm successful collection of all six IDs. Use `/notices source:university`, `/notices source:graduateNotice`, etc. The new boards should not broadcast their pre-existing posts on baseline.

The scheduled workflow runs at **00:10, 06:10, 12:10 and 18:10 UTC** (09:10, 15:10, 21:10 and 03:10 KST). GitHub schedules may be delayed, and inactive public repositories may have schedules disabled; monitor `/status` freshness rather than treating the cron expression as an SLA. Concurrency is serialized without canceling an in-progress collection; the job timeout is ten minutes. Each run fetches directly from official sources, without relying on an old repository's output.

For an explicitly approved local upload, securely load the endpoint and shared secret into the local process environment and run:

```sh
npm run notices:collect -- --send
```

Cloudflare's stored secret is not automatically available to this local Node process. Prefer the Actions secret mechanism. Unset local secret variables when finished.

## Authentication, bounded retries and idempotency

Each source is submitted separately as JSON:

```json
{"source":"university","notices":[{"id":"123","source":"university","title":"...","published":"2026-10-09","url":"https://www.sogang.ac.kr/ko/detail/123?bbsConfigFk=2"}]}
```

Headers:

- `content-type: application/json`
- `x-collector-timestamp`: 13-digit Unix milliseconds
- `x-collector-signature`: lowercase HMAC-SHA256 hex, using the UTF-8 shared secret over the **exact** bytes of `${timestamp}.${body}`

The Worker bounds body read time to ten seconds, checks timestamps against a five-minute window both before reading and immediately before acceptance, and validates the authenticated payload before storing it. Ingestion size is bounded to 256 KiB and 100 notices per snapshot. The collector retries transport ambiguity, HTTP 429 or HTTP 5xx up to **three total attempts**, reusing the identical body, timestamp and signature. Thus retries address the same durable idempotency key; they do not deliberately regenerate a signature to make duplicate work look new. Each HTTP attempt times out after twenty seconds. Default waits are one then two seconds; valid server Retry-After values up to thirty seconds are honored. A longer requested wait stops that source's upload instead of retrying too early or running beyond a bounded window.

Redirects, authentication errors, other 4xx, and unexpected non-202 success responses are terminal for that source. Response bodies and transport exception details are not logged. Source failure logs identify `collect` versus `upload` so operators can check credentials/deployment separately from official-site collection.

Accepted snapshots expire after thirty minutes rather than replaying old data indefinitely. Caught transient snapshot-processing failures use native per-message Queue retry delays (120 then 240 seconds, at most three D1 claims), so these retries do not need Worker Cron. Crash/lease recovery and delayed downstream delivery retries still rely on the existing recovery/dispatch machinery; external scheduling does not solve those separately. A durable snapshot ID and existing source/notice keys prevent duplicate storage or notifications after an ambiguous accepted response. This does not guarantee exact-once Discord delivery; existing uncertain-send handling remains authoritative.

## Verification limits

Fixture tests cover fingerprint/signature/expiry, endpoint validation, HMAC bytes, exact retry reuse, retry bounds, source isolation and no-upload default. A dry-run can verify real HTTPS source collection without changing Worker or Discord state. Neither test mode proves Actions scheduling, production ingress deployment/configuration, remote Queue completion or Discord delivery. No --send execution or deployment is performed merely by adding these files.

Local read-only validation on 2026-10-10 KST, Node 26.11.0, with the scoped verified CA: **50 university, 34 academicNotice, 32 graduateNotice, 32 externalInfo, 34 news, 33 career** notices collected successfully (215 total). Output contained counts only. No snapshot upload occurred. The Node 24 Actions runner remains unexecuted; its runtime is configured, not remotely verified.
