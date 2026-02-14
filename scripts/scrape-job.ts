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
  addedAt: Date | null;
  queryKeyword: string;
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

function parseJsonStringArray(raw: unknown): string[] {
  if (!raw) return [];
  if (Array.isArray(raw)) {
    return raw.map((v) => String(v || "").trim()).filter(Boolean);
  }
  const s = String(raw).trim();
  if (!s) return [];
  try {
    const parsed = JSON.parse(s);
    if (!Array.isArray(parsed)) return [];
    return parsed.map((v: any) => String(v || "").trim()).filter(Boolean);
  } catch {
    // Fallback for legacy/invalid values: treat as comma list.
    return s
      .split(",")
      .map((v) => v.trim().replace(/\s+/g, ""))
      .filter(Boolean);
  }
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

function includesKeyword(text: string, keyword: string): boolean {
  const compact = String(text || "").replace(/\s+/g, "").toLowerCase();
  const kw = String(keyword || "").replace(/\s+/g, "").toLowerCase();
  if (!kw) return true;
  return compact.includes(kw);
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

function looksLikePermissionWall(text: string): boolean {
  const t = text.replace(/\s+/g, " ");
  const flags = [
    "등급이 되시면 읽기가 가능한 게시판",
    "등업에 관련된",
    "등업 신청",
    "등급이시며",
    "카페의 멤버 등급",
    "자동등업",
  ];
  const hit = flags.filter((f) => t.includes(f)).length;
  return hit >= 2;
}

function looksLikeProfileOrPostList(text: string): boolean {
  const t = text.replace(/\s+/g, " ");
  const flags = [
    "이주의 인기멤버",
    "방문",
    "작성글",
    "구독멤버",
    "작성글 댓글단 글",
    "게시물 목록",
    "제목",
    "작성일",
    "페이징 이동",
    "글쓰기",
  ];
  const hit = flags.filter((f) => t.includes(f)).length;
  return hit >= 4;
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
    "이주의 인기멤버",
    "작성글 댓글단 글",
    "게시물 목록",
    "페이징 이동",
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
    "글쓰기",
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

function isProbablyCafeMenuUrl(url: string): boolean {
  const u = String(url || "");
  // Examples:
  // https://cafe.naver.com/f-e/cafes/<id>/menus/0?... (내소식/메뉴 등)
  // https://cafe.naver.com/ca-fe/cafes/<id>/menus/...
  return /\/menus\//i.test(u) || /\/mycafe/i.test(u) || /\/mynews/i.test(u);
}

async function waitForCafeMainFrame(page: Page, ms: number): Promise<Frame | null> {
  const start = Date.now();
  while (Date.now() - start < ms) {
    const f = page.frame({ name: "cafe_main" }) || page.frame({ name: "mainFrame" }) || null;
    if (f) {
      const url = String(f.url?.() || "");
      if (url && url !== "about:blank") return f;
      // Sometimes the frame exists early with about:blank. Wait until it actually contains article DOM.
      const hasContent = await f.locator("div.se-main-container, div.article_viewer").count().catch(() => 0);
      if (hasContent > 0) return f;
    }
    await sleep(150);
  }
  return null;
}

async function extractBestText(target: Frame | Page): Promise<string> {
  // Prefer known post body containers (PC web). We still fall back to body.innerText if selectors fail.
  const selectors = [
    // SmartEditor 3
    "div.se-main-container",
    "div.se-viewer",
    // Legacy / other renderers
    "div.article_viewer",
    "div.ContentRenderer",
    "div.ArticleContentBox",
    "#tbody",
    // Last resort but still inside the document
    "article",
  ];

  // Wait briefly for any plausible content node to appear.
  await (target as any)
    .waitForSelector(selectors.join(", "), { timeout: 15000 })
    .catch(() => undefined);

  let best = "";
  for (const sel of selectors) {
    try {
      const loc = (target as any).locator(sel).first();
      const count = await loc.count().catch(() => 0);
      if (count === 0) continue;
      const txt = String(await withTimeout(loc.innerText(), 15000, `innerText ${sel}`)).trim();
      if (txt.length > best.length) best = txt;
    } catch {
      // ignore
    }
  }

  if (best.trim().length >= 30) return best.trim();

  // Fallback: whole document text (may include UI if we failed to locate the article container).
  const pageText = String(
    await withTimeout((target as any).locator("body").innerText(), 25000, "body innerText")
  ).trim();
  return pageText;
}

async function extractPostBodyText(target: Frame | Page): Promise<string> {
  // Try to focus on actual post body containers first.
  // Return raw visible text (no heavy cleaning) so the user gets "what they can see" for archiving.
  await (target as any)
    .waitForSelector("div.se-main-container, div.article_viewer, #tbody", { timeout: 15000 })
    .catch(() => undefined);

  const selectors = [
    "div.se-main-container",
    "div.se-viewer",
    "div.article_viewer",
    "div.ContentRenderer",
    "#tbody",
  ];

  for (const sel of selectors) {
    try {
      const loc = (target as any).locator(sel);
      const count = await loc.count().catch(() => 0);
      if (count === 0) continue;

      // Some pages may render multiple matching nodes (hidden/duplicated). Pick the best candidate.
      let best = "";
      const take = Math.min(count, 4);
      for (let i = 0; i < take; i += 1) {
        const txt = String(
          await withTimeout(loc.nth(i).innerText(), 20000, `body innerText ${sel}#${i}`)
        ).trim();
        if (!txt) continue;
        if (looksLikePermissionWall(txt)) continue;
        if (looksLikeProfileOrPostList(txt)) continue;
        if (txt.length > best.length) best = txt;
      }

      if (best) return best;
    } catch {
      // ignore
    }
  }

  return "";
}

async function extractSourceLineText(target: Frame | Page): Promise<string> {
  // Some posts show a source/citation line like:
  // [출처] ... | 작성자 ...
  const loc = (target as any).locator("text=/\\[출처\\]/").first();
  const count = await loc.count().catch(() => 0);
  if (count === 0) return "";
  const txt = String(await loc.innerText().catch(() => "")).trim();
  return txt;
}

async function extractCommentsText(target: Frame | Page): Promise<string> {
  // Scroll to the bottom to trigger comment rendering/lazy-load.
  await (target as any)
    .evaluate(() => window.scrollTo(0, document.body.scrollHeight))
    .catch(() => undefined);
  await sleep(600);

  // Some pages require opening the comments panel, but on others this button toggles the panel.
  // Click only if we don't already see comment items.
  await (target as any)
    .waitForSelector(".CommentBox, .comment_list, .CommentItem", { timeout: 12000 })
    .catch(() => undefined);

  const initialItems = await (target as any)
    .locator(".CommentItem, li.CommentItem")
    .count()
    .catch(() => 0);
  if (initialItems === 0) {
    await (target as any)
      .locator("button.button_comment, a.button_comment")
      .first()
      .click({ timeout: 1200 })
      .catch(() => undefined);
    await sleep(400);
    await (target as any)
      .waitForSelector(".CommentItem, li.CommentItem", { timeout: 12000 })
      .catch(() => undefined);
  }

  const commentRoot = (target as any).locator(".CommentBox, .comment_list").first();
  const hasRoot = (await commentRoot.count().catch(() => 0)) > 0;
  const scope = hasRoot ? commentRoot : (target as any);

  // Expand comment "더보기" buttons if present.
  const expandRegex = /댓글\s*더보기|이전\s*댓글|더보기|more/i;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const btn = scope
      .locator("button, a, span")
      .filter({ hasText: expandRegex })
      .first();
    const count = await btn.count().catch(() => 0);
    if (count === 0) break;
    await btn.click({ timeout: 1500 }).catch(() => undefined);
    await sleep(250);
  }

  const itemSelectors = [
    ".CommentItem",
    "li.CommentItem",
    "[class*='CommentItem']",
    "li[class*='comment']",
  ];

  for (const sel of itemSelectors) {
    const items = scope.locator(sel);
    const n = await items.count().catch(() => 0);
    if (n <= 0) continue;
    const take = Math.min(n, 200);
    const parts: string[] = [];
    for (let i = 0; i < take; i += 1) {
      const item = items.nth(i);
      // Use the whole comment item's visible text so we keep:
      // nickname, comment body, timestamp, and "답글쓰기" (like copy/paste on screen).
      const raw = String(await item.innerText().catch(() => "")).trim();
      if (raw) parts.push(raw);
    }
    const joined = parts.join("\n\n").trim();
    if (joined.length >= 10) return joined;
  }

  return "";
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

function getClubIdFromUrl(url: string): string | null {
  const q = getQueryParam(url, "clubid") || getQueryParam(url, "cafeId");
  if (q) return q;
  const m = String(url || "").match(/\/cafes\/(\d+)/i);
  return m?.[1] || null;
}

function buildFeArticleUrl(clubid: string, articleid: string): string {
  return (
    `https://cafe.naver.com/ca-fe/cafes/${encodeURIComponent(clubid)}` +
    `/articles/${encodeURIComponent(articleid)}`
  );
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

    // Search API subjects can contain highlight markup like <em>...</em>.
    const subject = String(item.subject || "").replace(/<[^>]*>/g, "");
    const addedAt = item.addDate ? new Date(String(item.addDate)) : null;
    const addedAtSafe =
      addedAt && !Number.isNaN(addedAt.getTime()) ? addedAt : null;

    rows.push({
      articleId: Number(item.articleId),
      url:
        // PC article read URL is the most reliable for extracting 본문 text (it uses the cafe_main frame).
        `https://cafe.naver.com/ArticleRead.nhn` +
        `?clubid=${encodeURIComponent(cafeNumericId)}` +
        `&articleid=${encodeURIComponent(String(item.articleId))}`,
      subject,
      readCount: Number(item.readCount || 0),
      commentCount: Number(item.commentCount || 0),
      likeCount: Number(item.likeItCount || 0),
      boardType: String(item.boardType || "L"),
      addedAt: addedAtSafe,
      queryKeyword: keyword,
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

  // Requirement: for each selected cafe, search each keyword at least once.
  // To keep the Worker stable even with huge keyword lists, we only call the search API once per keyword (page=1).
  // We still cap how many candidates we keep in memory, but we do not skip the search calls.
  const perKeywordTake = Math.min(20, Math.max(1, Math.floor(maxUrls / Math.max(1, keywords.length))));

  for (const keyword of keywords) {
    console.log(`[collect] cafe=${cafeId} keyword=${keyword}`);
    const rows = await fetchCandidatesFromSearchApi(page, cafeNumericId, keyword, 1).catch(() => []);
    const take = Math.max(1, Math.min(perKeywordTake, rows.length));
    for (let i = 0; i < take; i += 1) {
      const row = rows[i];
      if (!row) continue;
      if (seen.has(row.articleId)) continue;
      seen.add(row.articleId);
      if (candidates.length < maxUrls) {
        candidates.push(row);
      }
    }
    await sleep(180);
  }

  console.log(`[collect] cafe=${cafeId} candidates=${candidates.length}`);
  return { cafeNumericId, candidates };
}

async function parsePost(
  page: Page,
  sourceUrl: string,
  cafeId: string,
  cafeNumericId: string,
  cafeName: string,
  fallbackTitle: string
): Promise<ParsedPost | null> {
  console.log(`[parse] ${sourceUrl}`);
  const canonicalUrl = sourceUrl;

  // Prefer the newer FE article URL: it avoids iframe/wrapper issues and exposes a simpler DOM for body/comments.
  const expectedArticleId = getArticleIdFromUrl(canonicalUrl);
  const feUrl = expectedArticleId ? buildFeArticleUrl(cafeNumericId, expectedArticleId) : null;
  const primaryUrl = feUrl || canonicalUrl;

  await withTimeout(page.goto(primaryUrl, { waitUntil: "domcontentloaded", timeout: 35000 }), 45000, "page.goto");
  await sleep(1200);
  console.log(`[parse] loaded url=${page.url()}`);

  if (page.url().includes("nidlogin")) {
    throw new Error("네이버 로그인 세션이 만료되었습니다.");
  }

  // For FE URL we can extract directly from the page (no iframe). For legacy URLs, fall back to cafe_main.
  let frame: Frame | Page = page;
  if (!feUrl) {
    const cafeMain = await waitForCafeMainFrame(page, 8000);
    if (cafeMain) {
      frame = cafeMain;
      console.log(`[parse] using cafe_main frame url=${cafeMain.url()}`);
    } else if (expectedArticleId) {
      const match = page
        .frames()
        .find((f) => f.url().includes("ArticleRead") && f.url().includes(`articleid=${expectedArticleId}`));
      if (match) {
        frame = match;
        console.log(`[parse] using ArticleRead frame url=${match.url()}`);
      } else {
        frame = getArticleFrame(page);
        console.log("[parse] cafe_main not found; using heuristic frame");
      }
    } else {
      frame = getArticleFrame(page);
      console.log("[parse] expectedArticleId missing; using heuristic frame");
    }
  } else {
    console.log("[parse] using FE article page (no iframe)");
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

  // Always scroll to ensure article body/comments are rendered before extraction.
  await frame
    .evaluate(() => {
      window.scrollTo(0, document.body.scrollHeight);
    })
    .catch(() => undefined);
  await sleep(800);

  console.log("[parse] extracting post body/comments text");
  const bodyTextRaw = await extractPostBodyText(frame);
  const bodyText = String(bodyTextRaw || "").trim();
  const sourceLine = String(await extractSourceLineText(frame).catch(() => "")).trim();
  let commentsTextRaw = await extractCommentsText(frame);
  let commentsText = String(commentsTextRaw || "").trim();

  // If we didn't start on FE URL (legacy path), comments may still be in the FE page.
  if (!commentsText && !feUrl && expectedArticleId) {
    const retryUrl = buildFeArticleUrl(cafeNumericId, expectedArticleId);
    console.log(`[parse] retrying comments via FE url: ${retryUrl}`);
    await withTimeout(page.goto(retryUrl, { waitUntil: "domcontentloaded", timeout: 35000 }), 45000, "page.goto feUrl")
      .catch(() => undefined);
    await sleep(1200);
    console.log(`[parse] FE loaded url=${page.url()}`);
    commentsTextRaw = await extractCommentsText(page);
    commentsText = String(commentsTextRaw || "").trim();
  }

  const joinedForChecks = `${bodyText}\n${commentsText}`.trim();
  if (!joinedForChecks) return null;
  if (looksLikeJoinWall(joinedForChecks)) return null;
  if (looksLikePermissionWall(joinedForChecks)) return null;
  if (looksLikeProfileOrPostList(joinedForChecks) && !commentsText) return null;

  const bodyPlusSource = sourceLine && !bodyText.includes(sourceLine) ? `${bodyText}\n\n${sourceLine}`.trim() : bodyText;
  const contentText = commentsText ? `${bodyPlusSource}\n\n[댓글]\n${commentsText}`.trim() : bodyPlusSource;
  console.log(
    `[parse] extracted body len=${bodyText.length} comments len=${commentsText.length} total len=${contentText.length}`
  );
  // User-requested mode: only archive visible text. HTML extraction is slow/flaky on Naver Cafe PC and
  // can cause timeouts; skip it to improve reliability.
  const rawHtml: string | null = null;

  // Skip author/date parsing (unstable selectors; not needed for the user's sheet workflow).
  const authorName = "";
  const publishedAt = null;

  // We store combined text in contentText (body + comments) for Sheets.
  const comments: ParsedComment[] = [];

  return {
    // Keep the canonical post link (do not store redirected menu URLs).
    sourceUrl: canonicalUrl,
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

  const keywords = parseJsonStringArray(job.keywords);
  const directUrls = parseJsonStringArray(job.directUrls);
  const includeWords = parseJsonStringArray(job.includeWords);
  const excludeWords = parseJsonStringArray(job.excludeWords);
  const cafeIds = parseJsonStringArray(job.cafeIds);
  const cafeNames = parseJsonStringArray(job.cafeNames);

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
    if (Array.isArray(directUrls) && directUrls.length > 0) {
      console.log(`[run] directUrls mode urls=${directUrls.length}`);
      for (const url of directUrls) {
        if (collected.length >= job.maxPosts) break;
        const clubid = getClubIdFromUrl(url) || "";
        const parsed = await withTimeout(
          parsePost(page, url, clubid || "direct", clubid || "direct", clubid || "direct", ""),
          90000,
          "parsePost overall"
        ).catch(() => null);
        if (!parsed) continue;
        const normalizedForFilter = `${parsed.title}\n${parsed.contentText}`;
        if (!isAllowedByWords(normalizedForFilter, includeWords, excludeWords)) {
          continue;
        }
        collected.push(parsed);
        await sleep(900 + Math.floor(Math.random() * 600));
      }
    } else {
      for (let i = 0; i < cafeIds.length; i += 1) {
        const cafeId = cafeIds[i];
        const cafeName = cafeNames[i] || cafeId;

        const alreadyEnough = collected.length >= job.maxPosts;
        const { cafeNumericId, candidates } = await collectArticleCandidates(
          page,
          cafeId,
          keywords,
          // Candidate cap per cafe (keep stable even with many keywords).
          alreadyEnough ? 1 : Math.min(200, Math.max(40, Math.ceil(job.maxPosts * 4)))
        );

        // Requirement: search each keyword once per selected cafe.
        // Even if we've already collected enough posts, we still execute the keyword search pass above.
        if (alreadyEnough) {
          console.log(`[run] maxPosts reached; skipping parse for cafe=${cafeId} (search pass done)`);
          continue;
        }

        for (const cand of candidates) {
          if (collected.length >= job.maxPosts) break;

          // Fast date filter from search API (more reliable than DOM parsing).
          if (job.fromDate && cand.addedAt && cand.addedAt < job.fromDate) continue;
          if (job.toDate && cand.addedAt && cand.addedAt > job.toDate) continue;

          // Early filter by counts from list API (fast).
          if (job.minViewCount !== null && cand.readCount < job.minViewCount) continue;
          if (job.minCommentCount !== null && cand.commentCount < job.minCommentCount) continue;

        const parsed = await withTimeout(
          parsePost(page, cand.url, cafeId, cafeNumericId, cafeName, cand.subject),
          90000,
          "parsePost overall"
        ).catch(() => null);
        if (!parsed) continue;

        // Keyword relevance check (defensive):
        // Even though candidates come from the keyword search API, we verify the keyword is present in
        // the extracted body/title to avoid unrelated posts slipping in due to UI text or API quirks.
        const normalizedForKeywordCheck = `${cand.subject}\n${parsed.title}\n${parsed.contentText}`;
        if (!includesKeyword(normalizedForKeywordCheck, cand.queryKeyword)) {
          console.log(
            `[filter] drop keyword_miss kw=${cand.queryKeyword} url=${cand.url} title=${(parsed.title || "").slice(0, 60)}`
          );
          continue;
        }

        // Use counts from the search API list (more reliable than page text parsing).
        parsed.viewCount = cand.readCount;
        parsed.likeCount = cand.likeCount;
        parsed.commentCount = cand.commentCount;
        parsed.publishedAt = cand.addedAt;

          if (!parsed.title || parsed.title.trim().length < 2) {
            parsed.title = cand.subject || parsed.title;
          }

          const normalizedForFilter = `${cand.subject}\n${parsed.title}\n${parsed.contentText}`;
          if (!isAllowedByWords(normalizedForFilter, includeWords, excludeWords)) {
            continue;
          }

          collected.push(parsed);
          await sleep(900 + Math.floor(Math.random() * 600));
        }
      }
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
    // Also keep a content hash for reference/secondary dedupe, but include URL to avoid false positives
    // when multiple posts share similar UI boilerplate text.
    const hash = contentHash(`${post.sourceUrl}\n${post.contentText}`);

    // Dedupe by (url + content). If the same URL was scraped before but content differs
    // (e.g., improved extraction or post updated), allow inserting a new row.
    const existedByHash = await prisma.scrapePost.findUnique({ where: { contentHash: hash } });
    if (existedByHash) {
      console.log(`[save] skip (existing hash) ${post.sourceUrl}`);
      continue;
    }
    const existedByUrl = await prisma.scrapePost.findFirst({ where: { sourceUrl: post.sourceUrl } });
    if (existedByUrl && existedByUrl.contentHash === hash) {
      console.log(`[save] skip (existing url+hash) ${post.sourceUrl}`);
      continue;
    }

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
