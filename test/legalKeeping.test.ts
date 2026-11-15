import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import worker from "../src/api/index";
import { updateApp, rotateKey } from "../src/core/apps";
import { runOutbox } from "../src/core/mail/job";
import { expireMails } from "../src/core/mail/outbox";
import { runScheduled } from "../src/core/retention";
import { deleteUser } from "../src/core/messages";
import { createAdminToken } from "../src/core/auth/admintoken";
import { addMinutes, nowIso } from "../src/core/time";
import { adminRequest } from "./helpers";
import {
  ADDRESS,
  legalBody,
  REFERENCE,
  VERSION,
  alerts,
  call,
  copy,
  down,
  idOf,
  legalApp,
  lenv,
  lines,
  mailRow,
  refusedAddress,
  replies,
  sendLegal,
  telegram,
} from "./legalHarness";

// ---------------------------------------------------------------------------------------------
describe("task 8: deletion and keeping", () => {
  const USER = "user-0123456789abcdef";
  it("deleting a person keeps their copies and a still-queued legal mail, without the user_ref", async () => {
    const key = await legalApp();
    const sent = await idOf(await sendLegal(key));
    replies.push(down);
    const queued = await idOf(await sendLegal(key));
    const receipt = await idOf(await call("/v1/mail", key, { ...legalBody({ kind: "transactional", label: "receipt" }), document: undefined }));
    const r = await deleteUser(lenv(), "shop", USER);
    expect(r).toEqual({ deleted_messages: 0, kept_legal_copies: 2 });
    expect(await mailRow(receipt)).toBeNull();
    expect(await mailRow(sent)).toBeNull();
    expect(await mailRow(queued)).toMatchObject({ status: "queued", user_ref: null, to_addr: ADDRESS });
    expect((await copy(sent))!.user_ref).toBeNull();
    expect((await copy(queued))!.user_ref).toBeNull();
    // The queued one is still sent.
    expect((await runOutbox(lenv(), addMinutes(nowIso(), 6))).sent).toBe(1);
  });

  it("the public deletion answers carry the kept count: by user_ref and by address", async () => {
    const key = await legalApp();
    const appKey = await rotateKey(env.DB, "shop");
    await sendLegal(key);
    const ctx = createExecutionContext();
    const del = await worker.fetch(new Request(`https://api.example.invalid/v1/messages?user_ref=${USER}`, { method: "DELETE", headers: { authorization: `Bearer ${appKey}` } }), lenv(), ctx);
    await waitOnExecutionContext(ctx);
    expect(await del.json()).toEqual({ deleted_messages: 0, kept_legal_copies: 1 });
    await sendLegal(key);
    const byAddr = await call("/v1/mail/delete", key, { address: ADDRESS });
    expect(await byAddr.json()).toEqual({ deleted_mails: 1, kept_legal_copies: 2 });
    expect((await env.DB.prepare("SELECT COUNT(*) n FROM legal_documents WHERE user_ref IS NULL").first<{ n: number }>())!.n).toBe(2);
  });

  it("deleting by address keeps a still-queued legal mail, which is still sent", async () => {
    const key = await legalApp();
    replies.push(down);
    const queued = await idOf(await sendLegal(key));
    const receipt = await idOf(await call("/v1/mail", key, { ...legalBody({ kind: "transactional", label: "receipt" }), document: undefined }));
    expect(await (await call("/v1/mail/delete", key, { address: ADDRESS })).json()).toEqual({ deleted_mails: 1, kept_legal_copies: 1 });
    expect(await mailRow(receipt)).toBeNull();
    expect(await mailRow(queued)).toMatchObject({ status: "queued", user_ref: null });
    expect((await runOutbox(lenv(), addMinutes(nowIso(), 6))).sent).toBe(1);
  });

  it("the admin JSON API's deletion answers the kept count", async () => {
    const key = await legalApp();
    await sendLegal(key);
    const { token } = await createAdminToken(env.DB, "t");
    const res = await adminRequest({ ...env, SESSION_SECRET: "s3" } as typeof env, `/api/users?app=shop&user_ref=${USER}`, { method: "DELETE", headers: { authorization: `Bearer ${token}` } });
    expect(await res.json()).toEqual({ deleted_messages: 0, kept_legal_copies: 1 });
  });

  it("the subscription's end sets only empty keeping starts, of that app and reference", async () => {
    const key = await legalApp();
    const other = await legalApp("other");
    const sub = { document: { version: VERSION, reference: REFERENCE, sale: "subscription" } };
    const a = await idOf(await sendLegal(key, sub));
    const b = await idOf(await sendLegal(key, sub)); // a renewal
    const c = await idOf(await sendLegal(other, sub));
    const ended = nowIso();
    const r = await call("/v1/mail/legal/end", key, { reference: REFERENCE, ended_at: ended });
    expect(await r.json()).toEqual({ updated: 2 });
    expect((await copy(a))!.keep_from).toBe(ended);
    expect((await copy(b))!.keep_from).toBe(ended);
    expect((await copy(c))!.keep_from).toBeNull();
    expect(await (await call("/v1/mail/legal/end", key, { reference: REFERENCE, ended_at: nowIso() })).json()).toEqual({ updated: 0 });
    expect((await copy(a))!.keep_from).toBe(ended);
  });

  it("the end call refuses a time before the newest document, and never touches a one-off sale", async () => {
    const key = await legalApp();
    const sub = await idOf(await sendLegal(key, { document: { version: VERSION, reference: REFERENCE, sale: "subscription" } }));
    const oneOff = await idOf(await sendLegal(key));
    const oneOffStart = (await copy(oneOff))!.keep_from;
    const early = await call("/v1/mail/legal/end", key, { reference: REFERENCE, ended_at: "2020-01-01T00:00:00Z" });
    expect(early.status).toBe(400);
    expect(await early.json()).toMatchObject({ error: "invalid_request", field: "ended_at" });
    expect((await copy(sub))!.keep_from).toBeNull();
    expect(await (await call("/v1/mail/legal/end", key, { reference: REFERENCE, ended_at: nowIso() })).json()).toEqual({ updated: 1 });
    expect((await copy(oneOff))!.keep_from).toBe(oneOffStart);
  });

  it("the end call refuses a future time, a bad reference, a browser and a missing key", async () => {
    const key = await legalApp();
    for (const body of [{ reference: REFERENCE, ended_at: addMinutes(nowIso(), 60) }, { reference: "a b", ended_at: nowIso() }, { reference: REFERENCE, ended_at: "yesterday" }]) {
      expect((await call("/v1/mail/legal/end", key, body)).status).toBe(400);
    }
    expect((await call("/v1/mail/legal/end", key, { reference: REFERENCE, ended_at: nowIso() }, lenv(), { origin: "https://shop.example.org" })).status).toBe(403);
    expect((await call("/v1/mail/legal/end", null, { reference: REFERENCE, ended_at: nowIso() })).status).toBe(401);
  });

  it("the hourly job deletes copies by the setting at run time, with their alerts; a subscription's copy with no end reported is kept", async () => {
    const key = await legalApp();
    replies.push(refusedAddress);
    const oneOff = await idOf(await sendLegal(key));
    const noEnd = await idOf(await sendLegal(key, { document: { version: VERSION, reference: "SUB-1", sale: "subscription" } }));
    expect(await alerts(oneOff)).toHaveLength(1);
    const in1100Days = addMinutes(nowIso(), 1100 * 24 * 60);
    expect((await runScheduled(lenv(), in1100Days)).purged_legal_copies).toBe(0);
    expect(await copy(oneOff)).not.toBeNull();
    expect((await runScheduled(lenv({ LEGAL_KEEP_YEARS: undefined }), in1100Days)).purged_legal_copies).toBe(0);
    expect((await runScheduled(lenv({ LEGAL_KEEP_YEARS: "bad" }), in1100Days)).purged_legal_copies).toBe(0);
    expect((await runScheduled(lenv({ LEGAL_KEEP_YEARS: "1" }), in1100Days)).purged_legal_copies).toBe(1);
    expect(await copy(oneOff)).toBeNull();
    expect(await alerts(oneOff)).toEqual([]); // the open alert went with it
    expect(await copy(noEnd)).not.toBeNull(); // past its own year's period, but its subscription may still run
  });

  it("one-off copies keep to their sending year + 10 (TTK 82); a subscription's to the later of that and its end year + 10 (TBK 146)", async () => {
    const put = (id: string, sentAt: string, keepFrom: string | null = sentAt) =>
      env.DB.prepare(
        `INSERT INTO legal_documents (mail_id,app,reference,version,idempotency_key,label,locale,to_addr,subject,text_body,text_sha256,addr_hash,created_at,keep_from,sent_at)
         VALUES (?1,'shop','R','v',?1,'l','en','a@example.org','s','t','h','h',?2,?3,?2)`,
      ).bind(id, sentAt, keepFrom).run();
    await put("sent-31-dec", "2026-12-31T20:59:00.000Z"); // 23:59 on 31 Dec 2026 in Türkiye (UTC+3)
    await put("sent-1-jan", "2026-12-31T21:00:00.000Z"); // 00:00 on 1 Jan 2027 in Türkiye
    await put("sub-ended-2030", "2026-06-01T09:00:00.000Z", "2030-06-01T09:00:00.000Z"); // sent 2026, ended 2030
    await put("sub-early-end", "2029-03-01T09:00:00.000Z", "2029-04-01T09:00:00.000Z"); // TTK date is the later one
    await put("sub-no-end", "2026-06-01T09:00:00.000Z", null); // its end never reported
    const purged = async (at: string) => (await runScheduled(lenv(), at)).purged_legal_copies;
    expect(await purged("2036-12-31T20:59:59.999Z")).toBe(0); // the last moment of 2036 in Türkiye: all kept
    expect(await purged("2036-12-31T21:00:00.000Z")).toBe(1); // 2037 begins: the 2026 one-off copy goes
    expect(await copy("sent-31-dec")).toBeNull();
    expect(await copy("sent-1-jan")).not.toBeNull();
    expect(await copy("sub-ended-2030")).not.toBeNull(); // past its TTK date, inside its TBK claim period
    expect(await purged("2037-12-31T20:59:59.999Z")).toBe(0);
    expect(await purged("2037-12-31T21:00:00.000Z")).toBe(1); // 2038 begins: the 2027 copy goes
    expect(await copy("sent-1-jan")).toBeNull();
    expect(await purged("2039-12-31T20:59:59.999Z")).toBe(0); // the subscription that ended in 2029 waits for its 2029 TTK date
    expect(await purged("2039-12-31T21:00:00.000Z")).toBe(1); // 2040 begins: both its dates have passed
    expect(await copy("sub-early-end")).toBeNull();
    expect(await purged("2040-12-31T20:59:59.999Z")).toBe(0); // the last moment of 2040: the 2030 end still holds it
    expect(await copy("sub-ended-2030")).not.toBeNull();
    expect(await purged("2040-12-31T21:00:00.000Z")).toBe(1); // the first moment of 2041: it goes
    expect(await copy("sub-ended-2030")).toBeNull();
    expect(await purged("2099-01-01T00:00:00.000Z")).toBe(0);
    expect(await copy("sub-no-end")).not.toBeNull(); // no end reported: never deleted at its TTK date
  });

  it("once a year the operator gets, per app, the subscription copies past their TTK date with no end reported", async () => {
    const put = (id: string, app: string, sentAt: string, keepFrom: string | null) =>
      env.DB.prepare(
        `INSERT INTO legal_documents (mail_id,app,reference,version,idempotency_key,label,locale,to_addr,subject,text_body,text_sha256,addr_hash,created_at,keep_from,sent_at)
         VALUES (?1,?2,'R','v',?1,'l','en','a@example.org','s','t','h','h',?3,?4,?3)`,
      ).bind(id, app, sentAt, keepFrom).run();
    await put("a1", "shop", "2026-03-01T09:00:00.000Z", null);
    await put("a2", "shop", "2026-04-01T09:00:00.000Z", null);
    await put("b1", "books", "2026-05-01T09:00:00.000Z", null);
    await put("b2", "books", "2027-05-01T09:00:00.000Z", null); // its TTK date is a year later
    await put("c1", "shop", "2026-05-01T09:00:00.000Z", "2030-01-01T09:00:00.000Z"); // its end was reported
    const report = async (at: string) => (await runScheduled(lenv(), at)).legal_no_end_report;
    const NO_END_LINE = "[legal] subscription copies past their keeping period with no end reported (ask the app for the end call): ";
    expect(await report("2036-12-31T20:59:59.999Z")).toBe(false); // none past its TTK date yet
    expect(lines).toEqual([]);
    telegram.failNext = 1;
    expect(await report("2036-12-31T21:00:00.000Z")).toBe(false); // a failed send gives the year back
    expect(await report("2036-12-31T22:00:00.000Z")).toBe(true);
    expect(await report("2037-06-01T09:00:00.000Z")).toBe(false); // once a year
    expect(await report("2037-12-31T21:00:00.000Z")).toBe(true);
    expect(lines).toEqual([
      `${NO_END_LINE}books 1, shop 2\nhttps://admin.example.invalid/legal`,
      `${NO_END_LINE}books 2, shop 2\nhttps://admin.example.invalid/legal`,
    ]);
    expect((await runScheduled(lenv({ LEGAL_KEEP_YEARS: undefined }), "2038-12-31T21:00:00.000Z")).legal_no_end_report).toBe(false); // no period, no count
  });

  it("purging more copies than one statement may bind goes in slices", async () => {
    await env.DB.prepare(
      `WITH RECURSIVE k(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM k WHERE i<230)
       INSERT INTO legal_documents (mail_id,app,reference,version,idempotency_key,label,locale,to_addr,subject,text_body,text_sha256,addr_hash,created_at,keep_from)
       SELECT printf('c-%04d',i),'shop','R','v',printf('k-%04d',i),'l','en','a@example.org','s','t','h','h','2010-01-01T00:00:00.000Z','2010-01-01T00:00:00.000Z' FROM k`,
    ).run();
    const { withD1ParamLimit } = await import("./helpers");
    expect((await runScheduled({ ...lenv(), DB: withD1ParamLimit(env.DB) })).purged_legal_copies).toBe(230);
  });

  it("retention_days never touches a copy", async () => {
    const key = await legalApp();
    await updateApp(env.DB, "shop", { retention_days: 1 });
    const id = await idOf(await sendLegal(key));
    expect(await expireMails(env.DB, addMinutes(nowIso(), 3 * 24 * 60))).toBe(1);
    expect(await mailRow(id)).toBeNull();
    expect(await copy(id)).not.toBeNull();
  });
});
