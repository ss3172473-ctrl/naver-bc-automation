import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { encryptString } from "@/lib/crypto";

export const runtime = "nodejs";

const STORAGE_STATE_KEY = "naverCafeStorageStateEnc";

export async function GET() {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json(
      { success: false, error: "UNAUTHORIZED" },
      { status: 401 }
    );
  }

  try {
    const row = await prisma.setting.findUnique({ where: { key: STORAGE_STATE_KEY } });

    return NextResponse.json({
      success: true,
      data: {
        hasSession: !!row?.value,
        isValid: !!row?.value,
        lastChecked: row?.updatedAt?.toISOString() || null,
        sessionPath: "DB(Setting)",
      },
    });
  } catch (error) {
    console.error("세션 조회 실패:", error);
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "세션 조회 실패",
      },
      { status: 500 }
    );
  }
}

export async function POST(request: Request) {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json(
      { success: false, error: "UNAUTHORIZED" },
      { status: 401 }
    );
  }

  try {
    const body = await request.json().catch(() => ({} as any));
    const storageState = body?.storageState;
    if (!storageState) {
      return NextResponse.json(
        {
          success: false,
          error:
            "storageState가 필요합니다. (Playwright storageState JSON 전체를 그대로 붙여 넣으세요.)",
        },
        { status: 400 }
      );
    }

    const secret = process.env.APP_AUTH_SECRET || "";
    const json = typeof storageState === "string" ? storageState : JSON.stringify(storageState);
    // Validate JSON
    JSON.parse(json);

    const enc = encryptString(json, secret);
    await prisma.setting.upsert({
      where: { key: STORAGE_STATE_KEY },
      create: { key: STORAGE_STATE_KEY, value: enc },
      update: { value: enc },
    });

    return NextResponse.json({ success: true, message: "세션(storageState) 저장 완료" });
  } catch (error) {
    console.error("세션 저장 실패:", error);
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : "세션 저장 실패" },
      { status: 500 }
    );
  }
}

export async function DELETE() {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json(
      { success: false, error: "UNAUTHORIZED" },
      { status: 401 }
    );
  }

  await prisma.setting.delete({ where: { key: STORAGE_STATE_KEY } }).catch(() => undefined);
  return NextResponse.json({ success: true, message: "세션 삭제 완료" });
}
