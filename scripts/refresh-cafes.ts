import "dotenv/config";
import { PrismaClient } from "@prisma/client";
import { chromium } from "playwright";
import { decryptString } from "../src/lib/crypto";

const prisma = new PrismaClient();
const STORAGE_STATE_KEY = "naverCafeStorageStateEnc";

type JoinedCafe = { cafeId: string; name: string; url: string };

function extractCafeId(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (parsed.hostname !== "cafe.naver.com") return null;
    const pathname = parsed.pathname.replace(/^\//, "").trim();
    if (!pathname || pathname.toLowerCase().includes("article")) return null;

    // New cafe URLs often look like /ca-fe/cafes/<clubId>
    const m = pathname.match(/^ca-fe\/cafes\/(\d+)(?:\/.*)?$/i);
    if (m?.[1]) return m[1];

    // Old cafe URLs look like /<cafeId>
    if (pathname.includes("/")) return null;
    if (pathname === "mycafelist.nhn") return null;
    return pathname;
  } catch {
    return null;
  }
}

function toCafeUrl(cafeIdOrClubId: string): string {
  if (/^\d+$/.test(cafeIdOrClubId)) {
    return `https://cafe.naver.com/ca-fe/cafes/${cafeIdOrClubId}`;
  }
  return `https://cafe.naver.com/${cafeIdOrClubId}`;
}

async function loadStorageStateFromDb(): Promise<any> {
  const secret = process.env.APP_AUTH_SECRET || "";
  const row = await prisma.setting.findUnique({ where: { key: STORAGE_STATE_KEY } });
  if (!row?.value) {
    throw new Error("DB에 네이버 카페 세션(storageState)이 없습니다. 대시보드에서 세션을 업로드하세요.");
  }
  const json = decryptString(row.value, secret);
  return JSON.parse(json);
}

async function fetchJoinedCafes(storageState: any): Promise<JoinedCafe[]> {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    storageState,
    locale: "ko-KR",
    viewport: { width: 1366, height: 900 },
  });
  const page = await context.newPage();

  try {
    await page.goto("https://section.cafe.naver.com/ca-fe/home", {
      waitUntil: "domcontentloaded",
      timeout: 30000,
    });
    await page.waitForTimeout(1500);

    if (page.url().includes("nidlogin")) {
      throw new Error("네이버 세션이 만료되었습니다. 대시보드에서 storageState를 다시 업로드하세요.");
    }

    const anchors = await page.$$eval("a[href*='cafe.naver.com']", (elements) =>
      elements
        .map((el) => {
          const href = (el as HTMLAnchorElement).href || "";
          const name = (el.textContent || "").trim();
          return { href, name };
        })
        .filter((v) => !!v.href)
    );

    const unique = new Map<string, JoinedCafe>();
    for (const item of anchors) {
      const cafeId = extractCafeId(item.href);
      if (!cafeId) continue;
      if (!unique.has(cafeId)) {
        unique.set(cafeId, {
          cafeId,
          name: item.name || cafeId,
          url: toCafeUrl(cafeId),
        });
      }
    }

    return Array.from(unique.values()).sort((a, b) => a.name.localeCompare(b.name, "ko"));
  } finally {
    await context.close().catch(() => undefined);
    await browser.close().catch(() => undefined);
  }
}

async function main() {
  const storageState = await loadStorageStateFromDb();
  const cafes = await fetchJoinedCafes(storageState);
  console.log(`[cafes] fetched=${cafes.length}`);

  for (const cafe of cafes) {
    await prisma.cafeMembership.upsert({
      where: { cafeId: cafe.cafeId },
      create: { cafeId: cafe.cafeId, name: cafe.name, url: cafe.url },
      update: { name: cafe.name, url: cafe.url },
    });
  }

  console.log("[cafes] upsert done");
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
