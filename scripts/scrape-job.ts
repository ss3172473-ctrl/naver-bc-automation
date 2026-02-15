import "dotenv/config";
import fs from "fs";
import path from "path";
import { PrismaClient } from "@prisma/client";
import { chromium } from "playwright-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
import type { Page, Frame } from "playwright";
import { contentHash } from "../src/lib/scrape/hash";
import { sendRowsToGoogleSheet, type SheetPostPayload } from "../src/lib/sheets";
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
  bodyText: string;
  commentsText: string;
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
  boardName: string;
  addedAt: Date | null;
  queryKeyword: string;
};

const prisma = new PrismaClient();
const SESSION_FILE =
  process.env.NAVER_CAFE_SESSION_FILE ||
  path.join(process.cwd(), "playwright", "storage", "naver-cafe-session.json");
const OUTPUT_DIR = path.join(process.cwd(), "outputs", "scrape-jobs");
const STORAGE_STATE_KEY = "naverCafeStorageStateEnc";
const PROGRESS_KEY_PREFIX = "scrapeJobProgress:";
const CANCEL_KEY_PREFIX = "scrapeJobCancel:";

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

function progressKey(jobId: string) {
  return `${PROGRESS_KEY_PREFIX}${jobId}`;
}

function cancelKey(jobId: string) {
  return `${CANCEL_KEY_PREFIX}${jobId}`;
}

type JobProgress = {
  updatedAt: string;
  stage: string;
  message?: string;
  cafeId?: string;
  cafeName?: string;
  cafeIndex?: number;
  cafeTotal?: number;
  keyword?: string;
  keywordIndex?: number;
  keywordTotal?: number;
  url?: string;
  urlIndex?: number;
  urlTotal?: number;
  candidates?: number;
  parseAttempts?: number;
  collected?: number;
  sheetSynced?: number;
  dbSynced?: number;
};

async function setJobProgress(jobId: string, patch: Partial<JobProgress>) {
  const key = progressKey(jobId);
  const next: JobProgress = {
    updatedAt: new Date().toISOString(),
    stage: patch.stage || "RUNNING",
    ...patch,
  };
  await prisma.setting.upsert({
    where: { key },
    create: { key, value: JSON.stringify(next) },
    update: { value: JSON.stringify(next) },
  });
}

async function isCancelRequested(jobId: string): Promise<boolean> {
  const row = await prisma.setting.findUnique({ where: { key: cancelKey(jobId) } }).catch(() => null);
  const v = String(row?.value || "").trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

async function clearCancelAndProgress(jobId: string) {
  await prisma.setting.deleteMany({
    where: { key: { in: [progressKey(jobId), cancelKey(jobId)] } },
  });
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

function extractCountsFromText(text: string): { viewCount: number; likeCount: number; commentCount: number } {
  const t = String(text || "");

  // Examples seen in Cafe FE:
  // "... 2026.01.27. 13:48조회 356"
  // "좋아요0" / "좋아요 1"
  // "댓글 7URL 복사" / " 댓글 7"
  const pickMax = (re: RegExp) => {
    const all = Array.from(t.matchAll(re));
    if (all.length === 0) return 0;
    let best = 0;
    for (const m of all) {
      const v = asInt(m[1] || "");
      if (v > best) best = v;
    }
    return best;
  };

  const viewCount = pickMax(/조회\s*([0-9][0-9,]*)/g);
  const likeCount = pickMax(/좋아요\s*([0-9][0-9,]*)/g);
  const commentCount = pickMax(/댓글\s*([0-9][0-9,]*)/g);

  return { viewCount, likeCount, commentCount };
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

function normalizeBoardToken(value: string): string {
  return String(value || "")
    .toLowerCase()
    .replace(/\s+/g, "")
    .trim();
}

function isExcludedBoard(candidate: ArticleCandidate, excludedBoardTokens: Set<string>): boolean {
  if (!excludedBoardTokens.size) return false;
  const boardTokens = [candidate.boardType, candidate.boardName]
    .filter(Boolean)
    .map((value) => normalizeBoardToken(String(value)));

  for (const board of boardTokens) {
    if (!board) continue;
    for (const blocked of excludedBoardTokens) {
      if (!blocked) continue;
      if (board === blocked || board.includes(blocked) || blocked.includes(board)) {
        return true;
      }
    }
  }
  return false;
}

function includesKeyword(text: string, keyword: string): boolean {
  const compact = String(text || "").replace(/\s+/g, "").toLowerCase();
  const kw = String(keyword || "").replace(/\s+/g, "").toLowerCase();
  if (!kw) return true;
  return compact.includes(kw);
}

function makeSearchQueryFromTitle(title: string): string {
  const compact = String(title || "").replace(/\s+/g, "");
  if (!compact) return "";
  // Keep it short to reduce search noise, but long enough to be unique.
  return compact.slice(0, 12);
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

function makeUtcFromKstParts(
  yyyy: number,
  mm: number,
  dd: number,
  hh: number,
  min: number
): Date {
  // KST = UTC+9 (no DST). Convert "local KST clock time" to UTC Date.
  return new Date(Date.UTC(yyyy, mm - 1, dd, hh - 9, min, 0, 0));
}

function parseNaverCafeDate(value: unknown): Date | null {
  if (value === null || value === undefined) return null;

  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value;
  }

  if (typeof value === "number") {
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? null : d;
  }

  const raw = String(value).trim();
  if (!raw) return null;

  // Epoch millis as string
  if (/^\d{13}$/.test(raw)) {
    const d = new Date(Number(raw));
    return Number.isNaN(d.getTime()) ? null : d;
  }

  // ISO-ish
  const iso = toDateSafe(raw);
  if (iso) return iso;

  // Common visible format in Cafe: "2026.01.27. 13:48" or "2026.01.27."
  const m =
    raw.match(/(\d{4})\.(\d{2})\.(\d{2})\.\s*(\d{2}):(\d{2})/) ||
    raw.match(/(\d{4})\.(\d{2})\.(\d{2})\./);
  if (m) {
    const yyyy = Number(m[1]);
    const mm = Number(m[2]);
    const dd = Number(m[3]);
    const hh = m[4] ? Number(m[4]) : 0;
    const min = m[5] ? Number(m[5]) : 0;
    if (
      Number.isFinite(yyyy) &&
      Number.isFinite(mm) &&
      Number.isFinite(dd) &&
      Number.isFinite(hh) &&
      Number.isFinite(min)
    ) {
      const d = makeUtcFromKstParts(yyyy, mm, dd, hh, min);
      return Number.isNaN(d.getTime()) ? null : d;
    }
  }

  return null;
}

function extractPublishedAtFromText(text: string): Date | null {
  const t = String(text || "");
  // In many FE pages, the header contains "2026.01.27. 13:48조회 350"
  // Grab the first occurrence (it should be the post timestamp).
  const m = t.match(/(\d{4})\.(\d{2})\.(\d{2})\.\s*(\d{2}):(\d{2})/);
  if (!m) {
    const m2 = t.match(/(\d{4})\.(\d{2})\.(\d{2})\./);
    if (!m2) return null;
    const yyyy = Number(m2[1]);
    const mm = Number(m2[2]);
    const dd = Number(m2[3]);
    if (!Number.isFinite(yyyy) || !Number.isFinite(mm) || !Number.isFinite(dd)) return null;
    return makeUtcFromKstParts(yyyy, mm, dd, 0, 0);
  }
  const yyyy = Number(m[1]);
  const mm = Number(m[2]);
  const dd = Number(m[3]);
  const hh = Number(m[4]);
  const min = Number(m[5]);
  if (
    !Number.isFinite(yyyy) ||
    !Number.isFinite(mm) ||
    !Number.isFinite(dd) ||
    !Number.isFinite(hh) ||
    !Number.isFinite(min)
  ) {
    return null;
  }
  return makeUtcFromKstParts(yyyy, mm, dd, hh, min);
}

async function extractPublishedAtFromPageTop(target: Frame | Page): Promise<Date | null> {
  // Some body selectors exclude the header area where the timestamp lives.
  // Use a cheap heuristic: search only the top part of the page visible text.
  try {
    const all = String(await withTimeout((target as any).locator("body").innerText(), 20000, "body innerText")).trim();
    if (!all) return null;
    const head = all.slice(0, 3500);
    return extractPublishedAtFromText(head);
  } catch {
    return null;
  }
}

async function extractCountsFromPageTop(
  target: Frame | Page
): Promise<{ viewCount: number; likeCount: number; commentCount: number }> {
  try {
    const all = String(
      await withTimeout((target as any).locator("body").innerText(), 20000, "body innerText")
    ).trim();
    if (!all) return { viewCount: 0, likeCount: 0, commentCount: 0 };
    // Some pages render like/comment counts below the fold; scan a larger prefix.
    const prefix = all.slice(0, 30000);
    return extractCountsFromText(prefix);
  } catch {
    return { viewCount: 0, likeCount: 0, commentCount: 0 };
  }
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
      const hasContent = await f
        .locator(
          "div.se-main-container, div.se-viewer, div.article_viewer, #tbody, div.ArticleContentBox, div.ContentRenderer"
        )
        .count()
        .catch(() => 0);
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
    // FE/PC
    "div.ArticleContentBox",
    "div.ContentRenderer",
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
      const txt = String(await withTimeout(loc.innerText(), 6000, `innerText ${sel}`)).trim();
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
  // Focus on actual post body containers first.
  // Bug we're fixing: sometimes we capture profile/post-list/menu text instead of the article body.
  // Strategy:
  // - Try many known containers (FE/legacy/old editor).
  // - Pick the best (longest) candidate that does NOT look like join/permission/profile/list UI.
  // - Never fall back to whole-page text here; if we can't confidently locate the body, return "" and let parsePost retry via other URL variants.

  const waitSelectors = [
    // SmartEditor 3
    "div.se-main-container",
    "div.se-viewer",
    // FE/PC containers
    "div.ArticleContentBox",
    "div.ArticleContentBox__content",
    "div.ContentRenderer",
    // Legacy
    "div.article_viewer",
    "#tbody",
    // Generic
    "article",
    "main",
  ].join(", ");

  await (target as any).waitForSelector(waitSelectors, { timeout: 15000 }).catch(() => undefined);

  const selectors = [
    // Highest priority: SmartEditor 3 (most common for text posts)
    "div.se-main-container",
    "div.se-viewer",
    // FE article page variants (class names sometimes change)
    "div.ArticleContentBox div.se-main-container",
    "div.ArticleContentBox",
    "div[class*='ArticleContentBox']",
    "div[class*='ContentRenderer']",
    "div.ContentRenderer",
    // Legacy / old editor
    "#tbody",
    "div.article_viewer",
    // Last resort inside doc, but still structured
    "article",
    "main",
  ];

  const bad = (txt: string) =>
    looksLikeJoinWall(txt) ||
    looksLikePermissionWall(txt) ||
    looksLikeProfileOrPostList(txt);

  let best = "";
  let bestSel = "";

  for (const sel of selectors) {
    try {
      const loc = (target as any).locator(sel);
      const count = await loc.count().catch(() => 0);
      if (count === 0) continue;

      const take = Math.min(count, 6);
      for (let i = 0; i < take; i += 1) {
        const txt = String(
          await withTimeout(loc.nth(i).innerText(), 6000, `body innerText ${sel}#${i}`)
        ).trim();
        if (!txt) continue;
        if (bad(txt)) continue;
        if (txt.length > best.length) {
          best = txt;
          bestSel = `${sel}#${i}`;
        }
      }
    } catch {
      // ignore
    }
  }

  if (best) {
    console.log(`[extract] body selector=${bestSel} len=${best.length}`);
    return best;
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
  const itemSelCombined = ".CommentItem, li.CommentItem, [class*='CommentItem']";

  const cleanCommentBlock = (raw: string): string => {
    const lines = String(raw || "")
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);

    const dropExact = new Set([
      "댓글",
      "댓글알림",
      "클린봇",
      "등록",
      "댓글을 입력하세요",
      "신고",
      "공유",
      "URL 복사",
    ]);

    const dropIfIncludes = [
      "클린봇 이 악성 댓글을 감지합니다",
      "댓글알림",
      "댓글을 입력하세요",
      "댓글을 입력해주세요",
    ];

    const out = lines.filter((l) => {
      if (dropExact.has(l)) return false;
      if (dropIfIncludes.some((p) => l.includes(p))) return false;
      return true;
    });

    return out.join("\n").trim();
  };

  // Scroll down in steps to trigger lazy-loading.
  for (let i = 0; i < 4; i += 1) {
    await (target as any)
      .evaluate((ratio: number) => window.scrollTo(0, document.body.scrollHeight * ratio), (i + 1) / 4)
      .catch(() => undefined);
    await sleep(450);
  }

  // Sometimes the comments are behind a "댓글" button/tab.
  const openCommentButtons = [
    "button.button_comment",
    "a.button_comment",
    "[role='button'][class*='comment']",
    "button, a",
  ];
  const openRegex = /댓글\s*\d*|댓글\s*보기|댓글\s*열기/i;

  const tryOpen = async () => {
    for (const sel of openCommentButtons) {
      const btn = (target as any).locator(sel).filter({ hasText: openRegex }).first();
      const c = await withTimeout<number>(
        btn.count() as Promise<number>,
        2500,
        `openComment count ${sel}`
      ).catch(() => 0);
      if (c <= 0) continue;
      await btn.click({ timeout: 1500 }).catch(() => undefined);
      await sleep(600);
      break;
    }
  };

  // Wait/retry until comment items appear (headless can be slow).
  let globalCount = 0;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    globalCount = await withTimeout<number>(
      ((target as any).locator(itemSelCombined).count() as Promise<number>),
      2500,
      `global comments count attempt=${attempt}`
    ).catch(() => 0);
    if (globalCount > 0) break;
    if (attempt === 0 || attempt === 2) await tryOpen();
    await (target as any)
      .evaluate(() => window.scrollTo(0, document.body.scrollHeight))
      .catch(() => undefined);
    await sleep(700);
  }

  if (globalCount <= 0) return "";

  // Pick a sensible scope. Sometimes ".CommentBox" exists but doesn't contain actual items.
  const commentRoot = (target as any).locator(".CommentBox, .comment_list, [class*='CommentBox']").first();
  const rootCount = await withTimeout<number>(
    (commentRoot.locator(itemSelCombined).count() as Promise<number>),
    2500,
    "root comments count"
  ).catch(() => 0);
  const scope = rootCount > 0 ? commentRoot : (target as any);

  // Expand comment "더보기" buttons if present (within comment scope only).
  const expandRegex = /댓글\s*더보기|이전\s*댓글|더보기|more/i;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const btn = scope
      .locator("button, a, span")
      .filter({ hasText: expandRegex })
      .first();
    const count = await withTimeout<number>(
      (btn.count() as Promise<number>),
      2500,
      `expand btn count attempt=${attempt}`
    ).catch(() => 0);
    if (count === 0) break;
    await btn.click({ timeout: 1500 }).catch(() => undefined);
    await sleep(300);
  }

  const items = scope.locator(itemSelCombined);
  const n = await withTimeout<number>(
    (items.count() as Promise<number>),
    2500,
    "comments items count"
  ).catch(() => 0);
  if (n <= 0) return "";

  const take = Math.min(n, 250);
  const parts: string[] = [];
  for (let i = 0; i < take; i += 1) {
    const item = items.nth(i);
    let raw = String(
      await withTimeout(item.innerText(), 4000, `comment innerText #${i}`).catch(() => "")
    ).trim();
    if (!raw) continue;

    // Some copy/paste views include a "프로필 사진" line. Add it if the comment has an image and it's missing.
    const hasImg =
      (await withTimeout<number>(
        (item.locator("img").count() as Promise<number>),
        2500,
        `comment img count #${i}`
      ).catch(() => 0)) > 0;
    if (hasImg && !raw.includes("프로필")) {
      raw = `프로필 사진\n${raw}`;
    }

    const cleaned = cleanCommentBlock(raw);
    if (cleaned.length < 3) continue;
    parts.push(cleaned);
  }

  const joined = parts.join("\n\n").trim();
  return joined;
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

function buildMobileFeArticleUrl(clubid: string, articleid: string): string {
  // Mobile FE tends to have a simpler DOM for some articles (especially where PC wraps in frames).
  return (
    `https://m.cafe.naver.com/ca-fe/web/cafes/${encodeURIComponent(clubid)}` +
    `/articles/${encodeURIComponent(articleid)}`
  );
}

async function buildClubIdToCafeMetaMap(
  page: Page
): Promise<Map<string, { cafeId: string; cafeName: string; cafeUrl: string }>> {
  const rows = await prisma.cafeMembership.findMany({ select: { cafeId: true, name: true, url: true } });
  const map = new Map<string, { cafeId: string; cafeName: string; cafeUrl: string }>();
  for (const row of rows) {
    const cafeId = String(row.cafeId || "").trim();
    if (!cafeId) continue;
    let clubid = cafeId;
    if (!/^\d+$/.test(cafeId)) {
      clubid = await getClubId(page, cafeId).catch(() => "");
    }
    if (!clubid || !/^\d+$/.test(clubid)) continue;
    map.set(clubid, {
      cafeId,
      cafeName: String(row.name || cafeId),
      cafeUrl: String(row.url || getCafeUrl(cafeId)),
    });
  }
  return map;
}

async function getClubId(page: Page, cafeId: string): Promise<string> {
  // If the "cafeId" is already numeric, treat it as clubId.
  if (/^\d+$/.test(cafeId)) {
    return cafeId;
  }

  // Prefer request-based resolution: much more stable than rendering the heavy cafe home.
  // (Avoids "Page crashed" errors on some cafes.)
  const homeUrl = getCafeUrl(cafeId);
  try {
    const resp = await page.request.get(homeUrl).catch(() => null);
    if (resp) {
      const finalUrl = resp.url();
      try {
        const u = new URL(finalUrl);
        const clubid = u.searchParams.get("clubid") || u.searchParams.get("cafeId");
        if (clubid) return clubid;
      } catch {
        // ignore
      }

      const html = await resp.text().catch(() => "");
      const match =
        html.match(/clubid=(\d+)/i) ||
        html.match(/cafeId=(\d+)/i) ||
        html.match(/\/cafes\/(\d+)\//i);
      if (match?.[1]) return match[1];
    }
  } catch {
    // ignore; fall back to rendering.
  }

  // Fallback: render the cafe home and inspect frames/HTML.
  await page.goto(homeUrl, { waitUntil: "domcontentloaded", timeout: 35000 });
  await sleep(1200);

  const candidates = page.frames().map((f) => f.url()).concat([page.url()]);
  for (const url of candidates) {
    try {
      const u = new URL(url);
      const clubid = u.searchParams.get("clubid") || u.searchParams.get("cafeId");
      if (clubid) return clubid;
    } catch {
      // ignore
    }
  }

  const html = await page.content().catch(() => "");
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
  pageNum: number,
  maxPages = 1
): Promise<ArticleCandidate[]> {
  const requestedPages = Math.max(1, Math.min(8, Math.floor(maxPages)));
  const rows: ArticleCandidate[] = [];

  for (let targetPage = pageNum; targetPage < pageNum + requestedPages; targetPage += 1) {
    const url =
      `https://apis.naver.com/cafe-web/cafe-mobile/CafeMobileWebArticleSearchListV4` +
      `?cafeId=${encodeURIComponent(cafeNumericId)}` +
      `&query=${encodeURIComponent(keyword)}` +
      `&searchBy=1&sortBy=date&page=${targetPage}&perPage=20` +
      `&adUnit=MW_CAFE_BOARD&ad=true`;

    const resp = await page.request.get(url);
    if (!resp.ok()) {
      if (targetPage === pageNum) {
        throw new Error(`Search API failed: ${resp.status()} ${url}`);
      }
      break;
    }

    const json = await resp.json();
    const list = json?.message?.result?.articleList || [];
    if (!Array.isArray(list) || list.length === 0) break;

    for (const row of list) {
      if (row?.type !== "ARTICLE") continue;
      const item = row.item;
      if (!item?.articleId) continue;

      // Search API subjects can contain highlight markup like <em>...</em>.
      const subject = String(item.subject || "").replace(/<[^>]*>/g, "");
      const addedAtSafe = parseNaverCafeDate(item.addDate);
      const boardName = String(
        item.boardName ||
          item.boardTitle ||
          item.menuName ||
          item.menu ||
          item.menuTitle ||
          item.board ||
          ""
      ).trim();

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
        boardName,
        addedAt: addedAtSafe,
        queryKeyword: keyword,
      });
    }
  }

  return rows;
}

async function collectArticleCandidates(
  page: Page,
  jobId: string,
  cafeId: string,
  cafeName: string,
  keywords: string[],
  excludedBoards: Set<string>,
  maxUrls: number,
  baseCollected: number
): Promise<{ cafeNumericId: string; candidates: ArticleCandidate[] }> {
  const seen = new Set<number>();
  const candidates: ArticleCandidate[] = [];
  const cafeNumericId = await getClubId(page, cafeId);
  console.log(`[cafe] cafeId=${cafeId} cafeNumericId=${cafeNumericId}`);

  // Requirement: for each selected cafe, search each keyword at least once.
  // We cap per-keyword fetches by maxUrls so we can scale up without blowing up runtime.
  // Use multiple pages only when needed to reach requested maxUrls.
  const perKeywordTake = Math.max(1, Math.floor(maxUrls / Math.max(1, keywords.length)));
  const pagesToFetch = Math.min(6, Math.ceil(perKeywordTake / 20));

  for (let i = 0; i < keywords.length; i += 1) {
    const keyword = keywords[i] || "";
    await setJobProgress(jobId, {
      stage: "SEARCH",
      cafeId,
      cafeName,
      keyword,
      keywordIndex: i + 1,
      keywordTotal: keywords.length,
      candidates: candidates.length,
      collected: baseCollected,
      message: "searching",
    }).catch(() => undefined);
    console.log(`[collect] cafe=${cafeId} keyword=${keyword}`);
    const rows = await fetchCandidatesFromSearchApi(page, cafeNumericId, keyword, 1, pagesToFetch).catch(() => []);
    const take = Math.max(1, Math.min(perKeywordTake, rows.length));
    for (let i = 0; i < take; i += 1) {
      const row = rows[i];
      if (!row) continue;
      if (isExcludedBoard(row, excludedBoards)) {
        console.log(`[collect] skip excluded board url=${row.url} board=${row.boardType}/${row.boardName}`);
        continue;
      }
      if (seen.has(row.articleId)) continue;
      seen.add(row.articleId);
      if (candidates.length < maxUrls) {
        candidates.push(row);
      }
    }
    await sleep(180);
  }

  // Reduce parse load: keep the newest candidates first (search API is date-sorted, but merging across
  // multiple keywords can reorder); also keep the list tight.
  candidates.sort((a, b) => {
    const at = a.addedAt ? a.addedAt.getTime() : 0;
    const bt = b.addedAt ? b.addedAt.getTime() : 0;
    return bt - at;
  });
  if (candidates.length > maxUrls) candidates.length = maxUrls;

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
  const mobileFeUrl =
    expectedArticleId ? buildMobileFeArticleUrl(cafeNumericId, expectedArticleId) : null;

  // We'll try a small set of URL variants because Naver Cafe has multiple render paths.
  // Goal: reliably capture the *article body text* (not menu/profile/list UI).
  const urlVariants = [feUrl, canonicalUrl, mobileFeUrl].filter(Boolean) as string[];
  const visited: string[] = [];

  let lastBody = "";
  let lastComments = "";

  for (const u of urlVariants) {
    visited.push(u);
    await withTimeout(page.goto(u, { waitUntil: "domcontentloaded", timeout: 35000 }), 45000, "page.goto");
    await sleep(1200);
    console.log(`[parse] loaded url=${page.url()}`);

    if (page.url().includes("nidlogin")) {
      throw new Error("네이버 로그인 세션이 만료되었습니다.");
    }

    const isFeLike = u.includes("/ca-fe/") && u.includes("/articles/");

    // For FE URL we can extract directly from the page (no iframe). For legacy URLs, fall back to cafe_main.
    let frame: Frame | Page = page;
    if (!isFeLike) {
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
      console.log("[parse] using FE-like article page (no iframe)");
    }

    // User request: we mainly need full visible article text. Title/author/date are optional metadata.
    // Use the search API subject as the title to avoid DOM selector fragility.
    let title = (fallbackTitle || "").trim() || (await page.title());

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
    let bodyText = String(bodyTextRaw || "").trim();
    if (!bodyText) {
      const fallback = String(await extractBestText(frame).catch(() => "")).trim();
      const cleaned = cleanCafeText(fallback);
      if (cleaned && !looksLikeJoinWall(cleaned) && !looksLikePermissionWall(cleaned) && !looksLikeProfileOrPostList(cleaned)) {
        bodyText = cleaned;
        console.log(`[parse] body fallback via extractBestText len=${bodyText.length}`);
      }
    }
    const sourceLine = String(await extractSourceLineText(frame).catch(() => "")).trim();
    let commentsTextRaw = await extractCommentsText(frame);
    let commentsText = String(commentsTextRaw || "").trim();

    // If we came from legacy path, comments may render better on FE page.
    if (!commentsText && !isFeLike && expectedArticleId) {
      const retryUrl = buildFeArticleUrl(cafeNumericId, expectedArticleId);
      console.log(`[parse] retrying comments via FE url: ${retryUrl}`);
      await withTimeout(
        page.goto(retryUrl, { waitUntil: "domcontentloaded", timeout: 35000 }),
        45000,
        "page.goto feUrl"
      ).catch(() => undefined);
      await sleep(1200);
      console.log(`[parse] FE loaded url=${page.url()}`);
      commentsTextRaw = await extractCommentsText(page);
      commentsText = String(commentsTextRaw || "").trim();
    }

    lastBody = bodyText;
    lastComments = commentsText;

    const joinedForChecks = `${bodyText}\n${commentsText}`.trim();
    if (!joinedForChecks) continue;
    if (looksLikeJoinWall(joinedForChecks)) continue;
    if (looksLikePermissionWall(joinedForChecks)) continue;

    // If the "body" looks like profile/list UI, treat it as failure unless we have real comments.
    if (looksLikeProfileOrPostList(bodyText) && !commentsText) {
      console.log("[parse] body looks like profile/list UI; retrying via next URL variant");
      continue;
    }

    // Improve title for directUrl mode (where fallbackTitle is empty and page.title is often generic like "네이버 카페").
    if (!(fallbackTitle || "").trim() && (title.trim().length < 2 || title.includes("네이버 카페"))) {
      const lines = bodyText
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean);
      // Many cafes render: [게시판명] + [제목] + ...
      if (lines.length >= 2) title = lines[1];
      else if (lines.length >= 1) title = lines[0];
    }

    const bodyPlusSource =
      sourceLine && bodyText && !bodyText.includes(sourceLine)
        ? `${bodyText}\n\n${sourceLine}`.trim()
        : bodyText;
    const contentText = commentsText
      ? `${bodyPlusSource}\n\n[댓글]\n${commentsText}`.trim()
      : bodyPlusSource;

    console.log(
      `[parse] extracted body len=${bodyText.length} comments len=${commentsText.length} total len=${contentText.length}`
    );

    // User-requested mode: only archive visible text. HTML extraction is slow/flaky on Naver Cafe PC and
    // can cause timeouts; skip it to improve reliability.
    const rawHtml: string | null = null;

    // Derive publishedAt from visible text (works for directUrls too).
    // First try bodyText (often includes header), then fall back to the page-top text if body container excludes the timestamp.
    const publishedAt =
      extractPublishedAtFromText(bodyText) ||
      (await extractPublishedAtFromPageTop(frame)) ||
      null;

    // Derive counts from visible text (directUrls needs this; keyword mode may override later if missing).
    const countsBody = extractCountsFromText(bodyText);
    const countsTop = await extractCountsFromPageTop(frame);
    const viewCount = countsBody.viewCount || countsTop.viewCount || 0;
    const likeCount = countsBody.likeCount || countsTop.likeCount || 0;
    const commentCount = countsBody.commentCount || countsTop.commentCount || 0;

    // If counts (especially like/comment) are missing/unstable in DOM text,
    // re-fetch via the Cafe search API using a short title query and match by articleId.
    let finalViewCount = viewCount;
    let finalLikeCount = likeCount;
    let finalCommentCount = commentCount;
    let finalPublishedAt = publishedAt;

    if (
      expectedArticleId &&
      /^\d+$/.test(String(cafeNumericId || "")) &&
      (finalLikeCount === 0 || finalCommentCount === 0 || finalViewCount === 0 || !finalPublishedAt)
    ) {
      const q = makeSearchQueryFromTitle(title);
      if (q) {
        const rows = await fetchCandidatesFromSearchApi(page, String(cafeNumericId), q, 1).catch(() => []);
        const match = rows.find((r) => String(r.articleId) === String(expectedArticleId));
        if (match) {
          if (!finalViewCount) finalViewCount = match.readCount;
          if (!finalLikeCount) finalLikeCount = match.likeCount;
          if (!finalCommentCount) finalCommentCount = match.commentCount;
          if (!finalPublishedAt && match.addedAt) finalPublishedAt = match.addedAt;
          console.log(
            `[parse] counts via searchApi view=${finalViewCount} like=${finalLikeCount} comments=${finalCommentCount}`
          );
        }
      }
    }

    // Last resort: if we successfully scraped comments but couldn't parse/resolve commentCount,
    // use the number of extracted comment blocks (each comment item usually contains "답글쓰기").
    if (!finalCommentCount && commentsText) {
      const est = (commentsText.match(/답글쓰기/g) || []).length;
      if (est > 0) finalCommentCount = est;
    }

    // Skip author parsing (unstable selectors; not needed for the user's sheet workflow).
    const authorName = "";

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
      publishedAt: finalPublishedAt,
      viewCount: finalViewCount,
      likeCount: finalLikeCount,
      commentCount: finalCommentCount,
      bodyText: bodyPlusSource,
      commentsText,
      contentText,
      rawHtml,
      comments,
    };
  }

  console.log(
    `[parse] failed to extract a valid body/comments via variants. visited=${visited.length} lastBodyLen=${lastBody.length} lastCommentsLen=${lastComments.length}`
  );
  return null;
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

type ScrapeJobForRun = {
  id: string;
  notifyChatId: string | null;
  keywords: string;
  directUrls: string | null;
  includeWords: string | null;
  excludeWords: string | null;
  excludeBoards: string | null;
  cafeIds: string;
  cafeNames: string | null;
  fromDate: Date | null;
  toDate: Date | null;
  minViewCount: number | null;
  minCommentCount: number | null;
  useAutoFilter: boolean;
  maxPosts: number;
  status: string;
  errorMessage: string | null;
};

async function loadJob(jobId: string): Promise<ScrapeJobForRun> {
  try {
    const jobWithExcludeBoards = await prisma.scrapeJob.findUnique({
      where: { id: jobId },
      select: {
        id: true,
        notifyChatId: true,
        keywords: true,
        directUrls: true,
        includeWords: true,
        excludeWords: true,
        excludeBoards: true,
        cafeIds: true,
        cafeNames: true,
        fromDate: true,
        toDate: true,
        minViewCount: true,
        minCommentCount: true,
        useAutoFilter: true,
        maxPosts: true,
        status: true,
        errorMessage: true,
      },
    });

    if (!jobWithExcludeBoards) {
      throw new Error("작업을 찾을 수 없습니다.");
    }

    return jobWithExcludeBoards as ScrapeJobForRun;
  } catch (error: any) {
    // Backward compatibility: old DB without excludeBoards column.
    const code = error?.code;
    if (code !== "P2022" && typeof code !== "string") {
      throw error;
    }

    const jobWithoutExcludeBoards = await prisma.scrapeJob.findUnique({
      where: { id: jobId },
      select: {
        id: true,
        notifyChatId: true,
        keywords: true,
        directUrls: true,
        includeWords: true,
        excludeWords: true,
        cafeIds: true,
        cafeNames: true,
        fromDate: true,
        toDate: true,
        minViewCount: true,
        minCommentCount: true,
        useAutoFilter: true,
        maxPosts: true,
        status: true,
        errorMessage: true,
      },
    });

    if (!jobWithoutExcludeBoards) {
      throw new Error("작업을 찾을 수 없습니다.");
    }

    return {
      ...(jobWithoutExcludeBoards as Omit<ScrapeJobForRun, "excludeBoards">),
      excludeBoards: null,
    };
  }
}

async function run(jobId: string) {
  const job = await loadJob(jobId);
  if (!job) throw new Error("작업이 존재하지 않습니다.");
  const storageState = await loadStorageState();

  await clearCancelAndProgress(jobId).catch(() => undefined);

  await prisma.scrapeJob.update({
    where: { id: jobId },
    data: { status: "RUNNING", startedAt: new Date(), errorMessage: null },
  });

  const keywords = parseJsonStringArray(job.keywords);
  const directUrls = parseJsonStringArray(job.directUrls);
  const includeWords = parseJsonStringArray(job.includeWords);
  const excludeWords = parseJsonStringArray(job.excludeWords);
  const excludeBoards = parseJsonStringArray(job.excludeBoards);
  const cafeIds = parseJsonStringArray(job.cafeIds);
  const cafeNames = parseJsonStringArray(job.cafeNames);
  const excludedBoardTokens = new Set(excludeBoards.map((value) => normalizeBoardToken(value)));

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
  const sheetPending: SheetPostPayload[] = [];
  const sheetState = { synced: 0, saved: 0 };

  const flushSheetRows = async (force = false) => {
    const shouldFlush = force ? sheetPending.length > 0 : sheetPending.length >= 1;
    if (!shouldFlush) return;

    const rowsToSend = [...sheetPending];
    sheetPending.length = 0;

    try {
      await sendRowsToGoogleSheet(rowsToSend);
      sheetState.synced += rowsToSend.length;
      await prisma.scrapeJob
        .update({
          where: { id: job.id },
          data: { sheetSynced: sheetState.synced },
        })
        .catch(() => undefined);
      await setJobProgress(jobId, {
        stage: "PARSE",
        sheetSynced: sheetState.synced,
        dbSynced: sheetState.saved,
        collected: collected.length,
      }).catch(() => undefined);
    } catch (error) {
      console.error("[sheet] batch sync failed", error);
    }
  };

  try {
    if (Array.isArray(directUrls) && directUrls.length > 0) {
      console.log(`[run] directUrls mode urls=${directUrls.length}`);
      const metaMap = await buildClubIdToCafeMetaMap(page).catch(() => new Map());
      for (const url of directUrls) {
        if (await isCancelRequested(jobId)) {
          await setJobProgress(jobId, { stage: "CANCELLED", message: "cancel requested" }).catch(() => undefined);
          throw new Error("cancelled");
        }
        if (collected.length >= job.maxPosts) break;
        const clubid = getClubIdFromUrl(url) || "";
        const meta = clubid ? metaMap.get(clubid) : null;
        const cafeId = meta?.cafeId || clubid || "direct";
        const cafeName = meta?.cafeName || clubid || "direct";
        const cafeNumericId = clubid || (meta ? await getClubId(page, meta.cafeId).catch(() => "") : "") || "direct";

        await setJobProgress(jobId, {
          stage: "PARSE",
          cafeId,
          cafeName,
          url,
          urlIndex: directUrls.indexOf(url) + 1,
          urlTotal: directUrls.length,
          collected: collected.length,
        }).catch(() => undefined);

        const parsed = await withTimeout(
          parsePost(page, url, cafeId, cafeNumericId, cafeName, ""),
          90000,
          "parsePost overall"
        ).catch(() => null);
        if (!parsed) continue;
        const normalizedForFilter = `${parsed.title}\n${parsed.contentText}`;
        if (!isAllowedByWords(normalizedForFilter, includeWords, excludeWords)) {
          continue;
        }
        // Ensure cafeUrl matches the resolved cafe (for Sheets convenience).
        if (clubid && meta?.cafeUrl) parsed.cafeUrl = meta.cafeUrl;
        collected.push(parsed);
        await sleep(900 + Math.floor(Math.random() * 600));
      }
    } else {
      for (let i = 0; i < cafeIds.length; i += 1) {
        if (await isCancelRequested(jobId)) {
          await setJobProgress(jobId, { stage: "CANCELLED", message: "cancel requested" }).catch(() => undefined);
          throw new Error("cancelled");
        }
        const cafeId = cafeIds[i];
        const cafeName = cafeNames[i] || cafeId;

        const alreadyEnough = collected.length >= job.maxPosts;
        await setJobProgress(jobId, {
          stage: "SEARCH",
          cafeId,
          cafeName,
          cafeIndex: i + 1,
          cafeTotal: cafeIds.length,
          keywordTotal: keywords.length,
          collected: collected.length,
        }).catch(() => undefined);

        const { cafeNumericId, candidates } = await collectArticleCandidates(
          page,
          jobId,
          cafeId,
          cafeName,
          keywords,
          excludedBoardTokens,
          // Candidate cap per cafe (keep stable even with many keywords).
          alreadyEnough ? 1 : Math.min(120, Math.max(30, Math.ceil(job.maxPosts * 6))),
          collected.length
        );

        // Requirement: search each keyword once per selected cafe.
        // Even if we've already collected enough posts, we still execute the keyword search pass above.
        if (alreadyEnough) {
          console.log(`[run] maxPosts reached; skipping parse for cafe=${cafeId} (search pass done)`);
          continue;
        }

        let parseAttempts = 0;
        const parseBudget = Math.max(20, job.maxPosts * 8);

        for (const cand of candidates) {
          if (await isCancelRequested(jobId)) {
            await setJobProgress(jobId, { stage: "CANCELLED", message: "cancel requested" }).catch(() => undefined);
            throw new Error("cancelled");
          }
          if (collected.length >= job.maxPosts) break;
          if (parseAttempts >= parseBudget) {
            console.log(`[run] parseBudget reached cafe=${cafeId} budget=${parseBudget}`);
            break;
          }

          // Fast date filter from search API (more reliable than DOM parsing).
          if (job.fromDate && cand.addedAt && cand.addedAt < job.fromDate) continue;
          if (job.toDate && cand.addedAt && cand.addedAt > job.toDate) continue;

          // Early filter by counts from list API (fast).
          if (job.minViewCount !== null && cand.readCount < job.minViewCount) continue;
          if (job.minCommentCount !== null && cand.commentCount < job.minCommentCount) continue;

          parseAttempts += 1;
          await setJobProgress(jobId, {
            stage: "PARSE",
            cafeId,
            cafeName,
            url: cand.url,
            candidates: candidates.length,
            parseAttempts,
            collected: collected.length,
          }).catch(() => undefined);
          const parsed = await withTimeout(
            parsePost(page, cand.url, cafeId, cafeNumericId, cafeName, cand.subject),
            90000,
            "parsePost overall"
          ).catch(() => null);
          if (!parsed) continue;

          // Keyword relevance check (defensive).
          const normalizedForKeywordCheck = `${cand.subject}\n${parsed.title}\n${parsed.contentText}`;
          if (!includesKeyword(normalizedForKeywordCheck, cand.queryKeyword)) {
            console.log(
              `[filter] drop keyword_miss kw=${cand.queryKeyword} url=${cand.url} title=${(parsed.title || "").slice(0, 60)}`
            );
            continue;
          }

          // Use counts from the search API list (more reliable than page text parsing).
          // Prefer page-extracted counts if present (it reflects current values).
          if (!parsed.viewCount) parsed.viewCount = cand.readCount;
          if (!parsed.likeCount) parsed.likeCount = cand.likeCount;
          if (!parsed.commentCount) parsed.commentCount = cand.commentCount;
          if (cand.addedAt) parsed.publishedAt = cand.addedAt;

          if (!parsed.title || parsed.title.trim().length < 2) {
            parsed.title = cand.subject || parsed.title;
          }

          const normalizedForFilter = `${cand.subject}\n${parsed.title}\n${parsed.contentText}`;
          if (!isAllowedByWords(normalizedForFilter, includeWords, excludeWords)) {
            continue;
          }

          collected.push(parsed);
          sheetPending.push({
            jobId,
            sourceUrl: parsed.sourceUrl,
            cafeId: parsed.cafeId,
            cafeName: parsed.cafeName,
            cafeUrl: parsed.cafeUrl,
            title: parsed.title,
            authorName: parsed.authorName,
            publishedAt: parsed.publishedAt?.toISOString() || "",
            viewCount: parsed.viewCount,
            likeCount: parsed.likeCount,
            commentCount: parsed.commentCount,
            bodyText: parsed.bodyText || "",
            commentsText: parsed.commentsText || "",
            contentText: parsed.contentText,
          });
          await flushSheetRows().catch(() => undefined);
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

  await flushSheetRows(true).catch(() => undefined);

  const finalPosts = filtered.slice(0, job.maxPosts);
  console.log(`[save] finalPosts=${finalPosts.length}`);

  let savedCount = 0;

  for (const post of finalPosts) {
    // Also keep a content hash for reference/secondary dedupe, but include URL to avoid false positives
    // when multiple posts share similar UI boilerplate text.
    const hash = contentHash(`${post.sourceUrl}\n${post.contentText}`);

    // Dedupe by (url + content). If the same URL was scraped before but content differs
    // (e.g., improved extraction or post updated), allow inserting a new row.
    const existedByHash = await prisma.scrapePost.findUnique({ where: { contentHash: hash } });
    const existedByUrl = await prisma.scrapePost.findFirst({ where: { sourceUrl: post.sourceUrl } });
    const isSameAsExisting = Boolean(existedByHash) || (existedByUrl && existedByUrl.contentHash === hash);

    // Always send to Sheets (so reruns can refresh counts), but avoid inserting exact duplicates into DB.
    if (isSameAsExisting) {
      console.log(`[save] skip DB insert (existing) ${post.sourceUrl}`);
    } else {
      console.log(`[save] creating post hash=${hash.slice(0, 10)} len=${post.contentText.length}`);
      await prisma.scrapePost.create({
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
      savedCount += 1;
      sheetState.saved += 1;
    }
  }

  const csvPath = writeCsv(jobId, finalPosts);

  const syncedCount = sheetState.synced;

  console.log(`[job] updating SUCCESS saved=${savedCount} synced=${syncedCount}`);
  await setJobProgress(jobId, { stage: "DONE", collected: collected.length }).catch(() => undefined);
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
    const cancelled = message === "cancelled";
    await prisma.scrapeJob
      .update({
        where: { id: jobId },
        data: {
          status: cancelled ? "CANCELLED" : "FAILED",
          errorMessage: cancelled ? "cancelled by user" : message,
          completedAt: new Date(),
        },
      })
      .catch(() => undefined);
    if (cancelled) {
      await setJobProgress(jobId, { stage: "CANCELLED", message: "cancelled by user" }).catch(() => undefined);
    }

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
