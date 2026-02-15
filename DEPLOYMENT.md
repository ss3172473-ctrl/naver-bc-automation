# Deployment Guide (Vercel + Worker)

## Recommended architecture
- Web UI/API (light): Vercel
- Scrape worker (Playwright): separate server (Railway, Render, Fly.io, VPS)
- Database: PostgreSQL (shared by both)
- Storage: local or object storage for CSV artifacts

Playwright jobs are long-running and browser-dependent, so do not rely on Vercel Serverless for full scraping runtime.

## Environment variables
Required on Web + Worker:
- `DATABASE_URL`
- `APP_LOGIN_ID`
- `APP_LOGIN_PASSWORD`
- `APP_AUTH_SECRET`

Required on Worker:
- `GSHEET_WEBHOOK_URL` (optional but recommended)

예시:
`GSHEET_WEBHOOK_URL=https://script.google.com/macros/s/AKfycbzIFtOr6yGpeh2ZVqdsP2Bt4Ekt7Q7GfV6LGTo5pLR2AE-HqYQGFkP-7EX6fCTd5HLQcA/exec`
- `TELEGRAM_BOT_TOKEN` (optional, for completion/failure notifications)

Required on Web (if using Telegram webhook):
- `TELEGRAM_WEBHOOK_SECRET` (optional but recommended)
- `TELEGRAM_ALLOWED_CHAT_IDS` (optional; comma-separated)

## Startup commands
Web:
- `npm run build`
- `npm run start`

Worker:
- `npm run worker`

## Session handling
Worker는 DB에 저장된 Playwright `storageState`를 사용합니다.
1. 로컬에서 `npm run cafe:login`으로 `playwright/storage/naver-cafe-session.json` 생성
2. 대시보드의 "세션 저장"에 JSON 전체를 붙여 넣고 저장
3. Worker는 DB에서 읽어서 사용 (세션 만료 시 1~2 재수행)

## Google Sheets integration
Use Apps Script Web App endpoint as `GSHEET_WEBHOOK_URL`.
Payload sent by worker:
- `postRowsV2`: post-level rows (single-sheet format)

운영 점검은 [OPERATION_CHECKLIST.md](./OPERATION_CHECKLIST.md)를 기준으로 진행하세요.

## Telegram (optional)
- Webhook endpoint: `/api/telegram/webhook`
- Example commands:
  - `/help`
  - `/cafes`
  - `/scrape remonterrace 단발,인테리어`
  - `/scrape cafes=remonterrace keywords=단발,인테리어 max=80`
