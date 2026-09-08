import type { Notification, Notifier } from "./notifier";
import { defaultFetch } from "../http";

export class TelegramNotifier implements Notifier {
  constructor(
    private token: string,
    private chatId: string,
    private fetchImpl: typeof fetch = defaultFetch,
  ) {}
  async send(n: Notification): Promise<void> {
    const res = await this.fetchImpl(`https://api.telegram.org/bot${this.token}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json; charset=utf-8" },
      body: JSON.stringify({ chat_id: this.chatId, text: `${n.text}\n${n.adminLink}`, disable_web_page_preview: true }),
    });
    if (!res.ok) throw new Error(`telegram sendMessage failed: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
  }
}
