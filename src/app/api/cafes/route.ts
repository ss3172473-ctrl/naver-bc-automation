import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { prisma } from "@/lib/db";

export const runtime = "nodejs";

export async function GET() {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json(
      { success: false, error: "UNAUTHORIZED" },
      { status: 401 }
    );
  }

  try {
    // Vercel에서는 Playwright를 실행하지 않습니다.
    // 가입 카페 리스트는 Worker가 주기적으로 갱신하여 DB에 저장합니다.
    const cafes = await prisma.cafeMembership.findMany({
      orderBy: [{ name: "asc" }],
      take: 500,
    });
    return NextResponse.json({ success: true, data: cafes });
  } catch (error) {
    console.error("가입 카페 조회 실패:", error);
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "가입 카페 조회 실패",
      },
      { status: 500 }
    );
  }
}
