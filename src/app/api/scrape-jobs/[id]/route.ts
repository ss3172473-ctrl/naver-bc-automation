import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getCurrentUser } from "@/lib/auth";

export async function GET(
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
  const job = await prisma.scrapeJob.findUnique({
    where: { id },
    select: {
      id: true,
      createdBy: true,
      status: true,
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
      posts: {
        select: {
          id: true,
          sourceUrl: true,
          cafeId: true,
          cafeName: true,
          cafeUrl: true,
          title: true,
          authorName: true,
          publishedAt: true,
          viewCount: true,
          likeCount: true,
          commentCount: true,
          contentText: true,
          contentHash: true,
          rawHtml: true,
          createdAt: true,
          updatedAt: true,
          comments: {
            select: {
              id: true,
              authorName: true,
              body: true,
              likeCount: true,
              writtenAt: true,
              createdAt: true,
            },
          },
        },
        orderBy: { createdAt: "desc" },
      }
    },
  });

  if (!job) {
    return NextResponse.json(
      { success: false, error: "작업을 찾을 수 없습니다." },
      { status: 404 }
    );
  }

  const safeJob = {
    ...job,
    maxPosts: Math.min(300, Math.max(1, Math.floor(Number(job.maxPosts || 0)))),
  };
  return NextResponse.json({ success: true, data: safeJob });
}
