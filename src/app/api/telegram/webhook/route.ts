import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { telegramSendMessage } from "@/lib/telegram";
import { Prisma } from "@prisma/client";

export const runtime = "nodejs";

function parseCommaList(input: string): string[] {
  return String(input || "")
    .split(",")
    .map((item) => item.trim().replace(/\s+/g, ""))
    .filter(Boolean);
}

function parseAllowedChatIds(): Set<string> {
  const raw = process.env.TELEGRAM_ALLOWED_CHAT_IDS || "";
  return new Set(
    raw
      .split(",")
      .map((v) => v.trim())
      .filter(Boolean)
  );
}

function isExcludeBoardsSchemaMismatch(error: unknown): boolean {
  const raw = error instanceof Error ? error.message : String(error);
  const code = (error as { code?: string } | undefined)?.code;
  const normalized = raw.toLowerCase();
  if (code === "P2022" && normalized.includes("column") && normalized.includes("does not exist")) {
    return normalized.includes("excludeboards");
  }
  return false;
}

function isAllowedChatId(chatId: string): boolean {
  const allowed = parseAllowedChatIds();
  if (allowed.size === 0) return true; // allow all if not configured
  return allowed.has(String(chatId));
}

function extractCommandText(text: string): { cmd: string; rest: string } | null {
  const t = String(text || "").trim();
  if (!t.startsWith("/")) return null;
  const [first, ...tail] = t.split(/\s+/);
  const cmd = first.replace(/^\/+/, "").split("@")[0].toLowerCase();
  return { cmd, rest: tail.join(" ").trim() };
}

function parseKeyValueArgs(rest: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const token of rest.split(/\s+/).filter(Boolean)) {
    const idx = token.indexOf("=");
    if (idx <= 0) continue;
    const k = token.slice(0, idx).trim().toLowerCase();
    const v = token.slice(idx + 1).trim();
    if (!k || !v) continue;
    out[k] = v;
  }
  return out;
}

async function handleHelp(chatId: string) {
  const lines = [
    "명령어:",
    "/cafes : 가입 카페(캐시된) 목록 일부 보기",
    "/scrape <cafeId들> <키워드들> : 예) /scrape remonterrace 단발,인테리어",
    "/scrape cafes=... keywords=... minView=... minComment=... max=... : 예) /scrape cafes=remonterrace keywords=단발,인테리어 max=80",
    "",
    "주의:",
    "- 키워드는 쉼표(,)로 구분하고 공백은 자동 제거합니다.",
    "- 실제 스크랩 실행은 Worker가 처리합니다. (느리게/안전하게 1개씩)",
  ];
  await telegramSendMessage(chatId, lines.join("\n"));
}

async function handleCafes(chatId: string) {
  const cafes = await prisma.cafeMembership.findMany({
    orderBy: [{ name: "asc" }],
    take: 40,
  });
  if (cafes.length === 0) {
    await telegramSendMessage(
      chatId,
      "가입 카페 목록이 비어있습니다.\nWorker가 cafes를 갱신하기 전이거나, 세션(storageState)이 아직 저장되지 않았을 수 있습니다."
    );
    return;
  }

  const lines = cafes.map((c) => `- ${c.name} (${c.cafeId})`);
  await telegramSendMessage(chatId, ["가입 카페(일부):", ...lines].join("\n"));
}

async function handleScrape(chatId: string, rest: string) {
  const kv = parseKeyValueArgs(rest);

  let cafeIds: string[] = [];
  let keywords: string[] = [];
  let minViewCount: number | null = null;
  let minCommentCount: number | null = null;
  let maxPosts = 80;
  let useAutoFilter = true;
  const excludeBoards = parseCommaList(kv.excludeboards || kv.excludeBoard || "");

  if (Object.keys(kv).length > 0) {
    cafeIds = parseCommaList(kv.cafes || kv.cafe || "");
    keywords = parseCommaList(kv.keywords || kv.kw || "");
    if (kv.minview) minViewCount = Number(kv.minview);
    if (kv.mincomment) minCommentCount = Number(kv.mincomment);
    if (kv.max) maxPosts = Number(kv.max);
    if (kv.autofilter) useAutoFilter = kv.autofilter === "1" || kv.autofilter === "true";
  } else {
    const parts = rest.split(/\s+/).filter(Boolean);
    cafeIds = parseCommaList(parts[0] || "");
    keywords = parseCommaList(parts.slice(1).join(" "));
  }

  if (cafeIds.length === 0 || keywords.length === 0) {
    await telegramSendMessage(chatId, "형식이 올바르지 않습니다. /help 를 참고하세요.");
    return;
  }

  if (!Number.isFinite(maxPosts) || maxPosts <= 0) maxPosts = 80;
  maxPosts = Math.min(300, Math.floor(maxPosts));

  if (minViewCount !== null && !Number.isFinite(minViewCount)) minViewCount = null;
  if (minCommentCount !== null && !Number.isFinite(minCommentCount)) minCommentCount = null;
  if (minViewCount !== null) minViewCount = Math.max(0, Math.floor(minViewCount));
  if (minCommentCount !== null) minCommentCount = Math.max(0, Math.floor(minCommentCount));

  const memberships = await prisma.cafeMembership.findMany({
    where: { cafeId: { in: cafeIds } },
  });
  const cafeNames = cafeIds.map((id) => memberships.find((m) => m.cafeId === id)?.name || id);

  const baseData: Prisma.ScrapeJobCreateInput = {
    createdBy: `telegram:${chatId}`,
    jobType: "SCRAPE",
    status: "QUEUED",
    notifyChatId: chatId,
    keywords: JSON.stringify(keywords),
    includeWords: JSON.stringify([]),
    excludeWords: JSON.stringify([]),
    minViewCount,
    minCommentCount,
    useAutoFilter,
    maxPosts,
    cafeIds: JSON.stringify(cafeIds),
    cafeNames: JSON.stringify(cafeNames),
  };

  let job;
  try {
    job = await prisma.scrapeJob.create({
      data: {
        ...baseData,
        excludeBoards: JSON.stringify(excludeBoards),
      },
    });
  } catch (error) {
    if (isExcludeBoardsSchemaMismatch(error)) {
      job = await prisma.scrapeJob.create({ data: baseData });
    } else {
      throw error;
    }
  }

  await telegramSendMessage(
    chatId,
    `작업 등록 완료 (QUEUED)\njobId=${job.id}\n카페=${cafeIds.join(",")}\n키워드=${keywords.join(",")}\nmaxPosts=${maxPosts}`
  );
}

export async function POST(request: Request) {
  const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
  if (secret) {
    const header = request.headers.get("x-telegram-bot-api-secret-token");
    if (header !== secret) {
      return NextResponse.json({ ok: true });
    }
  }

  const update = await request.json().catch(() => null);
  const message = update?.message || update?.edited_message;
  const text: string | undefined = message?.text;
  const chatId = message?.chat?.id ? String(message.chat.id) : null;
  if (!text || !chatId) return NextResponse.json({ ok: true });
  if (!isAllowedChatId(chatId)) return NextResponse.json({ ok: true });

  const cmd = extractCommandText(text);
  if (!cmd) return NextResponse.json({ ok: true });

  try {
    if (cmd.cmd === "help" || cmd.cmd === "start") {
      await handleHelp(chatId);
    } else if (cmd.cmd === "cafes") {
      await handleCafes(chatId);
    } else if (cmd.cmd === "scrape") {
      await handleScrape(chatId, cmd.rest);
    } else {
      await telegramSendMessage(chatId, "알 수 없는 명령입니다. /help 를 참고하세요.");
    }
  } catch (error) {
    console.error("telegram webhook error:", error);
    await telegramSendMessage(
      chatId,
      `오류: ${error instanceof Error ? error.message : String(error)}`
    ).catch(() => undefined);
  }

  return NextResponse.json({ ok: true });
}
