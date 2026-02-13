/**
 * 네이버 카페 수동 로그인 스크립트
 * 사용법: npm run cafe:login
 */

import { chromium } from "playwright-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
import * as fs from "fs";
import * as path from "path";

chromium.use(StealthPlugin());

const STORAGE_PATH = path.join(process.cwd(), "playwright", "storage");
const SESSION_FILE = path.join(STORAGE_PATH, "naver-cafe-session.json");

if (!fs.existsSync(STORAGE_PATH)) {
  fs.mkdirSync(STORAGE_PATH, { recursive: true });
}

async function main() {
  console.log("=".repeat(50));
  console.log("네이버 카페 자동화 - 로그인 설정");
  console.log("=".repeat(50));
  console.log("1) 브라우저에서 네이버 로그인");
  console.log("2) 로그인 완료 후 대기");
  console.log("3) 세션 자동 저장 후 종료");
  console.log("");

  const browser = await chromium.launch({
    headless: false,
    slowMo: 50,
    args: ["--disable-blink-features=AutomationControlled"],
  });

  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    locale: "ko-KR",
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  });

  const page = await context.newPage();
  await page.addInitScript(`
    Object.defineProperty(navigator, 'webdriver', { get: () => false });
  `);

  await page.goto("https://nid.naver.com/nidlogin.login", {
    waitUntil: "domcontentloaded",
  });

  console.log("브라우저가 열렸습니다. 로그인 완료를 감지 중입니다...");
  console.log("팁: 로그인 후에도 이 창을 닫지 마세요. 자동으로 쿠키를 확인한 뒤 종료합니다.");

  // Naver logged-in session is represented by cookies like NID_AUT / NID_SES.
  // URL 변화만으로는 로그인 감지가 실패할 수 있어, 쿠키 기반으로 확정한다.
  const mustHaveCookies = ["NID_AUT", "NID_SES"];
  let isLoggedIn = false;

  for (let i = 0; i < 600; i++) {
    await page.waitForTimeout(1000);

    const cookies = await context.cookies();
    const cookieNames = new Set(cookies.map((c) => c.name));
    const ok = mustHaveCookies.every((name) => cookieNames.has(name));

    if (ok) {
      isLoggedIn = true;
      break;
    }
  }

  if (!isLoggedIn) {
    console.log("로그인 쿠키(NID_AUT/NID_SES) 감지 실패. (로그인이 안 됐거나, 쿠키가 차단됐을 수 있습니다.)");
    console.log("그래도 현재 상태로 세션을 저장합니다. 이후 스크랩이 로그인 페이지로 튕기면 다시 시도하세요.");
  } else {
    console.log("로그인 쿠키 감지됨. 세션 저장 중...");
  }

  await context.storageState({ path: SESSION_FILE });
  console.log(`세션 저장 완료: ${SESSION_FILE}`);

  await browser.close();
}

main().catch((error) => {
  console.error("오류:", error);
  process.exit(1);
});
