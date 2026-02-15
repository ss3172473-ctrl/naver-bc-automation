import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getCurrentUser } from "@/lib/auth";
import { Prisma } from "@prisma/client";

export const runtime = "nodejs";

type PgExistsRow = {
  exists: boolean;
};

function toJobSelect() {
  const select: Prisma.ScrapeJobSelect = {
    id: true,
    createdBy: true,
    jobType: true,
    status: true,
    notifyChatId: true,
    keywords: true,
    directUrls: true,
    includeWords: true,
    excludeWords: true,
    fromDate: true,
    toDate: true,
    minViewCount: true,
    minCommentCount: true,
    useAutoFilter: true,
    maxPosts: true,
    cafeIds: true,
    cafeNames: true,
    resultCount: true,
    sheetSynced: true,
    resultPath: true,
    errorMessage: true,
    startedAt: true,
    completedAt: true,
    createdAt: true,
    updatedAt: true,
  };
  return select;
}

function normalizeMaxPosts(rawMaxPosts: number): number {
  return Math.min(300, Math.max(1, Math.floor(Number(rawMaxPosts || 0))));
}

function sanitizeMaxPostsOnJobs<T extends { maxPosts: number }>(jobs: T[]): Array<Omit<T, "maxPosts"> & { maxPosts: number }> {
  return jobs.map((job) => ({
    ...job,
    maxPosts: normalizeMaxPosts(job.maxPosts),
  }));
}

function isExcludeBoardsSchemaMismatch(error: unknown): boolean {
  const raw = error instanceof Error ? error.message : String(error);
  const code = (error as { code?: string } | undefined)?.code;
  const normalized = raw.toLowerCase();
  const isMissingColumn =
    (code === "P2022" || normalized.includes("does not exist")) &&
    normalized.includes("column") &&
    normalized.includes("excludeboards");

  if (isMissingColumn) return true;

  if (normalized.includes("excludeboards")) {
    return true;
  }
  return false;
}

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

function toDateValue(input: unknown): Date | null {
  if (input === null || input === undefined || input === "") return null;

  if (input instanceof Date) {
    return Number.isNaN(input.getTime()) ? null : input;
  }

  if (typeof input === "string" || typeof input === "number") {
    const parsed = new Date(input);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }

  if (typeof input === "object") {
    const value = (input as { value?: unknown }).value;
    if (typeof value === "string" || typeof value === "number") {
      const parsed = new Date(value);
      return Number.isNaN(parsed.getTime()) ? null : parsed;
    }
  }

  return null;
}

function formatCreateError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const code = (error as { code?: string } | undefined)?.code;
  const normalized = String(message || "").toLowerCase();
  if (normalized.includes("excludeboards") && normalized.includes("does not exist")) {
    return [
      "DB 스키마가 오래돼서 'ScrapeJob.excludeBoards' 컬럼이 없습니다.",
      "해결: DATABASE_URL 대상 DB에서 prisma 마이그레이션(또는 db push) 실행 필요.",
      "임시 SQL: ALTER TABLE \"ScrapeJob\" ADD COLUMN \"excludeBoards\" TEXT;",
    ].join(" ");
  }

  if (code) {
    if (code === "P1001") {
      return "데이터베이스 연결 실패. DATABASE_URL이 유효하지 않거나 네트워크가 차단되었습니다. (P1001)";
    }
    return `[${code}] ${message}`;
  }
  return message || "알 수 없는 오류";
}

async function ensureScrapeJobExcludeBoardsColumn(): Promise<void> {
  const [hasColumnRaw] = await prisma.$queryRaw<Array<PgExistsRow>>(
    Prisma.sql`
      SELECT EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'ScrapeJob'
          AND lower(column_name) = 'excludeboards'
      ) AS exists
    `
  );

  if (hasColumnRaw?.exists) {
    return;
  }

  await prisma.$executeRaw`ALTER TABLE "ScrapeJob" ADD COLUMN IF NOT EXISTS "excludeBoards" TEXT`;
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
    select: toJobSelect(),
  });

  return NextResponse.json({ success: true, data: sanitizeMaxPostsOnJobs(jobs) });
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

  const excludeKeywords = parseStringList(body?.excludeKeywords);
  const excludeBoards = parseStringList(body?.excludeBoards);

    const fromDate = toDateValue(body?.fromDate);
    const toDate = toDateValue(body?.toDate);
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

    const baseData: Prisma.ScrapeJobCreateInput = {
      createdBy: user.username,
      status: "QUEUED" as const,
      keywords: JSON.stringify(keywords),
      directUrls: directUrls.length ? JSON.stringify(directUrls) : null,
      excludeWords: JSON.stringify(excludeKeywords),
      fromDate,
      toDate,
      minViewCount,
      minCommentCount,
      useAutoFilter,
      maxPosts,
      cafeIds: JSON.stringify(cafeIds),
      cafeNames: JSON.stringify(cafeNames),
    };
    let job;
    try {
      try {
        await ensureScrapeJobExcludeBoardsColumn();
      } catch (error) {
        console.warn("excludeBoards 컬럼 확인 실패, 기본 폴백 동작으로 진행", error);
      }
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

    return NextResponse.json({
      success: true,
      data: job,
      message: "작업이 등록되었습니다.",
    });
  } catch (error) {
    console.error("스크랩 작업 생성 실패:", error);
    const details = formatCreateError(error);
    return NextResponse.json(
      {
        success: false,
        error: details || "스크랩 작업 생성 중 오류가 발생했습니다.",
        details,
      },
      { status: 500 }
    );
  }
}
