import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getCurrentUser } from "@/lib/auth";

export const runtime = "nodejs";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json(
      { success: false, error: "UNAUTHORIZED" },
      { status: 401 }
    );
  }

  const { id } = await params;

  const job = await prisma.scrapeJob.findUnique({ where: { id } });
  if (!job) {
    return NextResponse.json(
      { success: false, error: "작업을 찾을 수 없습니다." },
      { status: 404 }
    );
  }

  if (job.status === "RUNNING") {
    return NextResponse.json(
      { success: false, error: "이미 실행 중인 작업입니다." },
      { status: 409 }
    );
  }

  // Vercel(Serverless)에서는 Playwright 스크랩을 직접 실행하면 시간 제한/중단 문제가 생깁니다.
  // 실제 실행은 별도 Worker가 QUEUED 작업을 가져가 처리합니다.
  await prisma.scrapeJob.update({
    where: { id },
    data: {
      status: "QUEUED",
      startedAt: null,
      completedAt: null,
      errorMessage: null,
    },
  });

  return NextResponse.json({
    success: true,
    message: "작업을 QUEUED로 등록했습니다. Worker가 순서대로 실행합니다.",
  });
}
