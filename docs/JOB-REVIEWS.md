# Operator job review — 2026-10-11

## Meaning and approval boundary

`job_reviews` adds review annotations without rewriting `jobs.state`, attempts, errors, source baselines, rejected extraction provenance, or any `llm_usage` reservation. `closed` means the historical attempt was reviewed and will not be resumed; **it does not mean the operation succeeded or a provider problem was fixed**. `deferred` means manual investigation is still required. Matching execution state and attempt count are required for the annotation to apply in `/status`.

The following is a **proposal based on a read-only production query**, not an applied production change. Migration 0007, review inserts, deployment, and any fresh inference each require their appropriate approval. Review inserts must be guarded against the inspected state and attempt count. Never reset attempts or make an uncertain inference retryable to clear a dashboard.

## Shared failures and needs_review (12 rows)

| Job identity | Inspected state / attempts | Proposed review | Evidence / action |
| --- | --- | --- | --- |
| `collect:university:82942` | failed / 3 | closed | Old unsupported redirect option; manual redirects implemented, current external university snapshots successful. |
| `collect:academicNotice:82942` | failed / 3 | closed | Same old redirect failure; current snapshots successful. |
| `collect:externalInfo:82942` | failed / 3 | closed | Same old redirect failure; current snapshots successful. |
| `collect:career:82942` | failed / 3 | closed | Same old redirect failure; current snapshots successful. |
| `meal-discover:82942` | failed / 3 | closed | Same old redirect failure; current source discovery successful. |
| `repair:redirect:collect:university:82942` | failed / 3 | closed | Legacy Worker HTTP526; replaced by independently verified Node TLS collection. External mode deliberately skips old direct collector jobs. |
| extraction `meal-v2-free` | failed / 3 | closed | Historical Gemma429 attempt; reservation already confirmed_rejected. Keep original failure. No replay. |
| extraction `meal-v3-gemma26-free` | failed / 3 | closed | Historical Gemma429 attempt; reservation already confirmed_rejected. Keep original failure. No replay. |
| extraction `meal-v4-retry-free` | needs_review / 10 | closed | Approved5+5 exhausted on429. Historical attempt ended; provider issue is not claimed resolved. Reservation retained. No third model or replay. |
| extraction `meal-v4-dots-verification-free` | needs_review / 1 | closed | One-off test produced invalid complete output; test ended. Reservation retained; no serving output to restore. |
| extraction `meal-v5-dots-nvidia-verification-free` | needs_review / 9 | deferred | Last NVIDIA inference outcome uncertain. Reservation retained. Never automatically repeat. |
| extraction `meal-v6-no-reasoning-verification-free` | needs_review / 2 | closed | Known invented offerings; operator-approved quarantine preserved. Menu spelling tolerance does not authorize restoring it. Reservation and audit retained. |

The six extraction IDs have the exact form:

```text
extract:05c38bb91374f5d910ac108daee6f94bd7564424761f55a19f06f9ca2ca0104c:<version>:2026-10-05:2026-10-11:https://scc.sogang.ac.kr/front/cmsboardview.do?bbsConfigFK=1185&siteId=dormitory&pkid=941444
```

Use these exact IDs, never a wildcard update over all failed or needs_review jobs. After inserting reviews, verify all12 guarded targets were matched,11 closed/1 deferred, original12 execution states/attempts/errors unchanged, and the complete usage ledger unchanged. If any target changed since inspection, investigate rather than forcing its review.

## Expired interactions

The read-only query also found23 old `interaction expired` needs_review rows (not included in the shared count). Some may have been mislabeled by an older recovery implementation; original success cannot be reconstructed from empty payloads. Terminal-secret cleanup already preserves states and errors now. These expired webhook tokens cannot be replayed. Keep this history unchanged, do not claim success or guess the original guild. `/status` excludes unidentifiable old command records from guild-specific error counts.

## Remaining limitations

- Resolving dashboard history does not create a valid meal cache, prove real OCR quality, or resolve OpenRouter provider throttling.
- Fresh free-model attempts remain an explicit operator choice for exhausted/uncertain past jobs, with normal limits and preserved reservations.
- Small menu spelling differences already pass validation. Dates/weekdays, schema and offering evidence still must pass. Unreadable offerings remain unknown.
- No automatic factual comparison or manual edit UI was added.
- First uncertain schedule-summary POST also requires manual message-ID reconciliation; annotation of jobs cannot substitute for that.
