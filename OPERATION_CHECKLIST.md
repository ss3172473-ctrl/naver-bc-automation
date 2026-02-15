# 운영 체크리스트 (Vercel + Worker)

본 문서는 실제 배포 후 1회 점검용입니다.

## 1) Vercel(Web) 환경변수 체크

`vercel` 프로젝트 Settings → Environment Variables에서 다음 항목이 있는지 확인:

1. `APP_LOGIN_ID`  
2. `APP_LOGIN_PASSWORD`
3. `APP_AUTH_SECRET`
4. `DATABASE_URL`
5. `GSHEET_WEBHOOK_URL`  
   - 값: `https://script.google.com/macros/s/<your-webapp-id>/exec`
6. `NODE_ENV=production` (권장)

확인 방법(한 줄 검증):

```bash
vercel env ls
```

예상값은 저장소 내 `.env`와 동일해야 합니다.

---

## 2) Worker(Railway/Render/PM2 등) 환경변수 체크

Worker 실행 환경(컨테이너, 워크플로, 서버)에 다음이 필수:

1. `APP_LOGIN_ID`
2. `APP_LOGIN_PASSWORD`
3. `APP_AUTH_SECRET`
4. `DATABASE_URL`
5. `GSHEET_WEBHOOK_URL`

운영 환경에서 다음을 권장:

6. `TELEGRAM_BOT_TOKEN`(선택)
7. `TELEGRAM_WEBHOOK_SECRET`(선택)
8. `TELEGRAM_ALLOWED_CHAT_IDS`(선택)

동일한 `DATABASE_URL`을 Web과 공유해야 큐/작업/세션이 일치합니다.

---

## 3) 실행 순서 (웹에서 바로 검증)

### 3-1. 웹 대시보드 기본 점검

1. Vercel 배포 URL 접속
2. 로그인 페이지 진입
3. 대시보드 진입 후 상단 상태 확인
4. 왼쪽/상단 섹션의 `세션` 상태가 나타나는지 확인

### 3-2. 세션 상태 점검

1. 세션 창에서 `세션 확인`이 `세션 사용 가능`인지 확인
2. 아니면 `storageState JSON`을 한 번 붙여넣고 `세션 저장`
3. `세션 사용 가능` 텍스트로 바뀌면 갱신 완료

### 3-3. 카페 목록/작업 설정 점검

1. `가입 카페 불러오기` 클릭
2. 원하는 카페 1개 이상 선택
3. 키워드 입력(예: `집중`)
4. 기간(예: 최근 1개월), 최대 수집 글 수(예: 20~40)로 설정
5. 제외 게시판이 있다면 선택 또는 직접 입력

### 3-4. 테스트 작업 실행

1. `작업 등록 후 즉시 실행`
2. 최근 작업 목록에서 새 작업 상태가 `실행 중` 또는 `실행 대기`로 전환되는지 확인
3. `현재 진행 상태` 카드의 스테이지/로그가 바뀌는지 확인
4. 완료 후:
   - `결과`가 `DB n / Sheet n` 형태인지
   - Google Sheets `posts_v2` 시트에 row가 추가되는지

### 3-5. 중단/재실행 동작 점검

1. 대기 상태 또는 실행 중 상태에서 `중단` 버튼 클릭
2. 상태가 `중단됨` 또는 큐에서 제거되는지 확인
3. 실패/중단 후 동일 작업은 `재실행` 가능해야 함

---

## 4) E2E 점검 실패 시 빠른 원인 분기

### A. 시트 미반영

- `GSHEET_WEBHOOK_URL` 오타/오래된 배포 ID인지 확인
- Apps Script 배포가 `웹 앱으로 실행`되고 `실행 권한`이 맞는지 확인
- `.env` 또는 Vercel/Worker 환경변수 갱신 후 재시작

### B. 세션 무효

- `session` 값이 유효하지 않으면 새 브라우저로 로그인해 새 `storageState` 생성 필요
- 세션 저장 후 바로 저장창 닫기/재로드 확인

### C. 작업이 진행 안 됨

- 키워드 수 과도 많음, `최대 수집 글 수` 과다 설정 가능성
- 먼저 소량(카페 1개, 키워드 1개, 최대 20~40)로 테스트

---

## 5) 다음 스텝

- 1회 점검 끝나면 `키워드 개수/카페 수/최대 수집 글 수`를 늘려 스케일업
- 이상 동작 시 `Worker` 쪽 로그에서 `postRowsV2` 전송 로그만 확인하면 됩니다.
