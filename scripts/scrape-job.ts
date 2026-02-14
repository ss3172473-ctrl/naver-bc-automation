import "dotenv/config";
import fs from "fs";
import path from "path";
import { PrismaClient } from "@prisma/client";
import { chromium } from "playwright-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
import type { Page, Frame } from "playwright";
import { contentHash } from "../src/lib/scrape/hash";
import { sendRowsToGoogleSheet } from "../src/lib/sheets";
import { decryptString } from "../src/lib/crypto";
import { telegramSendMessage } from "../src/lib/telegram";

chromium.use(StealthPlugin());

type ParsedComment = {
  authorName: string;
  body: string;
  likeCount: number;
  writtenAt: Date | null;
};

type ParsedPost = {
  sourceUrl: string;
  cafeId: string;
  cafeName: string;
  cafeUrl: string;
  title: string;
  authorName: string;
  publishedAt: Date | null;
  viewCount: number;
  likeCount: number;
  commentCount: number;
  contentText: string;
  rawHtml: string | null;
  comments: ParsedComment[];
};

type ArticleCandidate = {
  articleId: number;
  url: string;
  subject: string;
  readCount: number;
  commentCount: number;
  likeCount: number;
  boardType: string;
};

const prisma = new PrismaClient();
const SESSION_FILE =
  process.env.NAVER_CAFE_SESSION_FILE ||
  path.join(process.cwd(), "playwright", "storage", "naver-cafe-session.json");
const OUTPUT_DIR = path.join(process.cwd(), "outputs", "scrape-jobs");
const STORAGE_STATE_KEY = "naverCafeStorageStateEnc";

type StorageStateObject = { cookies: any[]; origins: any[] };

function isStorageStateObject(value: unknown): value is StorageStateObject {
  if (!value || typeof value !== "object") return false;
  const v = value as any;
  return Array.isArray(v.cookies) && Array.isArray(v.origins);
}

async function loadStorageState(): Promise<string | StorageStateObject> {
  // Local/dev: use the file-based storageState if it exists.
  if (SESSION_FILE && fs.existsSync(SESSION_FILE)) {
    return SESSION_FILE;
  }

  // Cloud/Worker: read encrypted storageState from DB Setting.
  const secret = process.env.APP_AUTH_SECRET || "";
  const row = await prisma.setting.findUnique({ where: { key: STORAGE_STATE_KEY } });
  if (!row?.value) {
    throw new Error(
      "네이버 카페 세션(storageState)이 없습니다. 대시보드에서 세션을 업로드하세요."
    );
  }
  const json = decryptString(row.value, secret);
  const parsed = JSON.parse(json);
  if (!isStorageStateObject(parsed)) {
    throw new Error("storageState JSON 포맷이 올바르지 않습니다. (cookies/origins 필요)");
  }
  return parsed;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | null = null;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timeout: ${label}`)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function asInt(input: string): number {
  const value = Number((input || "").replace(/[^\d]/g, ""));
  return Number.isFinite(value) ? value : 0;
}

function isAllowedByWords(text: string, includeWords: string[], excludeWords: string[]): boolean {
  const compact = text.replace(/\s+/g, "").toLowerCase();

  if (includeWords.length > 0) {
    const hit = includeWords.some((word) => compact.includes(word.toLowerCase()));
    if (!hit) return false;
  }

  if (excludeWords.length > 0) {
    const blocked = excludeWords.some((word) => compact.includes(word.toLowerCase()));
    if (blocked) return false;
  }

  return true;
}

function matchesAnyKeyword(text: string, keywords: string[]): boolean {
  const compact = text.replace(/\s+/g, "").toLowerCase();
  return keywords.some((kw) => compact.includes(kw.replace(/\s+/g, "").toLowerCase()));
}

function looksLikeJoinWall(text: string): boolean {
  const t = text.replace(/\s+/g, " ");
  const flags = [
    "카페에 가입하면 바로 글을 볼 수 있어요",
    "10초 만에 가입하기",
    "가입해 보세요",
    "멤버와 함께하는",
  ];
  return flags.some((f) => t.includes(f));
}

function cleanCafeText(text: string): string {
  const lines = text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

  const dropIfIncludes = [
    "본문 바로가기",
    "메뉴",
    "카페에 가입하면 바로 글을 볼 수 있어요",
    "가입해 보세요",
    "10초 만에 가입하기",
    "멤버와 함께하는",
    "최근 일주일 동안",
  ];

  const dropExact = new Set([
    "카페홈",
    "가입",
    "검색",
    "메뉴",
    "앱 열기",
    "기타 기능",
    "쪽지",
    "공유",
    "신고",
    "댓글",
    "전체글",
    "전체서비스",
  ]);

  const cleaned = lines.filter((l) => {
    if (dropExact.has(l)) return false;
    if (dropIfIncludes.some((p) => l.includes(p))) return false;
    if (/^\d+(\.\d+)?만명의 멤버/.test(l)) return false;
    if (/^최근 일주일 동안/.test(l)) return false;
    return true;
  });

  return cleaned.join("\n").trim();
}

function toDateSafe(value: string | null): Date | null {
  if (!value) return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed;
}

function clampByAutoThreshold(posts: ParsedPost[], useAutoFilter: boolean, minView: number | null, minComment: number | null): ParsedPost[] {
  if (!useAutoFilter && minView === null && minComment === null) {
    return posts;
  }

  let appliedMinView = minView;
  let appliedMinComment = minComment;

  if (useAutoFilter) {
    const sortedViews = posts.map((p) => p.viewCount).sort((a, b) => a - b);
    const sortedComments = posts.map((p) => p.commentCount).sort((a, b) => a - b);

    const mid = Math.floor(posts.length / 2);
    if (appliedMinView === null) appliedMinView = sortedViews[mid] || 0;
    if (appliedMinComment === null) appliedMinComment = sortedComments[mid] || 0;
  }

  return posts.filter((p) => {
    if (appliedMinView !== null && p.viewCount < appliedMinView) return false;
    if (appliedMinComment !== null && p.commentCount < appliedMinComment) return false;
    return true;
  });
}

function getCafeUrl(cafeId: string): string {
  if (/^\d+$/.test(cafeId)) {
    return `https://cafe.naver.com/ca-fe/cafes/${cafeId}`;
  }
  return `https://cafe.naver.com/${cafeId}`;
}

function getArticleFrame(page: Page): Frame | Page {
  return (
    page.frames().find((f) => f.url().includes("ArticleRead")) ||
    page.frame({ name: "cafe_main" }) ||
    page.frame({ name: "mainFrame" }) ||
    page
  );
}

function getQueryParam(url: string, key: string): string | null {
  try {
    const u = new URL(url);
    return u.searchParams.get(key);
  } catch {
    return null;
  }
}

function getArticleIdFromUrl(url: string): string | null {
  const q = getQueryParam(url, "articleid");
  if (q) return q;
  const m = String(url || "").match(/\/articles\/(\d+)/i);
  return m?.[1] || null;
}

async function getClubId(page: Page, cafeId: string): Promise<string> {
  // If the "cafeId" is already numeric, treat it as clubId.
  if (/^\d+$/.test(cafeId)) {
    return cafeId;
  }

  // Use desktop cafe home because we will scrape desktop pages.
  await page.goto(getCafeUrl(cafeId), { waitUntil: "domcontentloaded", timeout: 35000 });
  await sleep(1200);

  const candidates = page
    .frames()
    .map((f) => f.url())
    .concat([page.url()]);

  for (const url of candidates) {
    try {
      const u = new URL(url);
      const clubid = u.searchParams.get("clubid");
      if (clubid) return clubid;
    } catch {
      // ignore
    }
  }

  const html = await page.content();
  const match =
    html.match(/clubid=(\d+)/i) ||
    html.match(/cafeId=(\d+)/i) ||
    html.match(/\/cafes\/(\d+)\//i);
  if (match?.[1]) return match[1];

  throw new Error(`clubid를 찾지 못했습니다. cafeId=${cafeId}`);
}

async function fetchCandidatesFromSearchApi(
  page: Page,
  cafeNumericId: string,
  keyword: string,
  pageNum: number
): Promise<ArticleCandidate[]> {
  const url =
    `https://apis.naver.com/cafe-web/cafe-mobile/CafeMobileWebArticleSearchListV4` +
    `?cafeId=${encodeURIComponent(cafeNumericId)}` +
    `&query=${encodeURIComponent(keyword)}` +
    `&searchBy=1&sortBy=date&page=${pageNum}&perPage=20` +
    `&adUnit=MW_CAFE_BOARD&ad=true`;

  const resp = await page.request.get(url);
  if (!resp.ok()) {
    throw new Error(`Search API failed: ${resp.status()} ${url}`);
  }

  const json = await resp.json();
  const list = json?.message?.result?.articleList || [];

  const rows: ArticleCandidate[] = [];
  for (const row of list) {
    if (row?.type !== "ARTICLE") continue;
    const item = row.item;
    if (!item?.articleId) continue;

    rows.push({
      articleId: Number(item.articleId),
      url:
        // Prefer the newer PC article URL format (reduces iframe/wrapper issues).
        `https://cafe.naver.com/ca-fe/cafes/${encodeURIComponent(cafeNumericId)}` +
        `/articles/${encodeURIComponent(String(item.articleId))}` +
        `?boardType=${encodeURIComponent(item.boardType || "L")}`,
      subject: String(item.subject || ""),
      readCount: Number(item.readCount || 0),
      commentCount: Number(item.commentCount || 0),
      likeCount: Number(item.likeItCount || 0),
      boardType: String(item.boardType || "L"),
    });
  }

  return rows;
}

async function collectArticleCandidates(
  page: Page,
  cafeId: string,
  keywords: string[],
  maxUrls: number
): Promise<{ cafeNumericId: string; candidates: ArticleCandidate[] }> {
  const seen = new Set<number>();
  const candidates: ArticleCandidate[] = [];
  const cafeNumericId = await getClubId(page, cafeId);
  console.log(`[cafe] cafeId=${cafeId} cafeNumericId=${cafeNumericId}`);

  for (const keyword of keywords) {
    console.log(`[collect] cafe=${cafeId} keyword=${keyword}`);
    for (let pageNum = 1; pageNum <= 5 && candidates.length < maxUrls; pageNum += 1) {
      const rows = await fetchCandidatesFromSearchApi(page, cafeNumericId, keyword, pageNum);
      if (rows.length === 0) break;

      for (const row of rows) {
        if (seen.has(row.articleId)) continue;
        seen.add(row.articleId);
        candidates.push(row);
        if (candidates.length >= maxUrls) break;
      }
    }

    if (candidates.length >= maxUrls) break;
    await sleep(250);
  }

  console.log(`[collect] cafe=${cafeId} candidates=${candidates.length}`);
  return { cafeNumericId, candidates };
}

async function parsePost(
  page: Page,
  sourceUrl: string,
  cafeId: string,
  cafeName: string,
  fallbackTitle: string
): Promise<ParsedPost | null> {
  console.log(`[parse] ${sourceUrl}`);
  await withTimeout(
    page.goto(sourceUrl, { waitUntil: "domcontentloaded", timeout: 35000 }),
    45000,
    "page.goto"
  );
  await sleep(1200);
  console.log(`[parse] loaded url=${page.url()}`);

  if (page.url().includes("nidlogin")) {
    throw new Error("네이버 로그인 세션이 만료되었습니다.");
  }

  // Prefer the real ArticleRead iframe (본문이 들어있는 프레임). Outer wrapper pages often contain menus/lists.
  const expectedArticleId = getArticleIdFromUrl(sourceUrl);
  let frame: Frame | Page = page;
  if (expectedArticleId) {
    const match = page
      .frames()
      .find((f) => f.url().includes("ArticleRead") && f.url().includes(`articleid=${expectedArticleId}`));
    if (match) {
      frame = match;
      console.log(`[parse] using ArticleRead frame url=${match.url()}`);
    } else {
      // Some pages encode the ArticleRead URL; try looser match.
      const loose = page.frames().find((f) => f.url().includes(`articleid=${expectedArticleId}`));
      if (loose) {
        frame = loose;
        console.log(`[parse] using loose articleid frame url=${loose.url()}`);
      } else {
        frame = getArticleFrame(page);
        console.log("[parse] ArticleRead frame not found; fallback to heuristic frame");
      }
    }
  } else {
    frame = getArticleFrame(page);
    console.log("[parse] expectedArticleId missing; using heuristic frame");
  }

  // User request: we mainly need full page text. Title/author/date are optional metadata.
  // Use the search API subject as the title to avoid DOM selector fragility.
  const title = (fallbackTitle || "").trim() || (await page.title());

  // Expand common "더보기/펼치기" UI so long posts aren't truncated in innerText.
  // This is not a bypass; it's the same action a user would do before copy/paste.
  const expandRegex = /더보기|펼쳐|전체\s*보기|전체\s*글|more/i;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const candidates = frame.locator("button, a, span").filter({ hasText: expandRegex });
    const count = await candidates.count().catch(() => 0);
    if (count === 0) break;

    const clicks = Math.min(count, 6);
    for (let i = 0; i < clicks; i += 1) {
      await candidates.nth(i).click({ timeout: 1500 }).catch(() => undefined);
      await sleep(200);
    }

    await frame
      .evaluate(() => {
        window.scrollTo(0, document.body.scrollHeight);
      })
      .catch(() => undefined);
    await sleep(400);
  }

  console.log("[parse] extracting body innerText");
  const pageText = (await withTimeout(frame.locator("body").innerText(), 25000, "body innerText")).trim();
  if (!pageText) return null;
  if (looksLikeJoinWall(pageText)) return null;

  const contentText = pageText;
  console.log(`[parse] extracted text len=${contentText.length}`);
  // User-requested mode: only archive visible text. HTML extraction is slow/flaky on Naver Cafe PC and
  // can cause timeouts; skip it to improve reliability.
  const rawHtml: string | null = null;

  // Skip author/date parsing (unstable selectors; not needed for the user's sheet workflow).
  const authorName = "";
  const publishedAt = null;

  // User request: store only post page full text. Do not parse/store comments in Sheets.
  const comments: ParsedComment[] = [];

  return {
    sourceUrl: page.url(),
    cafeId,
    cafeName,
    cafeUrl: getCafeUrl(cafeId),
    title: title || "",
    authorName,
    publishedAt,
    viewCount: 0,
    likeCount: 0,
    commentCount: 0,
    contentText,
    rawHtml,
    comments,
  };
}

function writeCsv(jobId: string, posts: ParsedPost[]): string {
  if (!fs.existsSync(OUTPUT_DIR)) {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  }

  const filePath = path.join(OUTPUT_DIR, `job-${jobId}-${Date.now()}.csv`);
  const header = [
    "sourceUrl",
    "cafeId",
    "cafeName",
    "title",
    "authorName",
    "publishedAt",
    "viewCount",
    "likeCount",
    "commentCount",
    "contentText",
  ];

  const rows = posts.map((post) =>
    [
      post.sourceUrl,
      post.cafeId,
      post.cafeName,
      post.title,
      post.authorName,
      post.publishedAt?.toISOString() || "",
      String(post.viewCount),
      String(post.likeCount),
      String(post.commentCount),
      post.contentText.replace(/\s+/g, " ").slice(0, 5000),
    ]
      .map((cell) => `"${String(cell).replace(/"/g, '""')}"`)
      .join(",")
  );

  fs.writeFileSync(filePath, [header.join(","), ...rows].join("\n"), "utf8");
  return filePath;
}

async function run(jobId: string) {
  const job = await prisma.scrapeJob.findUnique({ where: { id: jobId } });
  if (!job) throw new Error("작업이 존재하지 않습니다.");
  const storageState = await loadStorageState();

  await prisma.scrapeJob.update({
    where: { id: jobId },
    data: { status: "RUNNING", startedAt: new Date(), errorMessage: null },
  });

  const keywords = JSON.parse(job.keywords || "[]") as string[];
  const includeWords = JSON.parse(job.includeWords || "[]") as string[];
  const excludeWords = JSON.parse(job.excludeWords || "[]") as string[];
  const cafeIds = JSON.parse(job.cafeIds || "[]") as string[];
  const cafeNames = JSON.parse(job.cafeNames || "[]") as string[];

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
  await page.addInitScript(`
    Object.defineProperty(navigator, 'webdriver', { get: () => false });
  `);
  const collected: ParsedPost[] = [];

  try {
    for (let i = 0; i < cafeIds.length; i += 1) {
      const cafeId = cafeIds[i];
      const cafeName = cafeNames[i] || cafeId;

      const { candidates } = await collectArticleCandidates(
        page,
        cafeId,
        keywords,
        Math.max(10, Math.ceil(job.maxPosts / Math.max(1, cafeIds.length)))
      );

      for (const cand of candidates) {
        if (collected.length >= job.maxPosts) break;

        // Early filter by counts from list API (fast).
        if (job.minViewCount !== null && cand.readCount < job.minViewCount) continue;
        if (job.minCommentCount !== null && cand.commentCount < job.minCommentCount) continue;

        const parsed = await withTimeout(
          parsePost(page, cand.url, cafeId, cafeName, cand.subject),
          90000,
          "parsePost overall"
        ).catch(() => null);
        if (!parsed) continue;

        // Use counts from the search API list (more reliable than page text parsing).
        parsed.viewCount = cand.readCount;
        parsed.likeCount = cand.likeCount;
        parsed.commentCount = cand.commentCount;

        // Candidate list already comes from Naver's keyword search API.
        // Re-checking keywords against parsed DOM text can incorrectly drop valid results
        // (e.g., when the extracted title is missing or UI text dominates).
        // Keep include/exclude word filters only.
        if (!parsed.title || parsed.title.trim().length < 2) {
          parsed.title = cand.subject || parsed.title;
        }

        const normalizedForFilter = `${cand.subject}\n${parsed.title}\n${parsed.contentText}`;
        if (!isAllowedByWords(normalizedForFilter, includeWords, excludeWords)) {
          continue;
        }

        if (job.fromDate && parsed.publishedAt && parsed.publishedAt < job.fromDate) continue;
        if (job.toDate && parsed.publishedAt && parsed.publishedAt > job.toDate) continue;

        collected.push(parsed);
        await sleep(900 + Math.floor(Math.random() * 600));
      }

      if (collected.length >= job.maxPosts) break;
    }
  } finally {
    console.log(`[run] collected=${collected.length} (before close)`);
    // Persist refreshed cookies set during scraping (dev/local file-mode only).
    if (typeof storageState === "string") {
      await context.storageState({ path: storageState }).catch(() => undefined);
    }
    console.log("[run] closing context");
    await withTimeout(context.close(), 20000, "context.close").catch((e) => {
      console.error("[run] context.close failed:", e);
    });
    console.log("[run] closing browser");
    await withTimeout(browser.close(), 20000, "browser.close").catch((e) => {
      console.error("[run] browser.close failed:", e);
    });
  }

  const filtered = clampByAutoThreshold(
    collected,
    job.useAutoFilter,
    job.minViewCount,
    job.minCommentCount
  );

  const finalPosts = filtered.slice(0, job.maxPosts);
  console.log(`[save] finalPosts=${finalPosts.length}`);

  let savedCount = 0;
  const postRows = [] as Array<{
    jobId: string;
    sourceUrl: string;
    cafeId: string;
    cafeName: string;
    cafeUrl: string;
    title: string;
    authorName: string;
    publishedAt: string;
    viewCount: number;
    likeCount: number;
    commentCount: number;
    contentText: string;
  }>;
  const commentRows = [] as Array<any>;

  for (const post of finalPosts) {
    // Dedupe by URL first (more reliable than "all-page text" hashing, which can be UI-heavy).
    const existedByUrl = await prisma.scrapePost.findFirst({ where: { sourceUrl: post.sourceUrl } });
    if (existedByUrl) {
      console.log(`[save] skip (existing url) ${post.sourceUrl}`);
      continue;
    }

    // Also keep a content hash for reference/secondary dedupe, but include URL to avoid false positives
    // when multiple posts share similar UI boilerplate text.
    const hash = contentHash(`${post.sourceUrl}\n${post.contentText}`);
    console.log(`[save] creating post hash=${hash.slice(0, 10)} len=${post.contentText.length}`);

    const created = await prisma.scrapePost.create({
      data: {
        jobId,
        sourceUrl: post.sourceUrl,
        cafeId: post.cafeId,
        cafeName: post.cafeName,
        cafeUrl: post.cafeUrl,
        title: post.title,
        authorName: post.authorName,
        publishedAt: post.publishedAt,
        viewCount: post.viewCount,
        likeCount: post.likeCount,
        commentCount: post.commentCount,
        contentText: post.contentText,
        contentHash: hash,
        rawHtml: post.rawHtml,
      },
    });

    // comments disabled by user request

    postRows.push({
      jobId,
      sourceUrl: post.sourceUrl,
      cafeId: post.cafeId,
      cafeName: post.cafeName,
      cafeUrl: post.cafeUrl,
      title: post.title,
      authorName: post.authorName,
      publishedAt: post.publishedAt?.toISOString() || "",
      viewCount: post.viewCount,
      likeCount: post.likeCount,
      commentCount: post.commentCount,
      contentText: post.contentText,
    });

    savedCount += 1;
  }

  const csvPath = writeCsv(jobId, finalPosts);

  let syncedCount = 0;
  try {
    console.log(`[sheet] sending postRows=${postRows.length}`);
    await sendRowsToGoogleSheet(postRows, commentRows);
    syncedCount = postRows.length;
    console.log(`[sheet] sent ok count=${syncedCount}`);
  } catch (error) {
    console.error("Google Sheet 동기화 실패:", error);
  }

  console.log(`[job] updating SUCCESS saved=${savedCount} synced=${syncedCount}`);
  await prisma.scrapeJob.update({
    where: { id: jobId },
    data: {
      status: "SUCCESS",
      resultCount: savedCount,
      sheetSynced: syncedCount,
      resultPath: csvPath,
      completedAt: new Date(),
    },
  });

  if (job.notifyChatId) {
    await telegramSendMessage(
      job.notifyChatId,
      `스크랩 완료\njobId=${jobId}\n저장=${savedCount}개\nSheets 전송=${syncedCount}개`,
      { disableWebPagePreview: true }
    ).catch((error) => {
      console.error("텔레그램 알림 실패:", error);
    });
  }
}

async function main() {
  const jobId = process.argv[2];
  if (!jobId) {
    throw new Error("jobId가 필요합니다. usage: npm run scrape:job -- <jobId>");
  }

  try {
    await run(jobId);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await prisma.scrapeJob.update({
      where: { id: jobId },
      data: {
        status: "FAILED",
        errorMessage: message,
        completedAt: new Date(),
      },
    }).catch(() => undefined);

    const job = await prisma.scrapeJob.findUnique({ where: { id: jobId } }).catch(() => null);
    if (job?.notifyChatId) {
      await telegramSendMessage(
        job.notifyChatId,
        `스크랩 실패\njobId=${jobId}\n에러=${message}`,
        { disableWebPagePreview: true }
      ).catch((err) => console.error("텔레그램 실패 알림 실패:", err));
    }

    throw error;
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
