export interface SheetPostPayload {
  jobId: string;
  sourceUrl: string;
  cafeId: string;
  cafeName: string;
  cafeUrl: string;
  title: string;
  authorName: string;
  publishedAt: string;
  viewCount: number;
  likeCount: number;
  commentCount: number;
  contentText: string;
}

export interface SheetCommentPayload {
  jobId: string;
  sourceUrl: string;
  cafeId: string;
  cafeName: string;
  cafeUrl: string;
  commentAuthor: string;
  commentBody: string;
  commentLikeCount: number;
  commentWrittenAt: string;
}

// Google Sheets has a per-cell character limit (commonly ~50k). We keep a safety margin
// to avoid Apps Script setValues failures, while storing the full text in DB/CSV.
function clampForSheetCell(input: string, maxChars = 45000): string {
  const s = input || "";
  if (s.length <= maxChars) return s;
  const suffix = `\n\n[TRUNCATED: ${s.length} chars]`;
  return s.slice(0, Math.max(0, maxChars - suffix.length)) + suffix;
}

export async function sendRowsToGoogleSheet(
  postRows: SheetPostPayload[],
  commentRows: SheetCommentPayload[]
): Promise<void> {
  const endpoint = process.env.GSHEET_WEBHOOK_URL;
  if (!endpoint) {
    return;
  }

  const safePostRows = postRows.map((r) => ({
    ...r,
    contentText: clampForSheetCell(r.contentText),
  }));

  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    // User request: write only to "posts" sheet. Do not send commentRows.
    body: JSON.stringify({ postRows: safePostRows }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Google Sheet sync failed: ${response.status} ${text}`);
  }
}
