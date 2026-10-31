import { env } from "cloudflare:test";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { overLines, rateLine, tellRates, mailRates, BOUNCE_ALERT, COMPLAINT_ALERT } from "../src/core/mail/rates";
import { runOutbox } from "../src/core/mail/job";
import { TelegramNotifier } from "../src/core/notify/telegram";
import { createApp } from "../src/core/apps";
import type { Env } from "../src/core/env";
import { addMinutes, nowIso } from "../src/core/time";

describe("the vendor's bounce and complaint limits", () => {
  it("alerts at half of each vendor limit", () => {
    expect(BOUNCE_ALERT).toBe(0.025);
    expect(COMPLAINT_ALERT).toBe(0.0005);
  });
  it("nothing sent is nothing over", () => expect(overLines({ sent: 0, bounced: 0, complained: 0 })).toEqual([]));
  it("just under each line is quiet, at the line is over", () => {
    expect(overLines({ sent: 1000, bounced: 24, complained: 0 })).toEqual([]);
    expect(overLines({ sent: 1000, bounced: 25, complained: 0 })).toEqual(["bounce"]);
    expect(overLines({ sent: 2001, bounced: 0, complained: 1 })).toEqual([]);
    expect(overLines({ sent: 2000, bounced: 0, complained: 1 })).toEqual(["complaint"]);
    expect(overLines({ sent: 10, bounced: 1, complained: 1 })).toEqual(["bounce", "complaint"]);
  });
  it("the line names the rate, the counts and the vendor's limit", () => {
    expect(rateLine("bounce", { sent: 40, bounced: 2, complained: 0 })).toBe("Mail bounce rate 5.00% (2 of 40 sent in 30 days) passed 2.50%; the vendor may close the account at 5.00%");
    expect(rateLine("complaint", { sent: 400, bounced: 0, complained: 1 })).toBe("Mail spam-complaint rate 0.25% (1 of 400 sent in 30 days) passed 0.05%; the vendor may close the account at 0.10%");
  });
});

describe("telling the operator of the rates", () => {
  const tg = () => ({ ...env, NOTIFIER: "telegram", TELEGRAM_BOT_TOKEN: "t", TELEGRAM_CHAT_ID: "c" }) as Env;
  let lines: string[] = [];
  let failNext = false;
  const sendLine = TelegramNotifier.prototype.send;
  beforeEach(async () => {
    await createApp(env.DB, "demo");
    lines = [];
    failNext = false;
    TelegramNotifier.prototype.send = async function (n) {
      if (failNext) {
        failNext = false;
        throw new Error("telegram down");
      }
      lines.push(n.text);
    };
  });
  afterEach(() => {
    TelegramNotifier.prototype.send = sendLine;
  });

  let n = 0;
  async function mail(status: string, sentAt: string | null) {
    n += 1;
    const now = nowIso();
    await env.DB.prepare(
      "INSERT INTO mails (id,app,kind,label,locale,addr_hash,status,attempts,expires_at,created_at,sent_at,last_activity_at) VALUES (?,'demo','transactional','l','en',?,?,1,?,?,?,?)",
    )
      .bind(`m${n}`, `h${n}`, status, now, now, sentAt, now)
      .run();
  }

  it("counts only mails the vendor took in the last 30 days", async () => {
    const now = nowIso();
    await mail("delivered", now);
    await mail("bounced", now);
    await mail("complained", now);
    await mail("refused", null);
    await mail("bounced", addMinutes(now, -31 * 24 * 60));
    expect(await mailRates(env.DB, now)).toEqual({ sent: 3, bounced: 1, complained: 1 });
  });

  it("tells once per crossing, again only after the rate fell back, and retries a line that failed", async () => {
    const now = nowIso();
    for (let i = 0; i < 39; i++) await mail("delivered", now);
    expect(await tellRates(tg(), now)).toBe(0);
    await mail("bounced", now); // 1 of 40 = 2.5%
    failNext = true;
    expect(await tellRates(tg(), now)).toBe(0);
    expect(await tellRates(tg(), now)).toBe(1);
    expect(lines).toEqual([rateLine("bounce", { sent: 40, bounced: 1, complained: 0 })]);
    expect(await tellRates(tg(), now)).toBe(0);
    for (let i = 0; i < 10; i++) await mail("delivered", now); // 1 of 50 = 2%
    expect(await tellRates(tg(), now)).toBe(0);
    await mail("bounced", now); // 2 of 51
    expect(await tellRates(tg(), now)).toBe(1);
    expect(lines).toHaveLength(2);
  });

  it("the 5-minute job tells the rates even with mail unconfigured", async () => {
    await mail("complained", nowIso());
    expect((await runOutbox(tg(), nowIso())) as any).toMatchObject({ rates_told: 1, skipped: "mail not configured" });
    expect(lines[0]).toMatch(/^Mail spam-complaint rate 100.00%/);
  });

  it("without a channel nothing is told and nothing is recorded", async () => {
    await mail("bounced", nowIso());
    expect(await tellRates(env as Env, nowIso())).toBe(0);
    expect(await env.DB.prepare("SELECT value FROM service_state WHERE key='mail_rates'").first()).toBeNull();
  });
});
