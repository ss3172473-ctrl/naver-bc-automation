import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getCurrentUser } from "@/lib/auth";

export const runtime = "nodejs";

function progressKey(jobId: string) {
  return `scrapeJobProgress:${jobId}`;
}

export async function GET(
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
    select: { id: true, status: true, startedAt: true, createdAt: true },
  });
  if (!job) {
    return NextResponse.json(
      { success: false, error: "작업을 찾을 수 없습니다." },
      { status: 404 }
    );
  }

  const row = await prisma.setting.findUnique({ where: { key: progressKey(id) } });
  let progress: any = null;
  if (row?.value) {
    try {
      progress = JSON.parse(row.value);
    } catch {
      progress = { raw: row.value };
    }
  }

  return NextResponse.json({ success: true, data: { job, progress } });
}

