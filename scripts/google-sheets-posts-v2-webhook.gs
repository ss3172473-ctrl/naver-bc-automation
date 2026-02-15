/**
 * Google Apps Script webhook for naver-bc-automation.
 * - writes only to "posts_v2" sheet
 * - accepts only body.postRowsV2 payload
 */
function doPost(e) {
  const body = parseBody(e);
  const rows = Array.isArray(body.postRowsV2) ? body.postRowsV2 : [];

  const sheet = getOrCreateSheet_("posts_v2");
  ensureHeader_(sheet);
  appendRows_(sheet, rows);

  return ContentService
    .createTextOutput(JSON.stringify({ success: true, added: rows.length }))
    .setMimeType(ContentService.MimeType.JSON);
}

function parseBody(e) {
  try {
    if (e && e.postData && e.postData.contents) {
      return JSON.parse(e.postData.contents);
    }
  } catch (err) {
    return {};
  }
  return {};
}

function getOrCreateSheet_(name) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  return ss.getSheetByName(name) || ss.insertSheet(name);
}

function ensureHeader_(sheet) {
  if (sheet.getLastRow() !== 0) return;
  sheet.appendRow([
    "jobId", "sourceUrl", "cafeId", "cafeName", "cafeUrl",
    "title", "authorName", "publishedAt",
    "viewCount", "likeCount", "commentCount",
    "bodyText", "commentsText"
  ]);
}

function appendRows_(sheet, postRows) {
  if (!postRows.length) return;

  const values = postRows.map((r) => [
    r.jobId || "",
    r.sourceUrl || "",
    r.cafeId || "",
    r.cafeName || "",
    r.cafeUrl || "",
    r.title || "",
    r.authorName || "",
    r.publishedAt || "",
    Number(r.viewCount || 0),
    Number(r.likeCount || 0),
    Number(r.commentCount || 0),
    r.bodyText || "",
    r.commentsText || ""
  ]);

  sheet
    .getRange(sheet.getLastRow() + 1, 1, values.length, values[0].length)
    .setValues(values);
}
