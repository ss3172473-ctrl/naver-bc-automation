# 네이버 카페 아카이빙 (naver-bc-automation)

네이버 카페에서 **내가 열람 가능한 게시글**을 조건 기반으로 찾아서,
**본문 전체 텍스트 + 댓글 전체 텍스트**를 Google Sheets로 아카이빙하는 프로젝트입니다.

이 문서는 “인수인계용”입니다. 다음 개발자가 그대로 이어서 고칠 수 있도록 현재 구조/환경변수/디버깅 방법/미해결 이슈를 정리했습니다.

## 0) 핵심 요구사항(현재 구현 기준)

- 입력: 선택한 카페들 + 키워드 목록(쉼표 구분, 공백 자동 제거)
- 동작:
  - **카페 A에서 키워드 a,b,c...를 각각 검색 → 조건 맞는 글을 수집**
  - **카페 B에서도 동일하게 반복**
  - 검색은 페이지당 50개(`size=50`), **키워드당 최대 4페이지(=최대 200개 후보)까지 스캔**
- 저장:
  - DB(PostgreSQL): 원문/댓글 텍스트를 최대한 보존
  - Google Sheets: `posts_v2` 시트(웹훅)로 전송
- 진행상황:
  - 웹에서 `카페 x 키워드 진행표`로 `후보/수집/스킵/필터` + `페이지 x/4` 표시
- 실행 정책:
  - 웹에서 작업 등록(수동)
  - Worker(Railway)가 24시간 큐를 처리(PC 꺼도 진행)

## 1) 전체 아키텍처

- Web(UI): **Vercel**
  - Next.js(App Router)
  - 작업 생성/조회/중단, 세션(storageState) 업로드
  - 진행표(UI)는 DB에 기록된 progress를 폴링해서 렌더
- Worker: **Railway**
  - Node 프로세스 1개(`npm run worker`)
  - DB에서 `QUEUED` 작업을 가져와 순차 실행
  - Playwright로 카페 글/댓글 파싱
- DB: **Neon PostgreSQL**
  - Vercel/Worker가 **동일한 DATABASE_URL**을 사용해야 함
- Sheets: **Google Apps Script Web App**
  - `GSHEET_WEBHOOK_URL`로 POST 전송
  - `posts_v2` 시트에 append

## 2) 데이터 흐름(파이프라인)

1. 웹(UI)에서 작업 생성
   - 선택 카페 수만큼 **작업을 카페별로 분할 생성**(1카페 = 1 job)
2. Worker(Railway)가 큐에서 `QUEUED` job pick → `RUNNING`
3. 키워드별 검색
   - Naver 내부 검색 API(모바일)로 후보 글 목록을 가져옴
   - `perPage=50`, 키워드당 최대 4페이지 스캔
4. 후보 글 파싱
   - 게시글 페이지 접속 → 본문 텍스트/댓글 텍스트 추출
   - 열람 불가(가입/등업/권한) 페이지는 스킵 처리
5. 저장/연동
   - DB에 저장(게시글/댓글)
   - Google Sheets 웹훅으로 전송(시트는 `posts_v2`만 사용)
6. 진행상황 업데이트
   - DB `Setting.key = scrapeJobProgress:<jobId>`에 progress JSON 저장
   - 웹은 이 progress를 폴링해서 표를 갱신

## 3) 저장 포맷(Google Sheets: posts_v2)

웹훅 payload는 아래 키로 전송합니다:
- `postRowsV2`: 배열

각 row 필드:
- `jobId`
- `sourceUrl` (게시글 링크)
- `cafeId` (예: `mom79`)
- `cafeName` (예: `초등맘 (초중고 부모들의 목소리)`)
- `cafeUrl` (카페 링크)
- `title`
- `authorName` (현재는 비워질 수 있음; 필요없다면 제거 가능)
- `publishedAt` (ISO string)
- `viewCount`, `likeCount`, `commentCount`
- `bodyText` (본문 전체 텍스트)
- `commentsText` (댓글 전체 텍스트)
- `contentText` (본문+댓글을 합친 텍스트)

주의:
- Sheets는 셀 글자수 제한이 있어 `src/lib/sheets.ts`에서 긴 텍스트를 잘라서 보냅니다(원문 전체는 DB에 남김).

## 4) 환경변수(필수)

Vercel과 Railway 모두 아래는 **동일하게 설정**:

- `DATABASE_URL`
  - Neon Postgres 접속 문자열
  - Web/Worker가 서로 다른 DB를 보면 “진행표가 안 뜸 / 작업이 따로 도는” 현상이 발생합니다.
- `APP_AUTH_SECRET` (16자 이상)
  - storageState 암호화/복호화, 로그인 토큰 서명에 사용
- `GSHEET_WEBHOOK_URL`
  - Apps Script Web App URL
  - 비워두면 Sheets 전송을 스킵(=DB만 저장)

옵션:
- `APP_LOGIN_ID`, `APP_LOGIN_PASSWORD`
  - `/login` 로그인용(간단 비밀번호 인증)
  - 현재 코드는 “토큰이 없어도 public 사용자”로 동작하도록 되어 있어, 진짜 보안이 필요하면 `src/lib/auth.ts`의 `getCurrentUser()` 정책을 강화해야 합니다.
- Telegram(선택):
  - `TELEGRAM_BOT_TOKEN`, `TELEGRAM_ALLOWED_CHAT_IDS` 등

## 5) 세션(storageState) 준비(가장 중요)

Worker가 네이버에 로그인된 상태로 접근하려면 **Playwright storageState(JSON)** 가 필요합니다.

1. 로컬(내 PC/Mac)에서 1회 로그인 세션 생성
```bash
cd "/Users/leesungjun/Documents/New project/naver-bc-automation"
npm install
npx playwright install chromium
npm run cafe:login
```

2. 생성된 파일 확인(예상 경로)
- `naver-bc-automation/playwright/storage/naver-cafe-session.json`

3. 웹 대시보드의 `1) 카페 세션 확인`에서 JSON 전체를 붙여넣고 저장

## 6) 로컬 실행(개발/디버깅)

웹(UI):
```bash
cd "/Users/leesungjun/Documents/New project/naver-bc-automation"
npm run dev
```

Worker(로컬에서 큐 처리):
```bash
cd "/Users/leesungjun/Documents/New project/naver-bc-automation"
npm run worker
```

특정 jobId만 실행(디버깅):
```bash
cd "/Users/leesungjun/Documents/New project/naver-bc-automation"
npm run scrape:job -- <jobId>
```

카페 검색 API 디버그:
```bash
cd "/Users/leesungjun/Documents/New project/naver-bc-automation"
npm run debug:cafe-search -- "https://cafe.naver.com/f-e/cafes/<clubid>/menus/0?viewType=L&ta=ARTICLE_COMMENT&page=1&q=%EC%A7%91%EC%A4%91&size=50"
```

## 7) “페이지 1/4”가 웹에서 안 보일 때 체크리스트

1. Vercel이 최신 코드인지 확인
   - 대시보드 상단에 `WEB <sha>`가 표시됩니다.
   - 또는 API로 확인: `GET /api/version`
2. Railway Worker가 실제로 돌고 있는지 확인
   - 대시보드 상단에 `WORKER <sha>` + “worker n초 전”이 표시됩니다.
   - `GET /api/worker-status`가 `null`이면 Worker가 DB에 heartbeat를 못 쓰는 상태입니다.
3. Web과 Worker의 `DATABASE_URL`이 같은지 확인
   - 다르면: 작업 생성은 되는데 진행표/페이지 카운트가 영원히 `-`로 보이거나, 큐가 안 움직입니다.
4. Worker가 진행값(progress)을 쓰는지 확인
   - DB `Setting.key = scrapeJobProgress:<jobId>` row가 있어야 합니다.
   - API로도 확인 가능: `GET /api/scrape-jobs/<jobId>/progress`

## 8) Railway가 GitHub 자동배포(자동 Deploy)인지 확인하는 방법

Railway 콘솔에서:
1. Project 선택 → 해당 Service(Worker) 선택
2. `Deployments` 또는 `Settings > Source` 메뉴 확인
3. 아래가 보이면 GitHub 연동 상태입니다:
   - 연결된 GitHub repo/branch
   - “Push 할 때 자동 Deploy” 옵션(자동 배포 토글)
   - 최근 배포 히스토리(커밋 SHA)

연동이 안 되어 있으면:
- “Connect Repo / Deploy from GitHub” 같은 버튼으로 연결해야 합니다.

## 9) 미해결/리스크(다음 작업자가 바로 봐야 함)

- 카페별/게시판별 권한(가입/등업) 때문에 **검색은 되지만 본문/댓글 파싱이 막히는 글**이 존재함.
  - 현재는 이런 페이지를 감지하면 스킵 처리합니다.
- 네이버 UI/DOM 변경에 취약
  - 본문/댓글 파서는 구조 변경에 따라 깨질 수 있습니다.
- 속도/안정성
  - 키워드가 많고 카페가 많으면 시간이 오래 걸립니다(Worker는 순차 실행).
  - 너무 공격적으로 돌리면 차단/레이트리밋 가능성이 있으므로, sleep/재시도는 보수적으로 유지 중.
- “정말 최대 4페이지를 봤는지” 검증
  - Worker는 progress에 `pagesScanned/pagesTarget`를 기록하도록 되어 있습니다.
  - 웹에서 페이지 라인이 안 보이면, 대체로 “Vercel/Worker 코드 불일치(배포 stale)” 또는 “DB 불일치” 입니다.

## 10) 주요 파일(인수인계용)

- 웹 UI: `naver-bc-automation/src/app/page.tsx`
- 작업 생성 API: `naver-bc-automation/src/app/api/scrape-jobs/route.ts`
- progress 조회 API: `naver-bc-automation/src/app/api/scrape-jobs/[id]/progress/route.ts`
- 버전 API: `naver-bc-automation/src/app/api/version/route.ts`
- 워커 상태 API: `naver-bc-automation/src/app/api/worker-status/route.ts`
- Worker 큐: `naver-bc-automation/scripts/queue-worker.ts`
- Worker 스크래퍼: `naver-bc-automation/scripts/scrape-job.ts`
- Prisma 스키마: `naver-bc-automation/prisma/schema.prisma`
- Sheets 전송: `naver-bc-automation/src/lib/sheets.ts`

