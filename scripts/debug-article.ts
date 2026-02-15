import "dotenv/config";
import { chromium } from "playwright-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
import type { Frame, Page } from "playwright";
import { PrismaClient } from "@prisma/client";
import { decryptString } from "../src/lib/crypto";

chromium.use(StealthPlugin());

const prisma = new PrismaClient();
const STORAGE_STATE_KEY = "naverCafeStorageStateEnc";

type StorageStateObject = { cookies: any[]; origins: any[] };

function isStorageStateObject(value: unknown): value is StorageStateObject {
  if (!value || typeof value !== "object") return false;
  const v = value as any;
  return Array.isArray(v.cookies) && Array.isArray(v.origins);
}

async function loadStorageState(): Promise<StorageStateObject> {
  const secret = process.env.APP_AUTH_SECRET || "";
  const row = await prisma.setting.findUnique({ where: { key: STORAGE_STATE_KEY } });
  if (!row?.value) {
    throw new Error("storageState가 DB에 없습니다.");
  }
  const json = decryptString(row.value, secret);
  const parsed = JSON.parse(json);
  if (!isStorageStateObject(parsed)) {
    throw new Error("storageState JSON 포맷이 올바르지 않습니다. (cookies/origins 필요)");
  }
  return parsed;
}

async function sleep(ms: number) {
  await new Promise((r) => setTimeout(r, ms));
}

async function waitForCafeMainFrame(page: Page, ms: number): Promise<Frame | null> {
  const start = Date.now();
  while (Date.now() - start < ms) {
    const f = page.frame({ name: "cafe_main" }) || page.frame({ name: "mainFrame" }) || null;
    if (f) return f;
    await sleep(150);
  }
  return null;
}

async function main() {
  const url = process.argv[2];
  if (!url) throw new Error("usage: npx ts-node --project tsconfig.scripts.json scripts/debug-article.ts <url>");

  const storageState = await loadStorageState();
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    storageState,
    locale: "ko-KR",
    viewport: { width: 1366, height: 900 },
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  });
  const page = await context.newPage();
  page.setDefaultTimeout(15000);
  await page.addInitScript(`Object.defineProperty(navigator,'webdriver',{get:()=>false});`);

  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 35000 });
  await sleep(1200);
  const frame = (await waitForCafeMainFrame(page, 8000)) || page;

  console.log("URL:", url);
  console.log("PAGE.URL:", page.url());
  console.log("FRAME.URL:", "url" in frame ? (frame as any).url() : "(page)");

  const selectors = [
    "div.se-main-container",
    "div.se-viewer",
    "div.article_viewer",
    "div.ContentRenderer",
    "div.ArticleContentBox",
    "#tbody",
    "article",
    "body",
  ];

  await (frame as any)
    .waitForSelector(selectors.slice(0, -1).join(", "), { timeout: 20000 })
    .catch(() => undefined);

  for (const sel of selectors) {
    const loc = (frame as any).locator(sel).first();
    const count = await loc.count().catch(() => 0);
    if (count === 0) {
      console.log(`SEL ${sel} count=0 len=0 preview=`);
      continue;
    }
    const txt = String(await loc.innerText().catch(() => "")).trim();
    console.log(`SEL ${sel} count=${count} len=${txt.length} preview=${txt.replace(/\s+/g, " ").slice(0, 220)}`);
  }

  const commentSelectors = [
    ".CommentItem",
    "li.CommentItem",
    "[class*='CommentItem']",
    "li[class*='comment']",
    "[class*='comment']",
  ];
  for (const sel of commentSelectors) {
    const items = (frame as any).locator(sel);
    const n = await items.count().catch(() => 0);
    if (!n) continue;
    const first = String(await items.first().innerText().catch(() => "")).trim();
    console.log(
      `COMMENT_SEL ${sel} count=${n} firstLen=${first.length} firstPreview=${first.replace(/\s+/g, " ").slice(0, 220)}`
    );
  }

  const classSamples = await (frame as any)
    .evaluate(() => {
      const out: string[] = [];
      const nodes = Array.from(document.querySelectorAll("[class]")) as HTMLElement[];
      for (const el of nodes) {
        const cls = String(el.className || "");
        if (!cls) continue;
        const c = cls.replace(/\s+/g, " ").trim();
        if (!/(comment|Comment)/.test(c)) continue;
        out.push(c);
      }
      const uniq = Array.from(new Set(out));
      return uniq.slice(0, 60);
    })
    .catch(() => []);
  if (classSamples.length) {
    console.log("COMMENT_CLASS_SAMPLES:", classSamples);
  }

  await context.close().catch(() => undefined);
  await browser.close().catch(() => undefined);
  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect().catch(() => undefined);
  process.exit(1);
});
