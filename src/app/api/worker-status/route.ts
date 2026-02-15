import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getCurrentUser } from "@/lib/auth";

export const runtime = "nodejs";

const WORKER_HEARTBEAT_KEY = "workerHeartbeat:queue-worker";

export async function GET() {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json(
      { success: false, error: "UNAUTHORIZED" },
      { status: 401 }
    );
  }

  const row = await prisma.setting.findUnique({ where: { key: WORKER_HEARTBEAT_KEY } });
  if (!row?.value) {
    return NextResponse.json({ success: true, data: null });
  }

  try {
    return NextResponse.json({ success: true, data: JSON.parse(row.value) });
  } catch {
    return NextResponse.json({ success: true, data: { raw: row.value } });
  }
}

