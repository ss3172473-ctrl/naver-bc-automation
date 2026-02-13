import "dotenv/config";
import fs from "fs";
import path from "path";
import { PrismaClient } from "@prisma/client";
import { chromium } from "playwright-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
import type { Page, Frame } from "playwright";
import { contentHash } from "../src/lib/scrape/hash";
import { sendRowsToGoogleSheet } from "../src/lib/sheets";

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
  rawHtml: string;
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
  return `https://cafe.naver.com/${cafeId}`;
}

function getArticleFrame(page: Page): Frame | Page {
  return (
    page.frame({ name: "cafe_main" }) ||
    page.frames().find((f) => f.url().includes("ArticleRead")) ||
    page
  );
}

async function getClubId(page: Page, cafeId: string): Promise<string> {
  await page.goto(`https://m.cafe.naver.com/${cafeId}`, { waitUntil: "domcontentloaded", timeout: 35000 });
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
        `https://m.cafe.naver.com/ArticleRead.nhn?clubid=${encodeURIComponent(cafeNumericId)}` +
        `&articleid=${encodeURIComponent(String(item.articleId))}` +
        `&boardtype=${encodeURIComponent(item.boardType || "L")}`,
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

async function parsePost(page: Page, sourceUrl: string, cafeId: string, cafeName: string): Promise<ParsedPost | null> {
  console.log(`[parse] ${sourceUrl}`);
  await page.goto(sourceUrl, { waitUntil: "domcontentloaded", timeout: 35000 });
  await sleep(1200);

  if (page.url().includes("nidlogin")) {
    throw new Error("네이버 로그인 세션이 만료되었습니다.");
  }

  const frame = getArticleFrame(page);

  const title =
    (await frame.locator(".title_text, h3, h2").first().textContent().catch(() => null))?.trim() ||
    (await page.title());

  // User-requested mode: store all visible text on the page as-is (no cleaning/segmentation).
  const pageText = (await withTimeout(frame.locator("body").innerText(), 12000, "body innerText"))
    .trim();
  if (!pageText) return null;

  const contentText = pageText;
  const rawHtml = await withTimeout(frame.locator("body").innerHTML(), 12000, "body innerHTML");

  const fullText = pageText;
  const viewMatch = fullText.match(/조회\s*([\d,]+)/);
  const likeMatch = fullText.match(/좋아요\s*([\d,]+)/);
  const commentMatch = fullText.match(/댓글\s*([\d,]+)/);

  const authorName =
    (await frame.locator(".nickname, .nick, .author, .name").first().textContent().catch(() => null))?.trim() ||
    "";

  const publishedAttr = await frame.locator("time").first().getAttribute("datetime").catch(() => null);
  const publishedText = (await frame.locator("time").first().textContent().catch(() => null)) || null;
  const publishedAt = toDateSafe(publishedAttr || publishedText);

  const comments = await frame.$$eval("[class*='comment'], [id*='comment']", (elements) => {
    const rows: Array<{ authorName: string; body: string; likeCount: number }> = [];

    for (const el of elements) {
      const text = (el.textContent || "").trim();
      if (!text || text.length < 2 || text.length > 800) continue;

      const like = Number((text.match(/좋아요\s*([\d,]+)/)?.[1] || "0").replace(/[^\d]/g, "")) || 0;
      rows.push({
        authorName: "",
        body: text,
        likeCount: like,
      });

      if (rows.length >= 200) break;
    }

    return rows;
  }).catch(() => []);

  return {
    sourceUrl: page.url(),
    cafeId,
    cafeName,
    cafeUrl: getCafeUrl(cafeId),
    title: title || "",
    authorName,
    publishedAt,
    viewCount: asInt(viewMatch?.[1] || "0"),
    likeCount: asInt(likeMatch?.[1] || "0"),
    commentCount: asInt(commentMatch?.[1] || "0"),
    contentText,
    rawHtml,
    comments: comments.map((comment) => ({
      authorName: comment.authorName,
      body: comment.body,
      likeCount: comment.likeCount,
      writtenAt: null,
    })),
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

  if (!fs.existsSync(SESSION_FILE)) {
    throw new Error("카페 로그인 세션 파일이 없습니다. npm run cafe:login을 먼저 실행하세요.");
  }

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
    storageState: SESSION_FILE,
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

        const parsed = await parsePost(page, cand.url, cafeId, cafeName).catch(() => null);
        if (!parsed) continue;

        const normalizedForMatch = `${parsed.title}\n${parsed.contentText}`;
        if (!matchesAnyKeyword(normalizedForMatch, keywords)) {
          continue;
        }
        if (!isAllowedByWords(normalizedForMatch, includeWords, excludeWords)) {
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
    // Persist refreshed cookies set during scraping (prevents future redirects to login/join walls).
    await context.storageState({ path: SESSION_FILE }).catch(() => undefined);
    await context.close();
    await browser.close();
  }

  const filtered = clampByAutoThreshold(
    collected,
    job.useAutoFilter,
    job.minViewCount,
    job.minCommentCount
  );

  const finalPosts = filtered.slice(0, job.maxPosts);

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
  const commentRows = [] as Array<{
    jobId: string;
    sourceUrl: string;
    cafeId: string;
    cafeName: string;
    cafeUrl: string;
    commentAuthor: string;
    commentBody: string;
    commentLikeCount: number;
    commentWrittenAt: string;
  }>;

  for (const post of finalPosts) {
    const hash = contentHash(post.contentText);
    const existed = await prisma.scrapePost.findUnique({ where: { contentHash: hash } });
    if (existed) continue;

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

    for (const comment of post.comments) {
      await prisma.scrapeComment.create({
        data: {
          postId: created.id,
          authorName: comment.authorName,
          body: comment.body,
          likeCount: comment.likeCount,
          writtenAt: comment.writtenAt,
        },
      });

      commentRows.push({
        jobId,
        sourceUrl: post.sourceUrl,
        cafeId: post.cafeId,
        cafeName: post.cafeName,
        cafeUrl: post.cafeUrl,
        commentAuthor: comment.authorName,
        commentBody: comment.body,
        commentLikeCount: comment.likeCount,
        commentWrittenAt: comment.writtenAt?.toISOString() || "",
      });
    }

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
    await sendRowsToGoogleSheet(postRows, commentRows);
    syncedCount = postRows.length;
  } catch (error) {
    console.error("Google Sheet 동기화 실패:", error);
  }

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

    throw error;
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
