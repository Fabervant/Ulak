import type { MessageRow } from "../messages";
import type { Env } from "../env";
import { TelegramNotifier } from "./telegram";

export interface Notification {
  text: string;
  /** Absent on an owner notice, which has no thread in the admin panel. */
  adminLink?: string;
}

export interface Notifier {
  send(n: Notification): Promise<void>;
}

export class NoopNotifier implements Notifier {
  async send(): Promise<void> {}
}

export function buildNotification(row: MessageRow, adminUrl: string): Notification {
  const head = `[${row.app}] ${row.app} ${row.app_version} ${row.platform} ${row.locale ?? "-"}`;
  const body = row.message.length ? row.message : "(crash report, no message)";
  const err = row.last_error ? `\nerror: ${row.last_error.slice(0, 200)}` : "";
  const text = `${head}\n${body.slice(0, 800)}${body.length > 800 ? "…" : ""}${err}`;
  return { text, adminLink: `${adminUrl.replace(/\/$/, "")}/m/${row.id}` };
}

/** The channel that reaches the operator, or null when this instance has none that can send. */
export function channelFromEnv(env: Env): Notifier | null {
  if (env.NOTIFIER === "telegram" && env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID) return new TelegramNotifier(env.TELEGRAM_BOT_TOKEN, env.TELEGRAM_CHAT_ID);
  return null;
}

export function notifierFromEnv(env: Env): Notifier {
  const channel = channelFromEnv(env);
  if (channel) return channel;
  if (env.NOTIFIER === "telegram") throw new Error("NOTIFIER=telegram needs TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID secrets");
  return new NoopNotifier();
}
