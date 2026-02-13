export async function telegramSendMessage(
  chatId: string,
  text: string,
  options?: { disableWebPagePreview?: boolean }
): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) return;

  const url = `https://api.telegram.org/bot${token}/sendMessage`;
  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      disable_web_page_preview: options?.disableWebPagePreview ?? true,
    }),
  });

  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    throw new Error(`telegram sendMessage failed: ${resp.status} ${body}`);
  }
}

