# Sogang Friends Bot — independent MVP

서강대학교 친구 서버용 Discord HTTP 봇. **이 프로젝트만** 운영하며 기존 discord-bot/sogang-notices/SogangLife의 피드·Actions·KV·Worker·소스에 런타임 의존하지 않습니다. 코드와 fixture는 새로 작성했습니다. 참고 검토/라이선스 경계: [docs/REFERENCES.md](docs/REFERENCES.md).

## 구현 범위

- 공식 6개 게시판(학교 학사공지, 소프트웨어융합대학 학사·대학원·대외정보·소식·취업) 수집. 독립 Node 수집기 + 이 프로젝트의 GitHub Actions가 HTTPS 목록을 읽고, 인증된 snapshot을 Worker에 전달. 안정 ID 저장, 최초 baseline, 새 공지 묶음 발송, 제목/링크 갱신. [공지 수집 설정](docs/NOTICE-COLLECTOR.md)
- 공식 벨라르미노 게시물/이미지 발견, SHA-256 캐시, OpenRouter 무료 모델 image + JSON 출력(지원 모델에는 strict JSON schema), 관측 날짜/요일/기간/운영 근거 검증. 만료 식단을 오늘 식단으로 대체하지 않음.
- 공식 학사 일정 27개 초기 자료(2026-09–2027-02), `/schedule` 30일 조회. 사용자 검토·승인 전 자동 알림 비활성. 날짜만 있는 마감에 시각을 만들지 않음.
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
src/notice-archive.ts R2 원문 저장 / D1 archive 인덱스·checkpoint
src/notice-archive-sources.ts 상세 본문·첨부 링크 / 과거 페이지 검증
src/meals.ts     OpenRouter 구조화 추출 / 의미 검증 / 표시
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

`wrangler.toml`은 새 리소스용 placeholder 설정입니다. `.env.example`을 참고해 필요시 `.dev.vars`에 로컬 secrets를 작성합니다. 기본 `LLM_ENABLED=false`. Discord는 `/interactions`, 외부 공지 수집기는 HMAC 인증이 필요한 `/internal/notices`를 사용합니다. 외부 수집 모드는 `NOTICE_COLLECTION_MODE=external`; 전용 `NOTICE_INGEST_SECRET` 설정 전 접수는 503입니다. 활성 endpoint에 서명 없는 POST는 401이 정상입니다. 로컬 Cron 테스트 `/__scheduled`는 dev 전용이며 **실제 원본 수집을 수행할 수 있으므로** fixture 테스트와 구분하세요. 기본 `npm test`는 외부 요청을 하지 않습니다.

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
# 식단 API 사용 결정 후만:
npx wrangler secret put OPENROUTER_API_KEY
npm run deploy
```

일정 SQL에는 명시적 `BEGIN TRANSACTION`/`COMMIT`을 넣지 마세요. 원격 D1 import가 자체 transaction을 제공하며 explicit BEGIN은 거부합니다. 로컬 Wrangler는 이를 제거해 처리하므로 로컬 성공만으로 원격 성공을 판단하지 마세요. 입력 뒤 `SELECT COUNT(*) AS total, SUM(active) AS approved FROM schedules`로 결과를 확인하세요(기본 seed: 27 / 0).

Wrangler account 선택 및 Queues 요금/retention은 현재 계정 정책을 확인하세요. consumer batch=1/concurrency=1, durable claim도 적용. DLQ는 별도 queue, 자동 POST 재발송 용도가 아닙니다. Worker가 자동 생성한 과거 봇 리소스에 연결되지 않았는지 배포 출력 확인.

Cron은 15분마다 실행. `/status`의 `식단·Cron`에서 `id=cron`의 `last_attempt`/`last_success`/`error`로 계획 단계 실행을 확인합니다. Cloudflare Cron 변경은 전파에 최대 15분이 걸릴 수 있습니다. Cron row가 없으면 handler가 DB에 실행 시작을 기록하지 않은 상태이며, 학교 사이트 오류와 구분해야 합니다. `NOTICE_COLLECTION_MODE=external`에서는 공지를 Node/Actions가 수집하고, 기존 직접 수집 작업도 실행하지 않습니다. `worker` 모드(이전 설정의 기본값)에서만 `SOURCE_INTERVAL_HOURS=6`의 bucket마다 게시판을 직접 수집하며, 학교 본부 인증서 체인 문제는 이 모드에서 해결되지 않습니다. 식단 발견은 두 모드 모두 같은 bucket으로 계획합니다. 재배포는 baseline을 초기화하지 않습니다. 첫 수집에서는 기존 공지를 저장하고 발송하지 않습니다. 다운타임은 공지 bounded window(최대 3페이지) 안에서만 복구하며 전체 이력을 보장하지 않습니다.

`MEAL_TIME_KST=07:30` 기준 현재 15분 window 안에서만 하루 식단/마감 작업을 생성합니다. 놓친 일일 작업은 다음 날 몰아 보내지 않습니다. 이미 생성된 식단/마감 delivery도 해당 KST 날짜가 지나면 `expired`; 공지는 intent 생성 전후 모두 최대 24시간만 유효합니다.

## 4. OpenRouter 비용·정확성 설정

**OpenRouter는 무료 모델만 사용합니다. 유료 모델 및 유료 fallback은 금지합니다.** https://openrouter.ai/settings/keys 에서 이 앱 전용 키를 만드세요. 코드가 `:free` 접미사와 카탈로그의 모든 과금 항목이 0인지 확인하고, provider 가격 상한도 0으로 설정합니다. 조건 불일치 시 호출하지 않습니다. 키 credit limit도 추가 방어로 설정하세요.

무료 요청 한도는 모든 계정에 무조건 1000회/일이 아닙니다. 현재 공식 안내는 기본 50회/일, $10 이상 credit 구매 시 1000회/일, 20회/분입니다. 사용자는 $10 이상 credit 구매를 확인했으므로 현재 계정 한도는 **1000회/일·20회/분**입니다(`AGENTS.md`에도 기록). 식단과 이후 공지 가공 등 용도 간 공유 한도이며 기능마다 따로 1000회를 부여하지 않습니다. 현재 식단 하루2회 제한은 별도 설정으로 유지합니다. 봇은 credit 잔액이 있더라도 유료 모델을 사용하지 않습니다. [공식 안내](https://openrouter.ai/docs/api/reference/limits)

- `MEAL_MODEL`: 기본 `google/gemma-4-31b-it:free`. 현재 public metadata상 image + response_format 지원, structured_outputs 미지원이므로 JSON mode 사용. schema는 prompt에 명시하고 코드 의미 검증은 동일하게 유지합니다. 무료 모델이 structured_outputs를 지원하면 strict schema로 요청합니다. 실제 식단 OCR 성능은 아직 검증하지 않았습니다.
- `LLM_ENABLED=true`로 켜기 전 이미지 결과를 검토하세요. false/키 누락은 공지·일정·저장 식단 조회를 막지 않습니다.
- `LLM_DAILY_CALLS=2`, `LLM_DAILY_BUDGET_USD=0.50`, `LLM_MAX_CALL_USD=0.25`.
- 마지막 값은 기존 D1 예산 회로의 **호출당 보수적 예약액**으로 유지하며 예상 청구액이 아닙니다. 무료 모델의 확인된 단가는 0입니다. 기본 자동 추출은 하루 2개 작업으로 충분하며 1000회 한도를 소진하려는 설정이 아닙니다. unknown/실패 사용량은 환급하지 않고, 응답에 비용이 있다면 메뉴가 거부돼도 기록합니다.
- prompt/completion 가격은 필수 확인, image/request와 기타 공개 과금 항목도 모두 0이어야 합니다. `provider.max_price`도 0으로 요청합니다. 가격 또는 지원 metadata 변경은 fail-closed.
- 다른 무료 모델로 설정할 수 있지만 이미지 입력과 JSON 출력은 필수입니다. `:free`가 아닌 모델·자동 모델 선택 router·유료 대체 경로는 사용하지 않습니다.
- 이미지 최대5MiB, PNG/JPEG magic 검증; HTTP 응답 최대512KiB, inference120초, output6000 token. 이미지 byte 제한은 있지만 decoded pixel 제한은 아직 없습니다.
- exact image SHA256 + 처리 버전 + 공식 post URL + 기간이면 기존 결과 사용. `PROCESSING_VERSION`은 prompt/schema/검증 변경 시 올립니다.
- 관측 날짜/요일 중복·누락·범위 충돌, 불확실 출력 거부. 공백은 미운영이 아니라 unknown. 컵밥은 해당 날짜 메뉴 근거가 있어야만 표시; 시간은 원문 근거일 때만 표시.
- 모델에는 inline image·JSON schema·추출 지시만 제공하고 임의 URL/Discord 관리 도구를 주지 않습니다.
- 최초 추출은 사용자 검토 후 활성화하세요. JSON mode/schema와 evidence는 정확성을 증명하지 않습니다.

현재 수동 수정/승인 UI와 arbitrary menu override는 제공하지 않습니다. 이상한 정상 결과는 해당 D1 캐시를 비공개로 격리하고 원문을 확인해야 합니다. 검토 데이터 자동 적용은 다음 버전에서 post URL/hash/기간에 묶인 형식으로 추가합니다.

## 5. 학사 일정 검토·초기화

`data/schedule.json`은 공식 본부 일정의 실제 데이터이며 예시가 아닙니다. 학교 자료를 확인한 날짜는 2026-10-09. 모두 `active:false`: **사용자의 사람 검토를 대신하지 않습니다.** 출처 비교와 불일치는 [docs/schedule-evidence.md](docs/schedule-evidence.md).

```sh
# 사용자: 공식 자료, 신청 기간의 마감 의미, 변경 사항 확인 후
npm run schedule:import -- --approve
# 먼저 local에 적용하여 조회 확인
npx wrangler d1 execute sogang-friends --local --file=data/schedule.sql
# 승인 후에만 remote 적용
npx wrangler d1 execute sogang-friends --remote --file=data/schedule.sql
```

ID는 날짜를 바꾸더라도 유지합니다. 신청 기간은 기간과 date-only 마감일을 같이 저장, 시험/학기 시작/휴일은 deadline 아님. 교직원 성적 제출 마감은 학생 알림에서 제외. D-7/D-1/당일만 알림, 안정 event ID + offset + guild로 중복 차단. 일정 변경 후 이미 발송한 같은 offset 알림은 자동 재발송하지 않습니다(정정 알림은 다음 버전). 삭제 대신 해당 ID를 명시적으로 비활성화하세요; importer는 누락 ID를 자동 삭제하지 않습니다. `--approve`는 파일 전체 학생 대상 항목을 승인하므로 전체를 검토하세요.

## 6. 장애 확인과 재처리

`/status` 먼저 확인. 상세 조사(읽기만):

```sh
npx wrangler d1 execute sogang-friends --remote --command="SELECT id,state,attempts,error FROM jobs WHERE state NOT IN ('done') LIMIT 30"
npx wrangler d1 execute sogang-friends --remote --command="SELECT id,state,message_id,error FROM deliveries WHERE state != 'sent' LIMIT 30"
npx wrangler d1 execute sogang-friends --remote --command="SELECT * FROM sources"
npx wrangler d1 execute sogang-friends --remote --command="SELECT day,state,reserved_usd,actual_usd FROM llm_usage ORDER BY created_at DESC LIMIT 30"
```

- 소스 실패: last_attempt/error만 갱신, last_success와 정상 공지는 유지. 다른 게시판 job은 계속 처리.
- pending/retry: Cron dispatcher가 다시 큐 전달. 최대3회 claim, delay exponential; 명시적429 Retry-After 적용. lease20분 > consumer15분. consumer 중단 뒤 다음 Cron이 회수.
- Discord `uncertain` 또는 중단된 `sending`: 실제 채널 기록을 사용자 확인. 이미 게시됐다면 message ID를 기록하여 sent 처리; 게시되지 않았음이 확인돼도 재발송은 명시적 운영 판단 뒤에만. **일괄 retry 금지**.
- LLM needs_review: 이미지/모델/키/예산 확인. ambiguous inference는 자동 재호출하지 않음. confirmed429/preflight 실패만 제한 재시도. unknown charge 예약 보존. 다음 날에도 같은 needs_review image job은 자동 풀리지 않음.
- 필요한 경우 **단일 비발송 작업만** 원인 확인·승인 후 SQL로 state=pending, attempts=0, available_at=현재 UTC 수정. LLM 재호출은 기존 usage reservation과 provider 기록 확인 후 별도 attempt ID로 계획해야 하며 무작정 usage row 삭제하지 마세요.
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

- private R2 `raw/<source>/<id>.json`: 원본 본문 HTML, 첨부/이미지 링크, 수집 시각·해시. 파일 바이너리는 받지 않고 공지별 최초 원문 하나를 보관합니다. 수정 본문 이력이나 최신 원문 재검증을 보장하지 않습니다.
- D1: 검색용 메타데이터, archive 인덱스, 게시판별 cursor. 과거 글을 저장해도 알림·baseline·최근 수집 상태를 변경하지 않습니다.
- `processed/<source>/<id>.json`: 이후 실제 LLM 가공 결과를 위한 경로. 이번 단계에는 공지 모델 호출·가짜 결과·과거 전체 자동 요약이 없습니다.
- 6시간마다 총6개 페이지 이내의 느린 backfill; 명시적 시작 후 재개 가능. 실제 저장 확인 전 cursor를 이동하지 않습니다. 직접 상세 HTTP404/410은 삭제 표시로 넘기고, 5xx·알 수 없는 형식은 재시도 대상으로 남깁니다.
- 완료 후에는 최근 범위만 확인합니다. 공식 사이트에서 이미 삭제된 글은 복구하지 않습니다. 움직이는 페이지 순회이므로 특정 시점의 완벽한 snapshot은 보장하지 않습니다.

새 R2 bucket·migration0003·Worker/Actions feature flags가 필요합니다. **리소스 생성·원격 migration·배포·실제 backfill은 별도 승인 전 실행하지 않습니다.** 기존 식단의 이미지 해시/처리 버전 캐시는 그대로 두며 동일 날짜 수정 식단을 위한 별도 revision 구조는 추가하지 않습니다.

## 검증과 남은 제한

`npm run check`는 fixture + 실제 Ed25519 + 실제 SQLite SQL 테스트. baseline/pins/upserts/last-good, 날짜·요일·만료, KST/D-day, permissions/guild scope, atomic claims/outbox/budget, ambiguous POST/429/expiry/token purge, bounded menus/mentions를 검증합니다. CI는 오프라인 검사와 dry-run bundle만 수행합니다.

운영 검증과 남은 한계는 [docs/VERIFICATION.md](docs/VERIFICATION.md)를 참고하세요. 새 raw archive의 운영 R2/D1 실행·전체 이력 완료·공지 LLM 처리는 아직 검증하지 않았습니다. dry-run은 배포가 아닙니다.

다음 버전: staging 통합 테스트, 날짜별 식단 사람 승인/정확히 묶인 검토 override, decoded 이미지 pixel 제한, 안전한 관리자 reconciliation 도구, 장기 보관 정책, 분산 요청 pacing, 공지 원문 기반 실제 LLM 가공, 일정 정정 알림. 정확히 한 번 발송은 보장하지 않으며 Discord POST와 D1 기록은 비원자적입니다.
