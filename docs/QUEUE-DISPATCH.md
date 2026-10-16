# Queue dispatch and board planning

## Local change — not deployed

Migration `0017_job_dispatch_lease.sql` adds nullable `jobs.dispatch_until`.
Production remains on migrations0001–0016 until a separately approved rollout.
Apply0017 **before** deploying the new Worker: dispatch, execution claims and
retry updates require the column. Existing explicit-column inserts and the old
Worker remain compatible with the additive column. No baselines, job history,
destinations or Discord messages need resetting or replaying.

Local fixture tests apply all migrations to real SQLite. Bundle dry-run is not
remote D1/Queue verification. Actual quota savings require post-rollout analytics.

## Dispatch reservation versus execution lease

D1 is the durable outbox; Queues carry job IDs only. All application Queue sends
use `dispatchJob()` in `src/storage.ts`:

1. Conditionally reserve a due `pending`/`retry` job with one SQL update.
2. Set `dispatch_until` to now + Queue delay + **two minutes**.
3. Send its ID only if the reservation succeeded.

The global dispatcher excludes unexpired reservations before its40-job scan and
checks eligibility again in the conditional update. Competing Cron, library,
consumer and direct-ingress dispatches cannot normally send the same reserved
job. A completed, running or not-yet-due job is not dispatched.

A reservation is not proof of Queue acceptance. Keep it after a failed or unknown
send, or a crash between reservation and send. The durable job becomes eligible
after expiry; recovery occurs on the **next dispatcher invocation**, not at an
automatic two-minute timer. Successful minute library polls can dispatch while
active; otherwise ordinary quarter-hour Cron remains the recovery path.
Short-lived intents or bootstrap opportunities can expire before recovery.

An execution claim ignores the dispatch reservation, checks the existing state,
due time and claim limit, enters `running`, and clears `dispatch_until` atomically.
The existing20-minute execution lease and interrupted-send quarantine are separate
and unchanged. Never enter `running` merely because Queue send was attempted.

Native snapshot retries persist `available_at` at the actual bounded Queue retry
delay and reserve dispatch until that time + two minutes **before** calling
`msg.retry()`. The existing message may execute when due; Cron does not send a
competing message immediately. A lost native retry can recover after the grace
period. D1-only retries clear the dispatch reservation and wait for their due time.

This is bounded duplicate suppression, not exactly-once Queue delivery. A message
waiting longer than its reservation, or a sender paused beyond lease expiry, can
still create duplicates. Conditional execution claims remain essential. Unknown
Discord POSTs remain uncertain and are never automatically replayed.

## Ingress and deferred interactions

Identical signed snapshot replays reuse the durable job and do not bypass an
active reservation. A replay can return202 even if the original Queue send failed:
202 means durable acceptance, not a successful Queue write, completed processing,
raw archival or Discord delivery. The lease/recovery path preserves unsent work.

Interaction enqueue persists `available_at` two seconds after creation, before
any dispatcher can see the row. Direct dispatch retains its two-second Queue
delay and reserves through that delay plus the grace period; global dispatch
cannot send it before its D1 due time. Even an early duplicate cannot claim the
job before that time. This is a minimum from enqueue, not proof that Discord
received the HTTP acknowledgement. If the direct producer stops before sending,
the normal dispatcher can recover the job once due.

## Direct board planning

Cron creates per-guild `schedule-summary` and `meal-board` jobs directly instead
of sending new `schedule-refresh`, `schedule-daily`, `meal-refresh` or `meal-report`
fan-out jobs through Queues. Legacy wrapper handlers remain readable and reuse
exactly the same child IDs, so old and new planning deduplicate.

The15-minute refresh cadence,07:30 default schedule creation opportunity, and
07:00/17:30 meal creation opportunities are unchanged. Refresh jobs cannot
bootstrap meals; consumer date/slot/window and destination guards remain intact.
Daily/report children remain separate from overlapping refresh children.

For one configured guild this removes167 wrapper messages/day, normally about
501 Queue write/read/delete operations. Duplicate-dispatch savings are additional
and workload-dependent. Neither figure proves production usage after deployment.
