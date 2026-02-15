import { NextRequest, NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";

export const runtime = "nodejs";

type BoardResponse = {
  boardName: string;
};

type BodyPayload = {
  cafeIds?: unknown;
  keywords?: unknown;
};

function parseStringArray(input: unknown): string[] {
  if (Array.isArray(input)) {
    return input
      .map((value) => String(value || "").trim())
      .filter(Boolean);
  }
  if (typeof input !== "string") return [];
  return input
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

function normalizeBoardToken(value: string): string {
  return String(value || "")
    .trim()
    .replace(/\s+/g, "")
    .toLowerCase();
}

function extractClubIdFromText(input: string): string {
  const str = String(input || "");
  const patterns = [
    /clubid=(\d{4,})/i,
    /cafeId=(\d{4,})/i,
    /["']?clubId["']?\s*:\s*(\d{4,})/i,
    /\/(?:ca-fe\/cafes|ca-fe\/cafe)\/(\d{4,})/i,
    /\/(?:cafes|ca-fe\/cafes)\/(\d{4,})\//i,
  ];

  for (const re of patterns) {
    const m = str.match(re);
    if (m?.[1]) return String(m[1]);
  }
  return "";
}

function extractCafeNumericId(cafeId: string): string {
  return String(cafeId || "").trim();
}

async function resolveCafeNumericId(rawCafeId: string): Promise<string> {
  const normalized = extractCafeNumericId(rawCafeId);
  if (!normalized) return "";
  if (/^\d+$/.test(normalized)) return normalized;

  try {
    const response = await fetch(`https://cafe.naver.com/${encodeURIComponent(normalized)}`, {
      method: "GET",
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/118.0 Safari/537.36",
      },
      redirect: "follow",
    });

    const matchedFromUrl = extractClubIdFromText(response.url || "");
    if (matchedFromUrl) return matchedFromUrl;

    const html = await response.text().catch(() => "");
    return extractClubIdFromText(html);
  } catch {
    return "";
  }
}

async function fetchBoardsFromSearch(
  cafeNumericId: string,
  keyword: string
): Promise<BoardResponse[]> {
  const q = encodeURIComponent(keyword || "");
  const url =
    `https://apis.naver.com/cafe-web/cafe-mobile/CafeMobileWebArticleSearchListV4` +
    `?cafeId=${encodeURIComponent(cafeNumericId)}` +
    `&query=${q}` +
    `&searchBy=1&sortBy=date&page=1&perPage=20&adUnit=MW_CAFE_BOARD&ad=true`;

  const response = await fetch(url, {
    method: "GET",
    headers: {
      Accept: "application/json",
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/118.0 Safari/537.36",
    },
  });

  if (!response.ok) {
    throw new Error(`board search failed ${response.status}`);
  }

  const payload = await response.json().catch(() => ({}));
  const list = payload?.message?.result?.articleList || [];
  const boards: BoardResponse[] = [];

  for (const row of list) {
    if (row?.type !== "ARTICLE") continue;
    const item = row?.item;
    if (!item) continue;
    const boardName = String(
      item.boardName ||
        item.boardTitle ||
        item.menuName ||
        item.menuTitle ||
        item.board ||
        item.menu ||
        item.boardType ||
        ""
    ).trim();
    if (!boardName) continue;
    boards.push({ boardName });
  }
  return boards;
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
    let body: BodyPayload;
    try {
      body = (await request.json()) as BodyPayload;
    } catch {
      return NextResponse.json(
        { success: false, error: "요청 바디 JSON 파싱에 실패했습니다." },
        { status: 400 }
      );
    }

    const cafeIds = parseStringArray(body?.cafeIds).filter(Boolean);
    const keywords = parseStringArray(body?.keywords);

    if (cafeIds.length === 0) {
      return NextResponse.json({ success: true, data: [] });
    }

    const searchKeywords = keywords.length > 0 ? keywords.slice(0, 12) : [""]; // no keyword fallback
    const boardNameSet = new Set<string>();

    for (const rawCafeId of cafeIds) {
      const numericId = await resolveCafeNumericId(rawCafeId);
      if (!numericId) continue;
      for (const keyword of searchKeywords) {
        try {
          const boards = await fetchBoardsFromSearch(numericId, keyword);
          for (const board of boards) {
            const normalized = normalizeBoardToken(board.boardName);
            if (normalized) boardNameSet.add(board.boardName.trim());
          }
          await new Promise((resolve) => setTimeout(resolve, 200));
        } catch {
          // Ignore board-fetch failure for this cafe/keyword and continue.
        }
      }
    }

    const boardNames = Array.from(boardNameSet).sort((a, b) =>
      a.localeCompare(b, "ko")
    );
    return NextResponse.json({ success: true, data: boardNames });
  } catch (error) {
    console.error("게시판 목록 조회 실패:", error);
    return NextResponse.json(
      { success: false, error: "게시판 목록 조회에 실패했습니다." },
      { status: 500 }
    );
  }
}
