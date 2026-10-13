# Sogang Friends Bot — independent MVP

서강대학교 친구 서버용 Discord HTTP 봇. **이 프로젝트만** 운영하며 기존 discord-bot/sogang-notices/SogangLife의 피드·Actions·KV·Worker·소스에 런타임 의존하지 않습니다. 코드와 fixture는 새로 작성했습니다. 참고 검토/라이선스 경계: [docs/REFERENCES.md](docs/REFERENCES.md).

## 구현 범위

- 공식 6개 게시판(학교 학사공지, 소프트웨어융합대학 학사·대학원·대외정보·소식·취업) 수집. 독립 Node 수집기 + 이 프로젝트의 GitHub Actions가 HTTPS 목록을 읽고, 인증된 snapshot을 Worker에 전달. 안정 ID 저장, 최초 baseline, 새 공지 묶음 발송, 제목/링크 갱신. [공지 수집 설정](docs/NOTICE-COLLECTOR.md)
- 공식 벨라르미노 게시물/이미지 발견, SHA-256 캐시, Actions CPU PaddleOCR/EasyOCR + JSON 결과 접수, 관측 날짜/요일/기간/운영 근거 검증. 만료 식단을 오늘 식단으로 대체하지 않음.
- 공식 학사 일정 27개 초기 자료(2026-09–2027-02), `/schedule` 30일 조회. 승인된 앞으로의 일정은 D-day 게시물 하나를 매일 편집해 표시. 사용자 검토·승인 전 자동 게시 비활성. 날짜만 있는 마감에 시각을 만들지 않음.
- `/meal [date]`, `/notices [source]`, `/schedule`, `/setup`, `/status`. 조회는 저장 데이터만 사용하며 HTTP 명령에서 직접 LLM을 호출하지 않음. 모든 명령을 먼저 defer, Queue가 원래 응답을 편집.
- guild별 채널 설정, Manage Guild 관리 권한, 비공개 관리 응답, 서버 allowlist, 채널 소속/최종 권한 검증, raw Ed25519 서명 검증, 멘션 차단.
- D1 작업/발송 outbox, 조건부 claim, 제한 재시도, 불명확한 Discord POST 결과는 `uncertain`, 자동 재발송 금지.

제외: 공지 AI 요약, 날씨, 개인 일정/추천/역할 구독, 기타 사이트, 대화 자동 응답, 음성, 웹 UI, 범용 플러그인.

## 구조

```text
src/worker.ts    HTTP 검증·defer·명령·ephemeral 응답
src/jobs.ts      Cron 계획 / Queue 소비 / 수집·추출·발송 분리
src/storage.ts   D1 원자 claim·baseline·outbox·예산
src/sources.ts   Node/Worker 공통 공식 목록 parser·식단 발견 (parse5)
src/notice-ingest.ts 공지 snapshot HMAC 검증·입력 제한·Queue 접수
src/notice-archive.ts D1 원문 저장 / archive 인덱스·checkpoint
src/notice-archive-sources.ts 상세 본문·첨부 링크 / 과거 페이지 검증
src/meals.ts     OCR 식단 의미 검증 / 표시
src/time.ts     Asia/Seoul 날짜와 날짜-only 계산
src/schedule.ts 사람이 검토하는 일정 계약 / 마감 선택
migrations/     D1 스키마
data/           일정 JSON과 생성 SQL
scripts/        명령 등록, 일정 SQL 생성, 독립 Node 공지 수집
certificates/   서명·지문 검증된 공개 중간 인증서 (Node 수집기 전용)
```

공지 전용 Node 프로세스와 하나의 Worker에 fetch/scheduled/queue handler. Node는 Discord/OpenRouter/Cloudflare 계정 API 토큰 없이 전용 ingestion key만 사용합니다. Queue에는 작업 ID만 넣으며 이미지/토큰을 전달하지 않습니다. D1이 작업 상태 원본이고 Cron이 미발행/누락 pending job을 다시 Queue에 넣습니다. Queue 중복은 D1 claim으로 차단됩니다.

## 1. 로컬 개발 (비밀값 불필요)

Node **24 이상**, npm만 사용합니다. 테스트의 `node:sqlite`는 실제 SQLite SQL을 실행합니다.

```sh
npm ci
npm run check
npm audit
WRANGLER_SEND_METRICS=false npx wrangler deploy --dry-run --outdir /tmp/sogang-build
npx wrangler d1 migrations apply sogang-friends --local
npm run schedule:import
npx wrangler d1 execute sogang-friends --local --file=data/schedule.sql
npm run dev -- --test-scheduled
```

`wrangler.toml`에는 승인된 운영 리소스/public ID가 들어 있습니다. 새 환경에서는 자신의 ID로 바꾸세요. `.env.example`을 참고해 필요시 `.dev.vars`에 로컬 secrets를 작성합니다. 식단 OpenRouter 설정과 호출 경로는 제거했습니다. OCR은 별도 수동 Actions workflow에서 실행하며 운영 접수에는 전용 secret이 필요합니다. Discord는 `/interactions`, 외부 공지 수집기는 HMAC 인증이 필요한 `/internal/notices`를 사용합니다. 외부 수집 모드는 `NOTICE_COLLECTION_MODE=external`; 전용 `NOTICE_INGEST_SECRET` 설정 전 접수는 503입니다. 활성 endpoint에 서명 없는 POST는 401이 정상입니다. 로컬 Cron 테스트 `/__scheduled`는 dev 전용이며 **실제 원본 수집을 수행할 수 있으므로** fixture 테스트와 구분하세요. 기본 `npm test`는 외부 요청을 하지 않습니다.

## 2. 사용자가 준비할 Discord 설정

아래 과정과 배포/게시/유료 호출은 구현 검토 후 사용자가 실행합니다. **토큰을 대화나 Git에 넣지 마세요.**

1. https://discord.com/developers/applications → New Application.
2. General Information: Application ID와 Public Key → `wrangler.toml`의 해당 vars.
3. Bot: 토큰 생성 → 이후 `npx wrangler secret put DISCORD_TOKEN`에 직접 입력.
4. Installation: Guild Install, scopes `bot`, `applications.commands`; permissions **View Channels, Send Messages**. Administrator나 Gateway privileged intents 불필요.
5. Discord 개발자 모드 활성화 → 테스트 서버 ID 복사 → `ALLOWED_GUILDS` (쉼표로 추가 가능; 비어 있으면 모든 서버 거부).
6. 공지/식단/일정 채널 직접 생성. 제한 채널은 봇에 View/Send 허용. 봇 초대.
7. 배포 뒤 General Information의 Interactions Endpoint URL을 `https://<worker>.workers.dev/interactions`로 지정. Discord PING 검증은 키만으로 동작.
8. 환경변수에 새 app ID/토큰을 넣고 **명시적으로** 등록:

```sh
# 로컬 shell에서 secret을 안전하게 입력하세요. 아래 변수에 실제 토큰을 문서로 쓰지 마세요.
export DISCORD_APPLICATION_ID=YOUR_NEW_APP_ID
read -s DISCORD_TOKEN; export DISCORD_TOKEN
npm run register -- --guild YOUR_TEST_GUILD_ID
# 전체 global 명령 교체가 의도된 경우만: npm run register -- --global
unset DISCORD_TOKEN
```

등록 PUT은 해당 scope의 **전체 명령 목록을 교체**합니다. 자동 등록/자동 배포 CI는 없습니다. 네트워크 실패 시 결과를 확인한 뒤 재실행하세요.

관리자가 Discord에서 `/setup notices:#공지 meals:#식단 schedule:#학사일정` 실행. 옵션 일부만 지정하면 기존 다른 채널을 유지합니다. `/status`는 해당 서버 설정/발송과 공유 수집·작업·예산 상태를 비공개로 표시합니다. 조회 source 값은 `university`, `academicNotice`, `graduateNotice`, `externalInfo`, `news`, `career`.

## 3. Cloudflare 준비와 배포

**아래는 리소스를 생성하거나 원격 상태를 변경합니다. 사용자 승인 후에만 실행하세요.**

```sh
npx wrangler login
npx wrangler d1 create sogang-friends
# 출력된 새 database_id를 wrangler.toml에 입력 (기존 리소스 ID 재사용 금지)
npx wrangler queues create sogang-jobs
npx wrangler queues create sogang-jobs-dlq
npx wrangler d1 migrations apply sogang-friends --remote
npm run schedule:import
npx wrangler d1 execute sogang-friends --remote --file=data/schedule.sql
npx wrangler secret put DISCORD_TOKEN
# OCR 운영 접수 승인 후만 (Actions와 동일한 별도 secret):
npx wrangler secret put MEAL_OCR_INGEST_SECRET
npm run deploy
```

일정 SQL에는 명시적 `BEGIN TRANSACTION`/`COMMIT`을 넣지 마세요. 원격 D1 import가 자체 transaction을 제공하며 explicit BEGIN은 거부합니다. 로컬 Wrangler는 이를 제거해 처리하므로 로컬 성공만으로 원격 성공을 판단하지 마세요. 입력 뒤 `SELECT COUNT(*) AS total, SUM(active) AS approved FROM schedules`로 결과를 확인하세요(기본 seed: 27 / 0).

Wrangler account 선택 및 Queues 요금/retention은 현재 계정 정책을 확인하세요. consumer batch=1/concurrency=1, durable claim도 적용. DLQ는 별도 queue, 자동 POST 재발송 용도가 아닙니다. Worker가 자동 생성한 과거 봇 리소스에 연결되지 않았는지 배포 출력 확인.

Cron은 15분마다 실행. `/status`의 `식단·Cron`에서 `id=cron`의 `last_attempt`/`last_success`/`error`로 계획 단계 실행을 확인합니다. Cloudflare Cron 변경은 전파에 최대 15분이 걸릴 수 있습니다. Cron row가 없으면 handler가 DB에 실행 시작을 기록하지 않은 상태이며, 학교 사이트 오류와 구분해야 합니다. `NOTICE_COLLECTION_MODE=external`에서는 공지를 Node/Actions가 수집하고, 기존 직접 수집 작업도 실행하지 않습니다. `worker` 모드(이전 설정의 기본값)에서만 `SOURCE_INTERVAL_HOURS=6`의 bucket마다 게시판을 직접 수집하며, 학교 본부 인증서 체인 문제는 이 모드에서 해결되지 않습니다. 식단 발견은 두 모드 모두 같은 bucket으로 계획합니다. 재배포는 baseline을 초기화하지 않습니다. 첫 수집에서는 기존 공지를 저장하고 발송하지 않습니다. 다운타임은 공지 bounded window(최대 3페이지) 안에서만 복구하며 전체 이력을 보장하지 않습니다.

식단은 **채널별 게시물 하나를 편집**하는 방식입니다. 최초 생성은 **07:00 / 17:30 KST**의 현재 15분 window 안에서만 허용하고, 이후에는 15분마다 현재 표시할 내용을 비교해 변경된 경우만 같은 메시지에 PATCH합니다. 확정 거절된 생성은 현재 유효한 화면으로 안전하게 재시도할 수 있지만 불확실한 POST는 자동 재생성하지 않습니다. 07:00은 오늘 아침+오늘 저녁, 17:30은 오늘 저녁+내일 아침이며 날짜별로 표시합니다. 컵밥은 이 두 보고에 넣지 않고 `/meal`의 하루 전체 조회에 유지합니다. `MEAL_TIME_KST=07:30`은 학사일정 게시물의 최초 일일 생성 기회로 유지합니다. 기존 학사일정 게시물도 15분마다 표시 내용이 바뀐 경우에만 편집합니다. 놓친 일일 작업은 다음 날 몰아 보내지 않습니다. 이미 생성된 식단/마감 delivery도 해당 KST 날짜가 지나면 `expired`; 공지는 intent 생성 전후 모두 최대 24시간만 유효합니다.

## 식단 OCR 교체: 로컬 구현, 운영 전환 대기

사용자 승인으로 GitHub Actions CPU에서 **PaddleOCR 우선, EasyOCR fallback**을 실행하는 경로를 추가했습니다. Cloudflare Worker는 native PaddlePaddle/PyTorch를 실행하지 않고, 전용 `MEAL_OCR_INGEST_SECRET`으로 서명된 `/internal/meal-ocr` 요청을 검증해 기존 D1 주간 캐시에 저장합니다. 이미지 해시·`ocr-v1`·공식 게시물·기간이 모두 같으면 재추출을 생략합니다. Actions의 패키지/모델 캐시는 실행 비용을 줄이는 용도이며 D1 식단 캐시를 대체하지 않습니다.

고정 좌표 대신 이미지의 표 선으로 날짜별 칸을 찾습니다. 배너와 7개 열의 실제 날짜·요일이 공식 게시물 기간과 일치해야 저장합니다. 메뉴 오타는 허용하며 날짜를 추측해 보정하지 않습니다. 경계가 사라진 병합 셀은 해당 날짜들의 항목을 `unknown`으로 둡니다. 공식 게시물의 inline PNG도 크기·형식·픽셀 제한을 거쳐 처리하며 D1에는 이미지 바이트가 아닌 게시물 식별자만 보관합니다.

7개 공식 주간 이미지의 로컬 검사에서 6개를 받아들였고, 배너와 열 날짜가 다른 9월 14–20일 자료는 거절했습니다. 두 월간 전환 사례를 포함하며, 현재 10월 12–18일 자료는 PaddleOCR의 요일 판독 실패 후 EasyOCR로 통과했습니다. [검사 결과와 실행 방법](scripts/meal-ocr/README.md)을 확인하세요.

`.github/workflows/meal-ocr.yml`은 **06:40 / 17:10 KST 자동 refresh**와 수동 실행을 지원합니다(UTC `40 21 * * *`, `10 8 * * *`). 자동 refresh는 D1 접수를 활성화하고, 수동 기본 `ingest=false`는 OCR 검증만 하며 D1/Discord에 쓰지 않습니다. GitHub schedule은 지연되거나 누락될 수 있으므로 20분 여유가 성공을 보장하지는 않습니다([공식 문서](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule)). 두 native 엔진 실행 및 모델 weight 해시 검사와 최소 1개 실제 원본 처리에 성공해야 검증으로 인정합니다. 자동 refresh 또는 명시적 수동 `ingest=true`만 전용 secret/endpoint를 사용하며, 전체 batch가 성공한 뒤 검증된 결과를 접수합니다. Discord 발송 작업은 만들지 않습니다. 현재·다음 KST 주간 보관과 기존 이미지 fallback은 유지합니다.

**Ubuntu 24.04/Python 3.11 실제 Actions 검증에 성공했습니다.** [검증 run 38345856766](https://github.com/Hiyabye/SogangFriends/actions/runs/38345856766)은 두 native 엔진·모델 해시·실제 10월 12–18일 원본을 확인했으며 EasyOCR fallback으로 날짜 검증에 통과했습니다. `ingest=false`여서 원격 접수·Discord 발송은 수행하지 않았습니다. 이를 확인한 뒤 식단 OpenRouter 호출/설정과 비교 workflow를 로컬에서 제거했습니다. 이전 `meal-extract` 메시지는 호출 없이 `needs_review`로 보류하며 기존 payload/시도 수/오류/사용 예약을 보존합니다. 비교 endpoint는 410을 반환합니다. 이후 사용자가 retirement push, secret 설정, 배포와 live ingestion 및 위 refresh/report 시간을 승인했습니다. Worker 배포와 [live ingestion run 38352388180](https://github.com/Hiyabye/SogangFriends/actions/runs/38352388180)이 성공했고 D1에 10월 12–18일 `ocr-v1`/EasyOCR 결과를 저장했습니다. 과거 작업/사용 예약/Discord 발송 수는 그대로입니다. 실제 첫 정기 발송과 클라이언트 표시는 아직 관찰하지 않았습니다. 자세한 내용은 [검증 기록](docs/VERIFICATION.md)을 확인하세요.

## 4. 식단 캐시·과거 LLM 감사 이력

식단에는 OpenRouter 키가 필요하지 않습니다. HTTP 모델 호출, 모델 가격/예산 설정, 5+5 재시도와 비교 client/workflow는 제거했습니다. 과거 모델 실험은 [VERIFICATION.md](docs/VERIFICATION.md)에 기록으로 남아 있습니다.

D1의 과거 `llm_usage`와 작업 payload/상태/시도 수는 삭제하거나 초기화하지 않습니다. `/status`는 오늘 KST 날짜의 과거 LLM 예약을 조회할 뿐 현재 OCR 실행 예산을 나타내지 않습니다. 미제공 비용을 0으로 바꾸거나 불확실 예약을 해제하지 않습니다. 이전 pending/retry 추출 메시지는 시도 수를 증가시키지 않고 검토 상태로 보류하며, running lease와 완료/실패/불확실 결과는 재실행하지 않습니다. 더는 과거 설정이나 메시지로 OpenRouter를 호출할 수 없습니다. 원격 키/secret 삭제도 이 코드 변경에서 수행하지 않습니다.

식단은 장기 이력이 아니라 현재·다음 KST 월요일–일요일 주간 캐시로 관리합니다. `0005_meal_sources.sql`의 원문 이미지 URL/기간은 OCR 결과와 별도로 보관하며 Cron/발견 작업이 범위 밖 메뉴·이미지 메타데이터·거절 결과 본문을 정리합니다. 작업 ID, 감사 메타데이터와 불확실한 사용 예약은 삭제하지 않으며 공지 누적 보관은 그대로입니다. `/meal`은 사용할 텍스트가 없으면 요청 날짜와 일치하는 공식 주간 이미지를 내려받아 **이미지 파일로 직접 첨부**합니다(봇에 Attach Files 권한 필요). 외부 URL 미리보기에 의존하지 않습니다. PNG/JPEG 확인과 스트리밍 5MiB 제한을 적용하며 다운로드 실패 시 실패 안내와 출처 링크만 보냅니다. 맞는 이미지가 없거나 보관 범위 밖이면 링크만 안내합니다. 명령 실행이나 이미지 대체 발송으로 모델을 호출하지 않습니다. 07:00/17:30 보고도 선택한 식사 항목이 모두 unknown이면 날짜에 맞는 공식 이미지를 첨부합니다. 같은 주의 이미지는 한 번만 다운로드/첨부하며, 일요일 저녁에는 다음 월요일의 원본이 있으면 다음 주 이미지도 첨부합니다(합계5MiB 제한; 없거나 제한 초과 시 해당 날짜의 원문 링크). 아침 보고는 17:30 이후 보내지 않으며, 저녁 보고는 KST 자정 이후 보내지 않습니다. 이미지 다운로드 중 날짜가 지나면 발송하지 않습니다. 기존 실패·불확실 발송을 자동 재실행하지 않습니다.

JSON과 `certain`의 날짜·요일 의미는 유지합니다. 메뉴 오타는 허용하고 읽지 못한 셀은 `unknown`으로 표시합니다. 식단 텍스트에 OCR 오탈자 안내를 붙입니다. 날짜 불일치, 빈 셀 메뉴 생성과 요일 이동은 허용하지 않으며 이전 실패/불확실 작업을 재실행하지 않습니다.

현재 수동 수정/승인 UI와 arbitrary menu override는 제공하지 않습니다. 2026-10-11 reasoning을 끈 Dots 검증은 JSON 생성에는 성공했지만 원문 대조에서 메뉴 오독·빈 셀 내용 생성이 확인돼 사용하지 않았습니다. 운영자 전용 `meal-quarantine` Queue 작업은 해당 결과를 추출 작업 payload에 보존한 뒤 serving cache에서만 원자적으로 제거합니다. 자동 사실 검증 기능은 아니므로 JSON 통과만으로 메뉴 정확성을 보장하지 않습니다. 검토 데이터 자동 적용은 다음 버전에서 post URL/hash/기간에 묶인 형식으로 추가합니다.

## 5. 학사 일정 검토·초기화

`data/schedule.json`은 공식 본부 일정의 실제 데이터이며 예시가 아닙니다. 학교 자료를 확인한 날짜는 2026-10-09. 원본 seed는 모두 `active:false`: **사용자의 사람 검토를 대신하지 않습니다.** 운영 D1에서는 2026-10-10 사용자 승인으로 학생 대상 24개를 활성화했습니다. 일반 import는 비활성 SQL을 생성하므로 운영 일정을 유지하려면 명시적 승인 import를 사용하세요. 출처 비교와 불일치는 [docs/schedule-evidence.md](docs/schedule-evidence.md).

```sh
# 사용자: 공식 자료, 신청 기간의 마감 의미, 변경 사항 확인 후
npm run schedule:import -- --approve
# 먼저 local에 적용하여 조회 확인
npx wrangler d1 execute sogang-friends --local --file=data/schedule.sql
# 승인 후에만 remote 적용
npx wrangler d1 execute sogang-friends --remote --file=data/schedule.sql
```

일정 게시는 **LLM을 사용하지 않습니다.** 승인된 공식 날짜 데이터로 **채널별 게시물 하나를 편집**합니다. 최초 일일 생성 기회는 `MEAL_TIME_KST`(현재 07:30 KST), 기존 게시물의 변경 확인은 15분마다입니다. 같은 날의 수정도 표시 내용이 바뀌면 반영하며, 내용이 같으면 Discord 요청을 하지 않습니다. 식단과 일정은 Discord의 색상 embed 카드/fields로 표시합니다(Obsidian callout/Markdown table 문법을 보내는 방식이 아님; 모바일 field 배치는 클라이언트에 따름). 봇에 **Embed Links** 권한, 파일 대체 표시에는 **Attach Files** 권한이 필요합니다. 30일 이후를 포함한 앞으로의 승인된 학생 대상 일정 전체와 진행 중인 기간을 D-n/D-day/진행 중으로 표시합니다. 날짜 기준이며 기간 종료를 임의의 마감으로 만들지 않습니다. Embed의 25개 field/field 이름256자/값1,024자/총6,000자 제한을 넘으면 전체 일정 텍스트 파일을 첨부하며, 편집 시 첨부 목록과 embed 목록을 명시적으로 교체합니다. `/schedule` 명령의 30일 조회는 그대로입니다.

**편집형 식단/변경 감지/embed 카드는 사용자 승인 후 migration 0008 적용과 배포를 완료했습니다.** 기존 학사일정 메시지 ID/불확실 상태를 보존하고 식단 tracking만 별도 테이블에 만들었습니다. 기존 일정 게시물은 다음 변경 확인에서, 최초 식단 게시물은 다음 07:00/17:30 생성 기회에서 반영됩니다. 실제 embed 클라이언트 표시는 아직 관찰하지 않았습니다. 기존 migration **0006(schedule_messages)와 0007(job_reviews)**도 필요합니다. 2026-10-11 사용자 승인으로 두 migration과 Worker 배포를 완료했습니다. 실제 다음 일일 Discord 생성·편집과 첨부 렌더링은 아직 검증하지 않았습니다. 최초 POST 결과가 불확실하면 자동으로 다시 생성하지 않으며 운영자가 메시지 ID를 대조해야 합니다. 알려진 ID의 PATCH는 안전하게 재시도합니다. Discord가 정확히 Unknown Message(10008)를 반환한 경우에만 새 메시지를 만들 수 있습니다. 채널을 바꾸면 새 채널에 게시물을 만들고 이전 채널의 메시지는 삭제하지 않습니다. 편집은 새 게시 알림을 보장하지 않습니다. 해당 시간대에 Cron을 놓치면 당일 게시를 소급 생성하지 않습니다. 공식 사이트의 새 일정 자동 수집은 구현하지 않았습니다.

ID는 날짜를 바꾸더라도 유지합니다. 신청 기간은 기간과 date-only 마감일을 같이 저장, 시험/학기 시작/휴일은 deadline 아님. 교직원 성적 제출 일정은 학생 게시에서 제외. 검토된 날짜 수정은 기존 게시물의 다음 15분 변경 확인에서 반영됩니다. 삭제 대신 해당 ID를 명시적으로 비활성화하세요; importer는 누락 ID를 자동 삭제하지 않습니다. `--approve`는 파일 전체 학생 대상 항목을 승인하므로 전체를 검토하세요.

## 6. 장애 확인과 재처리

`/status` 먼저 확인. 공유 작업은 종류·실행 상태·최근 생성일·검토 구분을 표시하며, 미해결/보류와 검토 종료 이력을 분리합니다. `job_reviews`는 원본 작업 상태·시도 수·오류와 LLM 예약을 변경하지 않는 운영자 검토 주석입니다. `closed`는 검토 종료이지 작업 성공이 아니며, `deferred`는 아직 보류입니다. 상태/시도 수가 바뀌면 기존 검토는 적용되지 않습니다. 자동 검토 종료·예약 해제·재실행은 하지 않습니다. 학사일정 게시 상태는 별도 표시합니다(Queue 작업 `done`만으로 게시 성공을 판단하지 마세요). 상태 응답이 2,000자를 넘으면 전체 진단 파일을 첨부합니다. 오래된 명령의 서버 식별정보는 이미 제거됐으므로 서버별 명령 오류 집계에서 제외합니다. [운영 기록 정리안](docs/JOB-REVIEWS.md)을 확인하세요.

상세 조사(읽기만):

```sh
npx wrangler d1 execute sogang-friends --remote --command="SELECT id,state,attempts,error FROM jobs WHERE state NOT IN ('done') LIMIT 30"
npx wrangler d1 execute sogang-friends --remote --command="SELECT id,state,message_id,error FROM deliveries WHERE state != 'sent' LIMIT 30"
npx wrangler d1 execute sogang-friends --remote --command="SELECT * FROM sources"
npx wrangler d1 execute sogang-friends --remote --command="SELECT day,state,reserved_usd,actual_usd FROM llm_usage ORDER BY created_at DESC LIMIT 30"
```

- 소스 실패: last_attempt/error만 갱신, last_success와 정상 공지는 유지. 다른 게시판 job은 계속 처리.
- pending/retry: Cron dispatcher가 다시 큐 전달. 일반 작업은 최대3회 claim입니다. 과거 식단 추출 메시지는 호출 없이 검토 상태로 보류합니다. lease20분 > consumer15분이며 consumer 중단 뒤 다음 Cron이 회수합니다.
- Discord `uncertain` 또는 중단된 `sending`: 실제 채널 기록을 사용자 확인. 이미 게시됐다면 message ID를 기록하여 sent 처리; 게시되지 않았음이 확인돼도 재발송은 명시적 운영 판단 뒤에만. **일괄 retry 금지**.
- 과거 LLM needs_review: 원래 실패/불확실 결과와 예약을 보존합니다. 이제 모델 경로는 제거됐으므로 재호출하지 않습니다. 현재 식단은 OCR workflow 결과와 원본 날짜·요일을 확인하세요.
- 일반 수집의 **단일 비발송 작업만** 원인 확인·승인 후 재처리하세요. 과거 식단 추출 작업을 초기화하거나 usage row를 삭제하지 마세요. 식단 OCR 재검증은 새 수동 workflow에서 수행하며 운영 접수는 별도 승인 대상입니다.
- webhook token은 필요한 최소 interaction 필드만 D1에 잠시 저장, 완료 또는15분 만료 후 삭제. 관리자 조회에 payload를 표시하지 않음. D1 접근도 secret 접근처럼 제한.
- 로그는 사용자/토큰/원본 전체를 남기지 않음. Wrangler tail을 사용할 때 민감 입력을 로그로 추가하지 마세요.

기록은 MVP에서 자동 삭제하지 않습니다(공지 baseline/발송 중복 키 유지). 장기 운영 전 retention/backup 정책을 결정하세요. 초기화에 DB 삭제나 baseline 제거를 사용하면 과거 알림 기준이 바뀌므로 운영 DB를 무심코 재생성하지 마세요.

## 7. 공식 원본과 런타임 검증 경계

| 대상 | 원본 |
|---|---|
| 학교 학사 | www.sogang.ac.kr 공식 BbsData boardList, bbsConfigFk=2; UI /ko/academic-support/notices |
| 컴퓨팅 학사 | https://computing.sogang.ac.kr/ko/community/academicNotice/list?num=1 |
| 컴퓨팅 대학원 | https://computing.sogang.ac.kr/ko/community/graduateNotice/list?num=1 |
| 컴퓨팅 소식 | https://computing.sogang.ac.kr/ko/community/news/list?num=1 |
| 컴퓨팅 대외정보 | https://computing.sogang.ac.kr/ko/community/externalInfo/list?num=1 |
| 컴퓨팅 취업·인턴십 | https://computing.sogang.ac.kr/ko/community/career/list?num=1 |
| 벨라르미노 | https://scc.sogang.ac.kr/front/cmsboardlist.do?bbsConfigFK=1185&siteId=dormitory&currentPage=1 |
| 학사 일정 | https://www.sogang.ac.kr/ko/academic-support/calendar |

최근 수집은 대학50개/컴퓨팅3페이지/식단2페이지로 제한합니다. 원문 보관을 활성화하면 최근 목록 중 아직 보관하지 않은 공지의 상세 본문도 Node에서 수집합니다. 과거 backfill은 별도 기능으로 한 실행당 최대6개 목록 페이지, 추가3초 간격, 약7분 예산을 사용합니다. HTML/JSON2MiB, timeout20초, redirects 거부, 기본 요청 간격1초. 분산 수집 pacer는 없으므로 Actions의 공통 concurrency group을 유지하세요.

본부 중간 인증서 누락은 직접 Workers 수집에서 HTTP526으로 확인했습니다. 이 프로젝트의 독립 Node/Actions 수집기는 검증된 public intermediate CA를 사용해 6개 게시판의 수집·운영 업로드에 성공했습니다. **TLS 검증을 끄지 않았으며** 다른 저장소의 배포·피드에 의존하지 않습니다.

## 공지 원문 보관과 전체 이력 backfill

`notices`는 `(source,id)`로 수집한 메타데이터를 누적하며 오래된 row를 삭제하지 않습니다. 학교 학사는 공식 `pkId`, 컴퓨팅은 `/detail/<ID>`를 사용하므로 게시판 간 ID 충돌은 없습니다.

**6개 게시판의 원문 보관·느린 1회 backfill을 구현했으며, 기본 비활성입니다.** [설정·운영 안내](docs/NOTICE-ARCHIVE.md)

- **기존 D1만 사용**: `notice_archive_raw`에 원본 본문 HTML(TEXT), 공지 메타데이터·첨부/이미지 링크(JSON), 수집 시각·해시를 저장합니다. R2 bucket이나 Cloudflare 카드 등록은 필요 없습니다.
- `raw/<source>/<id>.json`은 archive 인덱스의 **논리적 식별자**이며 실제 파일/폴더가 아닙니다. 원문과 인덱스는 하나의 D1 transaction으로 저장하고 공지별 최초 원문 하나만 보관합니다. 파일 바이너리, 수정 본문 이력, 최신 원문 재검증은 제공하지 않습니다.
- D1의 검색용 메타데이터·게시판별 cursor는 그대로 유지합니다. 과거 글을 저장해도 알림·baseline·최근 수집 상태를 변경하지 않습니다.
- `processed/`는 이후 실제 LLM 가공 결과를 별도로 보관할 단계의 이름입니다. 이번 단계에는 processed table·공지 모델 호출·가짜 결과·과거 전체 자동 요약이 없습니다.
- Free D1은 **DB당500MB**, row당2,000,000byte 제한입니다. 원문 row의 본문·JSON 크기는1,900,000byte 이하로 검사합니다. 전체 과거 이력이500MB에 들어간다는 보장은 없으며 기존 작업·식단·일정도 같은 용량을 사용합니다. D1 응답의 DB 크기가400MB 이상이면 신규 원문 저장을 멈춰 bot 운영 용량을 남깁니다. 기존 원문 재접수는 허용하고 크기 metadata가 없으면 신규 저장은 중단합니다. 마지막 저장이나 동시 쓰기로400MB를 조금 넘을 수 있으므로 용량도 확인해야 합니다.
- 6시간마다 총6개 페이지 이내의 느린 backfill; 명시적 시작 후 재개 가능. 실제 저장 확인 전 cursor를 이동하지 않습니다. 직접 상세 HTTP404/410은 삭제 표시로 넘기고, 5xx·알 수 없는 형식은 재시도 대상으로 남깁니다.
- 완료 후에는 최근 범위만 확인합니다. 공식 사이트에서 이미 삭제된 글은 복구하지 않습니다. 움직이는 페이지 순회이므로 특정 시점의 완벽한 snapshot은 보장하지 않습니다.

기존 DB에 additive migration **0003·0004**와 Worker/Actions feature flags가 필요합니다. **원격 migration·배포·Actions 활성화·실제 backfill은 별도 운영 승인 전 실행하지 않습니다.** 새 저장소 서비스나 bucket은 만들지 않습니다. 기존 R2-only 인덱스가 있는 다른 환경은 별도 원문 import 없이 D1 보관 완료로 간주하지 않습니다. 식단의 이미지 해시/처리 버전 식별자는 유지하되 본문 캐시는 현재·다음 주로 제한합니다. 동일 날짜 수정 식단을 위한 별도 revision 구조는 추가하지 않습니다.

## 검증과 남은 제한

`npm run check`는 fixture + 실제 Ed25519 + 실제 SQLite SQL 테스트. baseline/pins/upserts/last-good, 날짜·요일·만료, KST/D-day, permissions/guild scope, atomic claims/outbox/budget, ambiguous POST/429/expiry/token purge, bounded menus/mentions를 검증합니다. CI는 오프라인 검사와 dry-run bundle만 수행합니다.

운영 검증과 남은 한계는 [docs/VERIFICATION.md](docs/VERIFICATION.md)를 참고하세요. 2026-10-10 사용자 승인으로 D1 archive migration·운영 배포·최근 원문215개 저장과 6개 보드 첫 backfill 페이지를 확인했습니다. Git의 archive flag와 운영 설정/Actions에서 원문 보관을 활성화했습니다. 전체 이력 완료·공지 LLM 처리와 운영 OCR 성공은 아직 확인하지 못했습니다. 별도 로컬 native OCR 검사는 7개 주간 원본 중 날짜가 일치하는 6개에서 성공했고 실제 Actions 검증도 통과했습니다. 운영 ingestion·전환 배포의 실행 결과는 검증 기록을 확인하세요. dry-run은 배포가 아닙니다.

다음 버전: staging 통합 테스트, 날짜별 식단 사람 승인/정확히 묶인 검토 override, decoded 이미지 pixel 제한, 안전한 관리자 reconciliation 도구, 공지 보관 용량/정책, 분산 요청 pacing, 공지 원문 기반 실제 LLM 가공, 일정 정정 알림. 정확히 한 번 발송은 보장하지 않으며 Discord POST와 D1 기록은 비원자적입니다.
