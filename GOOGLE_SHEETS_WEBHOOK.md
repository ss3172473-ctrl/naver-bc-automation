# Google Sheets Webhook (Apps Script)

현재 배포(샘플):

- `AKfycbzIFtOr6yGpeh2ZVqdsP2Bt4Ekt7Q7GfV6LGTo5pLR2AE-HqYQGFkP-7EX6fCTd5HLQcA`
- URL:
  `https://script.google.com/macros/s/AKfycbzIFtOr6yGpeh2ZVqdsP2Bt4Ekt7Q7GfV6LGTo5pLR2AE-HqYQGFkP-7EX6fCTd5HLQcA/exec`

배포 URL은 매번 바뀔 수 있으므로, 실제 운영 중인 URL은 `.env`의 `GSHEET_WEBHOOK_URL`에 넣어두고 사용하세요.

Create Google Apps Script and deploy as Web App.
Use this script (**posts_v2 only**; do not keep old `posts`/`comments` sheet logic):

```javascript
function doPost(e) {
  const body = JSON.parse(e.postData.contents || '{}');
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const postSheetV2 = ss.getSheetByName('posts_v2') || ss.insertSheet('posts_v2');

  if (postSheetV2.getLastRow() === 0) {
    postSheetV2.appendRow([
      'jobId', 'sourceUrl', 'cafeId', 'cafeName', 'cafeUrl',
      'title', 'authorName', 'publishedAt',
      'viewCount', 'likeCount', 'commentCount',
      'bodyText', 'commentsText'
    ]);
  }

  const postRows = Array.isArray(body.postRowsV2) ? body.postRowsV2 : [];
  if (postRows.length > 0) {
    const values = postRows.map(r => [
      r.jobId || '', r.sourceUrl || '', r.cafeId || '', r.cafeName || '', r.cafeUrl || '',
      r.title || '', r.authorName || '', r.publishedAt || '',
      Number(r.viewCount || 0), Number(r.likeCount || 0),
      Number(r.commentCount || 0), r.bodyText || '', r.commentsText || ''
    ]);
    postSheetV2.getRange(postSheetV2.getLastRow() + 1, 1, values.length, values[0].length).setValues(values);
  }

  return ContentService.createTextOutput(JSON.stringify({ success: true }))
    .setMimeType(ContentService.MimeType.JSON);
}
```

Deploy settings:
- Execute as: Me
- Who has access: Anyone with link (or restricted with verification layer)

Copy Web App URL to `GSHEET_WEBHOOK_URL`.
