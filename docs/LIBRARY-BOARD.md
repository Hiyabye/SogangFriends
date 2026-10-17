# Library live status board

## Deployed implementation

The approved feature adds silent live-status editing to the existing opening
alerts. Migration `0018_library_live_board.sql` adds `library_board_state` for
shared writer ownership, POST uncertainty, cooldown and confirmed display keys.
It does not change confirmed `library_messages`, watch baselines or delivery/job
history. With fresh explicit approval, migration0018 was applied before deploying
Worker `def0ee15-1925-4be8-b403-9c0344c28f3f` from `70765fb` and pushing main on
2026-10-17 around00:49 UTC (09:49 KST). Production has migrations0001–0018.
Future external actions still need approval. Live minute editing, bootstrap,
opening replacement and operating boundaries await natural scheduled verification.

## User-visible behavior

- One shared official detail-page fetch each minute,10:00–21:59 KST. Keep the
  existing96-seat policy and all source/TLS/arithmetic/freshness checks.
- An observed0→positive transition creates a normal new message. Confirm its
  tracking, sent delivery and prior-message cleanup intent atomically; only then
  may cleanup delete the previous tracked message. Delivery eligibility still
  requires the original intent deadline, current event, fresh data and open hours.
- Other valid observations PATCH the tracked message's neutral status title,
  remaining count and official source timestamp. A newer timestamp updates even
  when the count is unchanged. PATCH never sends a new alert or adds history rows.
- If no tracked message exists, create one initial status message using Discord
  `SUPPRESS_NOTIFICATIONS`4096. It suppresses push/desktop notifications, but can
  still show an unread badge. All messages disable mentions. An eligible pending
  opening takes precedence over initial creation.
- First observations, next-day observations and gaps>=3 minutes remain silent
  baselines, not opening events. They can update/create the status message.
- At22:00, existing quarter-hour Cron PATCHes the known message to closed status,
  retaining the **last known** count and original source time. State explicitly:
  `운영 시간: 매일 10:00–22:00 KST` and
  `22:00–다음 날 10:00에는 좌석 현황을 갱신하지 않습니다.`
  No nighttime source request or new message is made. Failed/missed closure can
  reconcile on later quarter-hour ticks; a successful closure is silent overnight,
  including across midnight. Cloudflare Cron timing is not an exact-time SLA.
- The next10:00 valid baseline updates the message back to open status without
  treating overnight changes as an observed opening.

The displayed number is the most recent successful minute observation, not a
reservation or a guarantee of availability on arrival. Collection failure never
changes the last-good count or makes an old timestamp appear fresh.

## Coordination and failure rules

All status PATCH/bootstrap and opening POST writers share a two-minute per-route
D1 lease. Read configuration, latest watch and operating phase after acquisition;
check ownership/deadlines before HTTP. HTTP timeout remains15 seconds. Success
tracking is fenced to the writer, and opening completion/cleanup intent stays
atomic. A paused process beyond lease expiry cannot be perfectly fenced by
Discord; this is bounded arbitration, not a distributed transaction guarantee.

Known-message PATCH is safely retryable. Store429 cooldown and reconcile the
latest projection on a later tick; do not replay historic PATCH jobs. Permission
or generic rejection gets a15-minute cooldown. PATCH replaces embed/attachment
sets and does not try to modify notification flags.

Only exact numeric Discord10008 proves the tracked message is gone and permits
guarded removal of that ID and silent recreation during daytime. Other404/403
responses do not authorize a new POST. Existing channel history is never adopted.

Unknown POST, interrupted POST ownership, or confirmed POST followed by failed
tracking freezes **further creation on that route**. Never clear uncertainty just
because a lease expired or a new opening occurred. Known prior messages can still
be edited; manual reconciliation must identify any untracked real message before
unblocking creation. Preserve original deliveries and do not blindly resend or
delete prior messages. Bootstrap has durable delivery proof but no Queue job.

Minute updates add no Queue messages, per-minute jobs or per-minute delivery rows.
For one guild they can add up to approximately720 Discord PATCH requests/day,
plus closure/bootstrap/opening/cleanup requests and D1 coordination writes.
Opening alerts still use the durable Queue path; its quota exhaustion can delay
or expire opening alerts even while direct status PATCH continues to work.

## Diagnostics and verification

- `health.library` records source collection/persistence, not Discord display.
- `health.library-board` records reconciliation attempts. Its success can include
  a no-op because of a lock/cooldown/quarantine, not a confirmed display update.
- `/status` includes this guild's current-route board state. `display_key` is the
  last confirmed projection; `post_state='uncertain'` blocks creation, and
  `retry_at` controls the shared writer cooldown. Do not infer freshness solely
  from aggregate health timestamps. Error text may be cleared by a later known
  PATCH; uncertainty remains in `post_state` and original delivery history.
- Last-good source timestamps and display keys must not advance on failed HTTP.
- Ordinary Cron closes the board **before** Queue planning/dispatch. A library
  display failure is isolated from meal/schedule planning; exhausted Queue quota
  cannot prevent an earlier direct closure or minute PATCH.

Tests use real SQLite migrations and mocked Discord/source requests. They cover
bootstrap4096 payloads, silent PATCH, opening replacement/cleanup compatibility,
shared writers, expired intent preflight, storage failure/uncertainty, exact10008,
429 cooldown,22:00/10:00 crossings, overnight idempotency and Queue independence.
No native source fetch, remote migration, deployment, command registration,
Discord message, client rendering or live boundary is verified by these tests.
See [Queue rollout quota blocker](QUEUE-DISPATCH.md) and [verification history](VERIFICATION.md).
