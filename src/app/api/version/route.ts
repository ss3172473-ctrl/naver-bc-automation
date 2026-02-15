import { NextResponse } from "next/server";

export const runtime = "nodejs";

export async function GET() {
  const sha =
    process.env.VERCEL_GIT_COMMIT_SHA ||
    process.env.GITHUB_SHA ||
    null;

  return NextResponse.json({
    success: true,
    data: {
      sha,
      now: new Date().toISOString(),
      vercelUrl: process.env.VERCEL_URL || null,
      deploymentId: process.env.VERCEL_DEPLOYMENT_ID || null,
    },
  });
}

