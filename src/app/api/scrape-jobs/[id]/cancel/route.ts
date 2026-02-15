import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getCurrentUser } from "@/lib/auth";

export const runtime = "nodejs";

function cancelKey(jobId: string) {
  return `scrapeJobCancel:${jobId}`;
}

function progressKey(jobId: string) {
  return `scrapeJobProgress:${jobId}`;
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
  const progress = await prisma.setting.findUnique({ where: { key: progressKey(id) } }).catch(() => null);
  const previous = (() => {
    if (!progress?.value) return {};
    try {
      const parsed = JSON.parse(progress.value);
      if (parsed && typeof parsed === "object") return parsed;
    } catch {
      // ignore
    }
    return {};
  })();
  const nextProgress = {
    ...previous,
    stage: "CANCELLED",
    message: "cancel requested",
    updatedAt: new Date().toISOString(),
  } as Record<string, unknown>;
  await prisma.setting.upsert({
    where: { key: progressKey(id) },
    create: {
      key: progressKey(id),
      value: JSON.stringify(nextProgress),
    },
    update: {
      value: JSON.stringify(nextProgress),
    },
  });
  await prisma.setting.upsert({
    where: { key: cancelKey(id) },
    create: { key: cancelKey(id), value: "true" },
    update: { value: "true" },
  });

  return NextResponse.json({ success: true, message: "중단 요청을 등록했습니다." });
}
