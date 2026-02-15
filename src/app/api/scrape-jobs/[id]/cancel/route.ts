import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getCurrentUser } from "@/lib/auth";

export const runtime = "nodejs";

function cancelKey(jobId: string) {
  return `scrapeJobCancel:${jobId}`;
}

export async function POST(
  _request: Request,
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
  const job = await prisma.scrapeJob.findUnique({
    where: { id },
    select: { id: true, status: true },
  });
  if (!job) {
    return NextResponse.json(
      { success: false, error: "작업을 찾을 수 없습니다." },
      { status: 404 }
    );
  }

  // If it's still queued, we can cancel immediately (no Worker involvement).
  if (job.status === "QUEUED") {
    await prisma.scrapeJob.update({
      where: { id },
      data: {
        status: "CANCELLED",
        completedAt: new Date(),
        errorMessage: "cancelled by user (queued)",
      },
    });
    await prisma.setting.deleteMany({
      where: { key: { in: [`scrapeJobProgress:${id}`, cancelKey(id)] } },
    });
    return NextResponse.json({ success: true, message: "대기 중인 작업을 취소했습니다." });
  }

  // Mark cancel requested; worker will stop gracefully.
  await prisma.setting.upsert({
    where: { key: cancelKey(id) },
    create: { key: cancelKey(id), value: "true" },
    update: { value: "true" },
  });

  return NextResponse.json({ success: true, message: "중단 요청을 등록했습니다." });
}
