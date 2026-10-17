# Scheduled work and cadence

## Approved local changes — rollout pending

The2026-10-17 user request selected daily03:00 meal discovery, daytime15-minute /
nighttime-hourly schedule refresh, and an OCR start one hour earlier. After the
meal-report reconciliation tradeoff was explained, the user chose focused meal
refresh around breakfast/dinner plus hourly checks otherwise. These are local
changes only; production Worker remains `cce5431c-88ae-448a-8d64-904d57ef91c9` until
separately approved deployment. Actions schedules change on push. No schema or
dependency changes; no external mutation is authorized by this document.

All times below are KST; Cron expressions in configuration are UTC.

## Cloudflare

The two triggers stay `*/15 * * * *` (ordinary work) and `* 1-12 * * *`
(library minute work). Reduce planned work, not trigger frequency: quarter-hour
recovery and22:00 library closure must continue independently of board cadence.

| Work | Local selected cadence | Notes |
| --- | --- | --- |
| Meal metadata discovery |03:00 only |Daily `meal-discover:daily:<date>` identity. Duplicate ticks deduplicate. No missed-tick catch-up; existing legacy jobs remain valid. Actions independently discovers sources too. |
| Morning meal report |07:00 |Today's breakfast+dinner; unchanged15-minute creation window. |
| Evening meal report |17:30 |Today's dinner+tomorrow's breakfast; unchanged creation window. |
| Existing meal report reconciliation |Every15 minutes07:00–09:45 and17:30–19:45; otherwise hourly `:00` during active slots07:00–23:59 |Reads D1, not OCR. Unchanged display makes no Discord request. Changed content replaces tracked report and cleans up prior message. Never bootstraps missed reports. |
| Schedule initial creation permission |07:30 |Only permits creation if no tracked board; not a new daily message. Existing/uncertain tracking rules remain. |
| Existing schedule reconciliation |Every15 minutes10:00–21:45; otherwise hourly `:00` |22:00 is included by hourly branch. Reads reviewed stored data; changed content PATCH only. |
| Library source/status |Every minute10:00–21:59 |Unchanged. Direct PATCH; normal opening POST only on observed0→positive. |
| Library closure |22:00, retry on later outside-hours quarter-hour ticks |Unchanged; no nighttime source fetch/new POST. |
| Recovery / meal retention pruning |Every15 minutes |Unchanged; safety maintenance, not a per-tick Queue message. |

Direct notice collection remains disabled by `NOTICE_COLLECTION_MODE=external`.
Its legacy/non-external six-hour bucket planning is unchanged; do not change
`SOURCE_INTERVAL_HOURS` to implement meal discovery timing.

For one configured guild this reduces planned schedule refresh jobs96→60/day,
meal refresh jobs68→34/day, and discovery4→1/day: **73 fewer planned Queue
messages/day** (approximately219 basic write/read/delete operations), excluding
retries, duplicate suppression, user interactions, deliveries and cleanup. Meal
report creation and schedule creation jobs are separate and unchanged. These
are code-derived estimates, not measured billing savings.

## GitHub Actions

| Workflow | Local schedule | Behavior |
| --- | --- | --- |
| Recent notices |03:10/09:10/15:10/21:10 |Unchanged;24 official sources. |
| Archive backfill |03:40/09:40/15:40/21:40 |Unchanged. When enabled, also runs recent collection before bounded historical traversal. |
| Meal OCR |05:40/16:10 |Changed from06:40/17:10; UTC `40 20 * * *` / `10 7 * * *`. Scheduled ingestion remains enabled; manual default remains false. |

GitHub's scheduled event is not an exact start-time guarantee. The2026-10-17
morning OCR schedule actually started08:49:45 KST and ended08:51:31, despite its
former06:40 nominal time. Moving it earlier provides80 instead of20 minutes
before reports, but does not guarantee completion. Late OCR is why report
reconciliation must remain. Exact-minute Cloudflare delivery is not guaranteed
either; scheduled timestamps and creation/freshness guards still apply.

Notice ingestion starts downstream Queue work directly, rather than waiting for
the next quarter-hour Cron. Four daily crawls and fifteen-minute maintenance do
not need matching cadence.

## Read-only archive checkpoint (2026-10-17)

Production repository variables confirmed archive and backfill enabled. D1 held
2,685 originals across24 sources, database size approximately115.7 MB. Of11
initialized progress cursors,5 were done (`conveduNotice`, `graduateNotice`,
`sweduNews`, `sweduNotice`, `sweduPress`) and6 active (`academicNotice`,
`bdataNotice`, `career`, `externalInfo`, `news`, `university`). Thirteen sources
had no historical cursor; recent raw captures are not proof of full history.
Thus removing backfill as "finished" would be incorrect. This check did not
initialize cursors, replay history, modify flags or dispatch any workflows.

## Further optimization candidates — not implemented

- Data-change-triggered reconciliation plus sparse periodic recovery can reduce
  unchanged Queue work, but would alter the current no-delivery-jobs-on-OCR-ingest
  contract. Preserve no-bootstrap, current-slot guards and uncertain POST freezes.
- Pruning and execution recovery have different requirements. Recovery freezes
  unknown sends and clears expired interaction tokens: keep it quarter-hourly.
  Less frequent pruning needs explicit KST week-boundary/catch-up semantics;
  never conflate not serving expired data with physically removing old bodies.
- Backfill's extra recent crawl can be optimized only with fresh-notice protection
  intact; recent-before-history ordering is deliberate, not arbitrary duplication.
- Do not reduce library polling merely when seats are plentiful without accepting
  potentially missed full→available transitions. No such behavior change is made.
