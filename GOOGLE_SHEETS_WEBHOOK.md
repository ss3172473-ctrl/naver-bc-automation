# Google Sheets Webhook (Apps Script)

Create Google Apps Script and deploy as Web App.
Use this script:

```javascript
function doPost(e) {
  const body = JSON.parse(e.postData.contents || '{}');
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const postSheet = ss.getSheetByName('posts') || ss.insertSheet('posts');

  if (postSheet.getLastRow() === 0) {
    postSheet.appendRow(['jobId','sourceUrl','cafeId','cafeName','cafeUrl','title','authorName','publishedAt','viewCount','likeCount','commentCount','contentText']);
  }

  const postRows = Array.isArray(body.postRows) ? body.postRows : [];

  if (postRows.length > 0) {
    const values = postRows.map(r => [
      r.jobId || '', r.sourceUrl || '', r.cafeId || '', r.cafeName || '', r.cafeUrl || '', r.title || '',
      r.authorName || '', r.publishedAt || '', Number(r.viewCount || 0), Number(r.likeCount || 0),
      Number(r.commentCount || 0), r.contentText || ''
    ]);
    postSheet.getRange(postSheet.getLastRow() + 1, 1, values.length, values[0].length).setValues(values);
  }

  return ContentService.createTextOutput(JSON.stringify({ success: true }))
    .setMimeType(ContentService.MimeType.JSON);
}
```

Deploy settings:
- Execute as: Me
- Who has access: Anyone with link (or restricted with verification layer)

Copy Web App URL to `GSHEET_WEBHOOK_URL`.
