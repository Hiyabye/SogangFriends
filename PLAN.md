# Library seat availability alerts

Status: released with explicit user approval on2026-10-16 KST.
Worker `f3250fd2-30da-4099-8c72-4be25d865383` from `96e5148`; migration0013, guild command registration, validated channel configuration and push completed. Automatic collection, silent baseline and one natural full→available alert through the ordinary outbox/Queue verified by D1 and Discord readback. One separate explicitly labelled no-mention channel test was also confirmed.

## Confirmed product decisions

- Monitor only **133 로욜라 인벤툼 II**, source `room_no=5` (102 seats observed). User confirmed that earlier “131” wording meant this source room.
- Check once per minute during **09:00 <= time < 21:00 KST** (up to 720 scheduled requests/day). No night polling or missed-window replay.
- Alert only on an observed **0 remaining → 1+** transition. Rearm after observing 0 again; positive-to-positive changes are silent. No additional cooldown was approved or added.
- Shared Discord channel, no mentions. Destination: **1560616038272475137** in guild1558118900347183374; ownership/type/effective View+Send permissions validated and D1 configuration read back. Not hard-coded.
- First successful observation each morning is a silent baseline, even when seats are available.
- After a prolonged gap, resume with a silent baseline rather than report an old opening.
- No command for seat lookup, dashboard, history/predictions, individual seat processing, subscriptions or AI/OCR in this release.

## Approved engineering contract

User explicitly approved local implementation/tests and then this minimal design:

- Add nullable `guilds.library_channel` and one latest-state row per configured server in additive migration `0013_library.sql`. No historical occupancy table or new dependency.
- Extend existing `/setup` with `library`, preserving Manage Guild, server allowlisting, private responses, channel ownership/type/effective permissions validation and fixed SQL identifier mapping.
- Add a daytime minute Cron without accelerating existing quarter-hour jobs.
- Reuse existing durable delivery outbox and its conservative uncertain/interrupted POST handling.
- Prolonged gap = **at least 3 minutes** since the previous valid observation or upstream timestamp. Initial/new-channel/day-change observations are silent too.
- Source timestamps must be no older than **2 minutes**; future tolerance is 30 seconds.
- Alert expires within **2 minutes of its source observation**, capped at **21:00 KST**. Check current destination, source/retrieval freshness, day, positive availability and event identity before sending. Expired/superseded alerts are not replayed.

## Evidence and limitations

Source: https://libseat.sogang.ac.kr:444/SEAT/domian5.asp

Bounded public requests on 2026-10-16 established server-rendered HTML with room IDs, aggregate counts, occupancy, source timestamp and disability-seat capacity in parentheses. CP949 bytes decode via `TextDecoder('euc-kr',{fatal:true})`. Normal TLS-verified curl and native Node fetch worked; Python urllib encountered a TLS connection reset. The production parser/fetcher also successfully parsed one live Node response (102 total, 102 used, 0 remaining). This is not a live Worker test.

The page requests a browser refresh every 60 seconds; actual backend cadence is unverified. The expected-release table has ambiguous bucket semantics and the inspected detail page exposes seat overlays; neither is used.

Remaining counts are allocation-system information, not reservations or proof of physical emptiness. Disability seats can be included; do not subtract all disability capacity to invent unrestricted availability. Brief openings between checks may be missed. Public accessibility does not establish permission for automated collection. Read-only official-site policy searches found no applicable explicit collection policy; a bounded robots.txt request returned404. This is unresolved guidance, not affirmative permission. User explicitly authorized activation at the bounded cadence; respect any subsequently identified source restriction.

Current repository instructions/read-only history show Engineering already deployed with migration0012. Earlier discovery notes about local-only Engineering were stale; preserve the actual current deployment boundary in AGENTS.md. Migration0013 is now deployed with separate user approval.

## Implemented boundaries

- `src/library-source.ts`: fixed HTTPS origin/port, verified platform TLS, no redirects, 8-second total deadline, 256 KiB streaming limit, fatal legacy decoding and strict target-table/timestamp/count validation. Sanitized errors only.
- `src/library.ts`: one shared fetch per scheduled tick, latest per-guild state, bounded CAS retry for competing snapshots, atomic state+outbox commit, event-specific send guards and generic library health.
- `wrangler.toml` / `src/worker.ts`: additional `* 0-11 * * *` UTC Cron routed separately from existing `*/15 * * * *`. Source fetch is bounded in the scheduled handler, avoiding 720 durable poll jobs/day and avoiding network polling in the single-concurrency Queue. Only opening events enter the existing outbox.
- `src/discord.ts`, `src/worker.ts`, `src/status.ts`: setup definition/validation and channel/health visibility. New channel settings silently establish a baseline at the next poll.
- `src/jobs.ts`: library eligibility check before ordinary durable delivery. Unknown POST remains uncertain, never blindly retried.
- `tests/library-source.test.ts`, `tests/library.test.ts` and existing command-definition assertion: parser/fetch, real SQLite, concurrency, rollback, transitions, routing, setup, health, expired/unknown sends and mention safety.

## Verification and rollout

Verification completed:

- `npm run check`: TypeScript passed; all539 Vitest tests across30 files passed; all14 standalone Node OCR-client tests passed.
- `WRANGLER_SEND_METRICS=false npx --no-install wrangler deploy --dry-run`: bundle succeeded, no deployment.
- Native Node command-definition import: five commands, with `library` present in `/setup`; no registration/API call.
- `git diff --check`: passed.
- One bounded live source fetch through the production Node parser succeeded; no Discord call or recurring polling.

First full check exposed the existing exact-command-list assertion needing `library`; updated it. Independent review found CAS losers could discard a newer opposite-state observation; added bounded re-read/retry and regression cases for both newer-full and newer-available outcomes. Final full checks above passed after those fixes. Python/model tests and npm audit were not rerun: no Python, model or dependency changes were made.

User subsequently explicitly authorized push, remote migration, deployment, command registration, channel configuration and Discord messages:

1. Remote inspection found only0013 pending; applied it before deployment. Readback:0001–0013 applied, none pending.
2. Deployed Worker `f3250fd2-30da-4099-8c72-4be25d865383` at11:50:56 UTC/20:50:56 KST from `96e5148`, with old quarter-hour Cron and additional daytime minute Cron. No secrets changed.
3. Replaced the existing five guild command definitions, preserving names and empty global scope; readback confirmed `/setup library`.
4. Reused `validateChannel` to verify ownership/type/effective permissions, then conditionally updated only the allowed guild's library channel and updated timestamp. All existing notice/meal/schedule channels and NULL fallback remained unchanged. Pushed main.
5. Isolated remote Worker preview successfully fetched and parsed the official source with normal TLS, custom port and legacy decoding. Preview had no D1/Queue bindings and added no public production endpoint.
6. Automatic production minute Cron succeeded at11:56:42 UTC/20:56:42 KST. D1 baseline retained1 remaining seat, `event_id=NULL`; no fake full→available transition or replay was injected. The source timestamp was about24 seconds ahead of retrieval, within the existing30-second tolerance.
7. Explicitly labelled channel test message1560622269976281101 was confirmed by API readback with exact text, zero user/role mentions and `mention_everyone=false`. It stated that it was not evidence of current availability. This is direct channel delivery evidence, not a natural transition alert through the outbox.
8. A real0→1 opening on the20:59 KST automatic check generated one durable delivery; Queue send completed and Discord readback confirmed alert1560623283311747093 at20:59:45.720,1/102 seats, official link and no mentions. No source state was fabricated. The ordinary21:00 quarter-hour Cron also succeeded; library's last check remained20:59.
9. Push CI38896533093 succeeded. See [verification history](docs/VERIFICATION.md) for final scheduler readback and limitations.

Next-morning resumption and Discord client visual rendering remain unverified. Source collection guidance remains unresolved as described above. This scoped rollout is not permission for unrelated future migrations, deployments, workflows, secrets or messages. No general job-history deletion or source polling outside the chosen window is approved.
