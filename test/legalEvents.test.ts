import { env } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import { runOutbox, tellFailures } from "../src/core/mail/job";
import { applyEvent } from "../src/core/mail/webhook";
import { untoldFailures } from "../src/core/mail/outbox";
import { closeAlert, openUndelivered, tellAlerts } from "../src/core/mail/legal";
import { addMinutes, nowIso } from "../src/core/time";
import {
  ADDRESS,
  alerts,
  calls,
  copy,
  down,
  event,
  idOf,
  legalApp,
  lenv,
  lines,
  mailRow,
  malformed,
  refusedAddress,
  replies,
  sendLegal,
  signedPayloadEvent,
} from "./legalHarness";

// ---------------------------------------------------------------------------------------------
describe("task 5: stamps and alerts on every transition", () => {
  it("the vendor refuses the address: held alert, told once, and no phase-0 line", async () => {
    const key = await legalApp();
    replies.push(refusedAddress);
    const id = await idOf(await sendLegal(key));
    expect((await mailRow(id)).status).toBe("refused");
    expect((await alerts(id)).map((a) => a.kind)).toEqual(["held"]);
    expect(lines).toHaveLength(1);
    expect(await untoldFailures(env.DB)).toEqual([]);
  });

  it("the vendor calls it malformed: failed alert", async () => {
    const key = await legalApp();
    replies.push(malformed);
    const id = await idOf(await sendLegal(key));
    expect((await alerts(id)).map((a) => a.kind)).toEqual(["failed"]);
    expect((await copy(id))!.sent_at).toBeNull();
  });

  it("given up at expiry: given_up alert and exactly one Telegram line", async () => {
    const key = await legalApp();
    replies.push(down);
    const id = await idOf(await sendLegal(key, { expires_at: addMinutes(nowIso(), 10) }));
    const after = addMinutes(nowIso(), 11);
    await runOutbox(lenv(), after);
    await runOutbox(lenv(), addMinutes(after, 5));
    expect((await alerts(id)).map((a) => a.kind)).toEqual(["given_up"]);
    expect(lines).toEqual(["[shop] legal document given_up: open in the admin panel\nhttps://admin.example.invalid/legal"]);
  });

  it("a delivered event stamps the copy with its time and receiving server, once", async () => {
    const key = await legalApp();
    const id = await idOf(await sendLegal(key));
    await event(id, "email_delivered", { details: { delivered_to_server: "mx.example.org", time: "x" } });
    const c = (await copy(id))!;
    expect(c.delivered_at).not.toBeNull();
    expect(c.delivered_server).toBe("mx.example.org");
    await event(id, "email_delivered", { details: { mx: "other.example.net" } });
    expect((await copy(id))!).toMatchObject({ delivered_at: c.delivered_at, delivered_server: "mx.example.org" });
  });

  it("the first delivered event is kept as the vendor sent it, once, and only that event of a batch", async () => {
    const key = await legalApp();
    const id = await idOf(await sendLegal(key));
    const other = await idOf(await sendLegal(key, { idempotency_key: "sale-other-0001", document: { version: "v1", reference: "O-2", sale: "one_off" } }));
    // A payload of one event, spaced as a vendor might: kept byte for byte.
    const one = JSON.stringify({ event_name: ["delivered"], event_message: [{ email_info: { client_reference: id }, event_data: [{ object: "email_delivery", details: [{ status: "DELIVERED" }] }], request_id: "req-1" }] }, null, 1);
    expect(await signedPayloadEvent(one)).toEqual({ applied: 1 });
    expect((await copy(id))!.delivered_event).toBe(one);
    // A replay with other text changes nothing.
    await event(id, "email_delivered");
    expect((await copy(id))!.delivered_event).toBe(one);
    // A batch: each copy keeps its own event, never the other's.
    const mine = { event_name: "delivered", event_message: [{ email_info: { client_reference: other }, event_data: [{ object: "email_delivery" }], request_id: "req-2" }] };
    const theirs = { event_name: "delivered", event_message: [{ email_info: { client_reference: "someone-else" }, event_data: [{ object: "email_delivery" }], request_id: "req-3" }] };
    await signedPayloadEvent(JSON.stringify([theirs, mine]));
    expect((await copy(other))!.delivered_event).toBe(JSON.stringify(mine));
  });

  it("a delivered copy with no event text kept gets the next event's text, never replacing one, nor its time", async () => {
    const key = await legalApp();
    const id = await idOf(await sendLegal(key));
    await event(id, "email_delivered", { details: { status: "DELIVERED" } });
    const first = (await copy(id))!.delivered_at;
    // A copy stamped before event texts were kept.
    await env.DB.prepare("UPDATE legal_documents SET delivered_event=NULL WHERE mail_id=?").bind(id).run();
    const a = JSON.stringify({ event_name: "delivered", event_message: [{ email_info: { client_reference: id }, event_data: [{ object: "email_delivery" }], request_id: "req-a" }] });
    await signedPayloadEvent(a);
    await event(id, "email_delivered", { details: { delivered_to_server: "mx.example.org" } });
    expect(await copy(id)).toMatchObject({ delivered_at: first, delivered_server: "mx.example.org", delivered_event: a });
  });

  it("a receiving server that is not shaped as a host is not kept", async () => {
    const key = await legalApp();
    const id = await idOf(await sendLegal(key));
    await event(id, "email_delivered", { details: { server_response: `250 ok ${ADDRESS}` } });
    expect((await copy(id))!.delivered_server).toBeNull();
  });

  it("a delivered event stamps the copy even after the transport row is gone, found by the vendor's id", async () => {
    const key = await legalApp();
    const id = await idOf(await sendLegal(key));
    await env.DB.prepare("DELETE FROM mails WHERE id=?").bind(id).run();
    await event(null, "email_delivered", { requestId: "req-1" });
    expect((await copy(id))!.delivered_at).not.toBeNull();
  });

  it("a delivery closes the open undelivered alert by itself", async () => {
    const key = await legalApp();
    const id = await idOf(await sendLegal(key));
    expect(await openUndelivered(env.DB, addMinutes(nowIso(), 61))).toBe(1);
    await event(id, "email_delivered");
    expect(await alerts(id)).toMatchObject([{ kind: "undelivered", close_reason: "delivered" }]);
    expect((await alerts(id))[0].closed_at).not.toBeNull();
  });

  it("a later delivered event adds the receiving server and never moves the delivered time", async () => {
    const key = await legalApp();
    const id = await idOf(await sendLegal(key));
    await event(id, "email_delivered", { details: { status: "DELIVERED" } });
    const first = (await copy(id))!;
    expect(first.delivered_server).toBeNull();
    await event(id, "email_delivered", { details: { delivered_to_server: "mx.example.org" } });
    expect(await copy(id)).toMatchObject({ delivered_at: first.delivered_at, delivered_server: "mx.example.org" });
  });

  it("a hard bounce opens bounced once; a replay after closing does not reopen it", async () => {
    const key = await legalApp();
    const id = await idOf(await sendLegal(key));
    await event(id, "hardbounce");
    await event(id, "hardbounce");
    let a = await alerts(id);
    expect(a.map((x) => x.kind)).toEqual(["bounced"]);
    await closeAlert(env.DB, a[0].id, "sent by hand", null, nowIso());
    await event(id, "hardbounce");
    a = await alerts(id);
    expect(a).toHaveLength(1);
    expect(a[0].closed_at).not.toBeNull();
  });

  it("a spam complaint and a soft bounce open no alert", async () => {
    const key = await legalApp();
    const a = await idOf(await sendLegal(key));
    const b = await idOf(await sendLegal(key));
    await event(a, "feedback_loop");
    await event(b, "softbounce");
    expect(await alerts()).toEqual([]);
  });

  it("an undelivered alert and a later bounce are two alerts, each told once", async () => {
    const key = await legalApp();
    const id = await idOf(await sendLegal(key));
    await runOutbox(lenv(), addMinutes(nowIso(), 61));
    await event(id, "hardbounce");
    await tellAlerts(lenv());
    // The undelivered alert was opened at a clock an hour ahead, so order by kind, not by time.
    expect((await alerts(id)).map((x) => x.kind).sort()).toEqual(["bounced", "undelivered"]);
    expect(lines.map((l) => l.split("\n")[0]).sort()).toEqual(["[shop] legal document bounced: open in the admin panel", "[shop] legal document undelivered: open in the admin panel"]);
  });

  it("race: a bounce that lands mid-attempt wins; the attempt's late write records nothing, the event records the acceptance", async () => {
    const key = await legalApp();
    let id = "";
    replies.push(async () => {
      // The vendor took the mail and its bounce arrived before Ulak wrote the acceptance.
      id = (await env.DB.prepare("SELECT id FROM mails").first<{ id: string }>())!.id;
      await applyEvent(env.DB, { type: "hardbounce", ref: id, requestId: null, reason: "x" }, nowIso());
      return new Response(JSON.stringify({ request_id: "req-late" }), { status: 200 });
    });
    await sendLegal(key);
    expect((await mailRow(id)).status).toBe("bounced");
    const c = (await copy(id))!;
    expect(c.vendor_request_id).toBeNull(); // never the losing write's "req-late"
    expect(c.sent_at).not.toBeNull(); // the bounce proves the vendor had it
    expect((await alerts(id)).map((x) => x.kind)).toEqual(["bounced"]);
  });

  it("race: a refusal whose write lost to a delivery opens no held alert", async () => {
    const key = await legalApp();
    replies.push(async () => {
      const id = (await env.DB.prepare("SELECT id FROM mails").first<{ id: string }>())!.id;
      await applyEvent(env.DB, { type: "delivered", ref: id, requestId: "req-d", server: null, raw: "{}" }, nowIso());
      return refusedAddress();
    });
    const id = await idOf(await sendLegal(key));
    expect((await mailRow(id)).status).toBe("delivered");
    expect(await alerts(id)).toEqual([]);
  });

  it("a delivered copy that later bounces cannot close its alert with itself", async () => {
    const key = await legalApp();
    const id = await idOf(await sendLegal(key));
    await event(id, "email_delivered");
    await event(id, "hardbounce");
    const [a] = await alerts(id);
    await expect(closeAlert(env.DB, a.id, "itself", id, nowIso())).rejects.toMatchObject({ status: 400 });
  });

  it("an event fills a missing acceptance with its time and the vendor's id, and never overwrites one", async () => {
    const key = await legalApp();
    const id = await idOf(await sendLegal(key));
    const first = (await copy(id))!;
    await event(id, "softbounce", { requestId: "req-other" });
    expect((await copy(id))!).toMatchObject({ sent_at: first.sent_at, vendor_request_id: "req-1" });
    await env.DB.prepare("UPDATE legal_documents SET sent_at=NULL, vendor_request_id=NULL WHERE mail_id=?").bind(id).run();
    await env.DB.prepare("DELETE FROM mails WHERE id=?").bind(id).run();
    await event(id, "feedback_loop", { requestId: "req-1" });
    const c = (await copy(id))!;
    expect(c.vendor_request_id).toBe("req-1");
    expect(c.sent_at).not.toBeNull();
  });

  it("a stopped Worker's lost stamp and lost alerts are repaired by the 5-minute job, once", async () => {
    const key = await legalApp();
    const sent = await idOf(await sendLegal(key));
    replies.push(refusedAddress);
    const refused = await idOf(await sendLegal(key));
    replies.push(down);
    const gone = await idOf(await sendLegal(key, { expires_at: addMinutes(nowIso(), 10) }));
    await runOutbox(lenv(), addMinutes(nowIso(), 11));
    // What a Worker stopped between its two writes leaves: the transport row written, the copy's part not.
    await env.DB.prepare("UPDATE legal_documents SET sent_at=NULL, vendor_request_id=NULL WHERE mail_id=?").bind(sent).run();
    await env.DB.prepare("DELETE FROM legal_alerts").run();
    lines.length = 0;
    await runOutbox(lenv(), addMinutes(nowIso(), 12));
    const s = (await copy(sent))!;
    expect(s.vendor_request_id).toBe("req-1");
    expect(s.sent_at).toBe((await mailRow(sent)).sent_at);
    expect((await alerts(refused)).map((a) => a.kind)).toEqual(["held"]);
    expect((await alerts(gone)).map((a) => a.kind)).toEqual(["given_up"]);
    expect(lines).toHaveLength(2);
    await runOutbox(lenv(), addMinutes(nowIso(), 17));
    expect(await alerts()).toHaveLength(2);
    expect(lines).toHaveLength(2);
  });

  it("a failed legal mail gets its alert line, never the transport failure line too", async () => {
    const key = await legalApp();
    replies.push(malformed);
    await sendLegal(key);
    lines.length = 0;
    expect(await tellFailures(lenv())).toBe(0);
    expect(lines).toEqual([]);
  });
});
