import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getCurrentUser } from "@/lib/auth";

function parseStringList(input: unknown): string[] {
  // Accept both JSON-style arrays and comma-separated strings.
  if (Array.isArray(input)) {
    return input
      .map((item) => String(item || "").trim().replace(/\s+/g, ""))
      .filter((item) => item.length > 0);
  }
  const raw = String(input || "").trim();
  if (!raw) return [];
  return raw
    .split(",")
    .map((item) => item.trim().replace(/\s+/g, ""))
    .filter(Boolean);
}

function parseCommaList(input: unknown): string[] {
  return String(input || "")
    .split(",")
    .map((item) => item.trim().replace(/\s+/g, ""))
    .filter(Boolean);
}

function parseUrlLines(input: unknown): string[] {
  const raw = String(input || "");
  if (!raw.trim()) return [];
  return raw
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
}

function formatCreateError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const code = (error as { code?: string } | undefined)?.code;

  if (code) {
    if (code === "P1001") {
      return "데이터베이스 연결 실패. DATABASE_URL이 유효한지 확인하세요. (P1001)";
    }
    return `[${code}] ${message}`;
  }
  if (process.env.NODE_ENV === "production") {
    return "스크랩 작업 생성 중 오류가 발생했습니다.";
  }
  return message || "알 수 없는 오류";
}

export async function GET() {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json(
      { success: false, error: "UNAUTHORIZED" },
      { status: 401 }
    );
  }

  const jobs = await prisma.scrapeJob.findMany({
    orderBy: { createdAt: "desc" },
    take: 30,
  });

  return NextResponse.json({ success: true, data: jobs });
}

export async function POST(request: NextRequest) {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json(
      { success: false, error: "UNAUTHORIZED" },
      { status: 401 }
    );
  }

  try {
    let body: Record<string, unknown>;
    try {
      body = (await request.json()) as Record<string, unknown>;
    } catch {
      return NextResponse.json(
        { success: false, error: "요청 본문 JSON 파싱에 실패했습니다." },
        { status: 400 }
      );
    }

    const keywords = parseCommaList(body?.keywords);
    const directUrls = parseUrlLines(body?.directUrls);
    const selectedCafes = Array.isArray(body?.selectedCafes)
      ? body.selectedCafes
      : [];

    const cafeIds = selectedCafes
      .map((item: { cafeId?: string }) => String(item?.cafeId || "").trim())
      .filter(Boolean);

    const cafeNames = selectedCafes
      .map((item: { name?: string }) => String(item?.name || "").trim())
      .filter(Boolean);

    if (keywords.length === 0 && directUrls.length === 0) {
      return NextResponse.json(
        { success: false, error: "키워드(쉼표 구분) 또는 직접 URL(줄바꿈)을 1개 이상 입력하세요." },
        { status: 400 }
      );
    }

    if (cafeIds.length === 0) {
      return NextResponse.json(
        { success: false, error: "스크랩할 카페를 1개 이상 선택하세요." },
        { status: 400 }
      );
    }

    const rawMaxPosts = body?.maxPosts;
    const normalizedMaxPosts =
      typeof rawMaxPosts === "string" ? rawMaxPosts.trim() : rawMaxPosts;
    const hasMaxPostsValue = normalizedMaxPosts !== null && normalizedMaxPosts !== undefined && normalizedMaxPosts !== "";
    const maxPostsRaw = hasMaxPostsValue ? Number(normalizedMaxPosts) : 50;
    const maxPosts = Number.isFinite(maxPostsRaw)
      ? Math.min(300, Math.max(1, Math.floor(maxPostsRaw)))
      : 50;

    const includeKeywords = parseStringList(body?.includeKeywords);
    const excludeKeywords = parseStringList(body?.excludeKeywords);
    const excludeBoards = parseStringList(body?.excludeBoards);

    const fromDate = body?.fromDate ? new Date(body.fromDate) : null;
    const toDate = body?.toDate ? new Date(body.toDate) : null;
    const minViewCountRaw =
      body?.minViewCount === null || body?.minViewCount === undefined
        ? null
        : Number(body.minViewCount);
    const minCommentCountRaw =
      body?.minCommentCount === null || body?.minCommentCount === undefined
        ? null
        : Number(body.minCommentCount);
    const useAutoFilter = Boolean(body?.useAutoFilter);

    const minViewCount =
      minViewCountRaw !== null &&
      Number.isFinite(minViewCountRaw) &&
      minViewCountRaw >= 0
        ? Math.floor(minViewCountRaw)
        : null;
    const minCommentCount =
      minCommentCountRaw !== null &&
      Number.isFinite(minCommentCountRaw) &&
      minCommentCountRaw >= 0
        ? Math.floor(minCommentCountRaw)
        : null;

    const job = await prisma.scrapeJob.create({
      data: {
        createdBy: user.username,
        status: "QUEUED",
        keywords: JSON.stringify(keywords),
        directUrls: directUrls.length ? JSON.stringify(directUrls) : null,
        includeWords: JSON.stringify(includeKeywords),
        excludeWords: JSON.stringify(excludeKeywords),
        excludeBoards: JSON.stringify(excludeBoards),
        fromDate,
        toDate,
        minViewCount,
        minCommentCount,
        useAutoFilter,
        maxPosts,
        cafeIds: JSON.stringify(cafeIds),
        cafeNames: JSON.stringify(cafeNames),
      },
    });

    return NextResponse.json({
      success: true,
      data: job,
      message: "작업이 등록되었습니다.",
    });
  } catch (error) {
    console.error("스크랩 작업 생성 실패:", error);
    const details = formatCreateError(error);
    const isKnownError =
      details.includes("데이터베이스 연결 실패") || details.includes("[P1001]");

    return NextResponse.json(
      {
        success: false,
        error: isKnownError ? details : "스크랩 작업 생성 중 오류가 발생했습니다.",
        details,
      },
      { status: 500 }
    );
  }
}
