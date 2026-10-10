# Official academic schedule: evidence and approval

`data/schedule.json` contains 27 real entries for September 2026–February 2027, not fictional example data. All begin with `active: false`: source verification on 2026-10-09 is not the operator's human approval for delivery.

## Official evidence

Primary source: https://www.sogang.ac.kr/ko/academic-support/calendar

The school headquarters page identifies `2026학년도 학사 일정`, 담당부서 학사지원팀, and publishes March 2026–February 2027 in rendered HTML. Research fetched it successfully with TLS verification and a public intermediate CA supplement; the server omitted its issuer certificate. This does **not** establish a deployed Workers failure. Calendar collection is not an automated runtime dependency in this MVP.

Independent comparison: https://me.sogang.ac.kr/ko/undergraduate/calendar . This departmental replica agrees with most dates but disagrees in February: it lists entrance on February 19 and freshman registration on February 20; headquarters lists **February 18 and February 19**, respectively. This project follows headquarters.

Decisive headquarters excerpts:

```text
10. 20(화)~26(월) 중간시험
11. 1(일)~30(월) 2027학년도 1학기 장학금 신청
11. 3(화) 중간성적 제출 마감
11. 4(수)~17(화) 전공 추가신청 및 변경
11. 20(금) 휴학원서 제출 마감
11. 20(금) 스터디 데이_수시(휴강일)
12. 15(화)~21(월) 학기말시험
12. 29(화) 학기말성적 제출 마감
12. 30(수)~1. 2(토) 학기말성적 확인
1. 20(수)~2. 3(수) 2027학년도 1학기 휴⋅복학 신청
2. 18(목) 제64회 학위수여식(오전 10시), 입학식, 입학축복예식(오후 3시)
2. 19(금) 신입생 수강신청
```

Desktop and mobile HTML duplicate events; the seed includes each event once. Stable semantic IDs do not include mutable event dates. Published dates can change: periodically review the official page and update the same IDs and `lastReviewed`.

## Semantics

- `event`: a single calendar event, not an application deadline.
- `period`: start/end dates; may additionally have a documented application `deadlineDate`.
- `deadline`: explicit source deadline. Date-only source values remain date-only; no invented 23:59 or inferred clock time.
- `deadlineAt` is optional for future sources that explicitly give a timezone-aware clock time. Never add it merely because a date is present.
- Scholarship/major-change/leave-return application period ends are treated as date-only application ends. Notes make this interpretation explicit.
- Faculty grade-submission entries remain visible but are excluded from reminders: their note carries the explicit `교직원 대상` designation. Keep that designation when editing these entries.
- Exam periods, semester openings, course-cart and registration events produce **start-date** reminders, not invented deadline reminders. Application periods with documented deadlines have separate start and deadline reminders; same-date targets are combined. Both use D-7, D-1 and D-day. Existing deadline delivery keys are preserved; start delivery keys have a separate identity.
- User selected start-date plus deadline reminders on 2026-10-10. These reminders use reviewed calendar data only; no LLM calls or automatic calendar scraping occur.
- `/schedule` window includes today and ongoing periods, excludes the day at today+30. D-7, D-1 and D-day use KST calendar dates; they do not claim a precise cutoff hour.

## Import and activation

1. Review `data/schedule.json` against the official headquarters page, including student/faculty audience and application-period deadline interpretations.
2. `npm run schedule:import` generates `data/schedule.sql` locally with notifications disabled. It executes no database or remote command.
3. Only after human approval, `npm run schedule:import -- --approve` generates approved rows; faculty-grade reminders remain inactive.
4. Apply the resulting SQL to the project's own D1 via the deployment README. Generation is an explicit step, not a CI deployment action.
5. Updating the same ID uses UPSERT. Imports intentionally **do not delete missing IDs**: mark obsolete entries inactive rather than assuming removal cancels data already in D1.

Optional `--input=PATH` and `--output=PATH` support reviewed replacement files. The importer evaluates only the project's own trusted TypeScript validators via the already-installed TypeScript compiler; schedule JSON is data and never executable code.

The importer overrides `active` based on its explicit approval flag; an `active:true` JSON edit alone cannot silently activate an ordinary import. Runtime reminders additionally require `active === true`. Delivery idempotency and handling edits after an already-sent reminder belong to the durable outbox, not these date-selection helpers.

## Verification boundary

Fixture/unit tests verify dates, selection and validation, not whether school data will remain unchanged. Research performed read-only official requests with TLS verification; no Discord send, paid LLM call, D1 resource creation or deployment was performed. No old project feed or deployment is needed to query/import this data.
