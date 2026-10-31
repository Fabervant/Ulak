import { defaultFetch } from "../http";
import { scrubAddresses } from "./hash";
import type { MailConfig } from "./config";

/** What the vendor needs to send one mail. */
export interface Outgoing {
  id: string;
  fromAddress: string;
  fromName: string;
  to: string;
  subject: string;
  text: string;
  html: string | null;
}

export type VendorResult =
  | { kind: "accepted"; requestId: string }
  /** The vendor refused this recipient: depends on the address, never retried. */
  | { kind: "address_refused"; error: string }
  /** The vendor's own service failed (no answer, server error, credentials, account, credits): retried. */
  | { kind: "vendor_down"; error: string }
  /** The vendor called the request itself malformed: a Ulak bug, never retried. */
  | { kind: "request_bad"; error: string };

export const SEND_TIMEOUT_MS = 8000;

const CODE = /\b(?:TM|SM|SERR|LE|AE|UE|MTR|SMI|GE)_\d+\b/g;
const REQUEST_BAD = new Set(["TM_3201", "TM_3301", "TM_8001"]);
const TO_FIELD = /"target(?:_value)?"\s*:\s*"to"|field "to"/i;
const TARGET = /"target"\s*:\s*"([a-z_]{1,32})"/gi;

const short = (s: string) => scrubAddresses(s).replace(/\s+/g, " ").slice(0, 300);

/** The vendor's request body. Tracking is off and links are untouched: no pixel, no rewritten link.
 *  Replies go to the app's own address until inbound replies exist (spec 7.1). */
export function vendorBody(m: Outgoing): Record<string, unknown> {
  return {
    from: { address: m.fromAddress, name: m.fromName },
    to: [{ email_address: { address: m.to } }],
    reply_to: [{ address: m.fromAddress, name: m.fromName }],
    subject: m.subject,
    textbody: m.text,
    ...(m.html !== null ? { htmlbody: m.html } : {}),
    track_clicks: false,
    track_opens: false,
    client_reference: m.id,
  };
}

/** The plain-text line that opens the sender block: the conventional signature separator. */
export const SENDER_SEPARATOR = "-- ";

const escapeHtml = (s: string): string => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** The mail with the operator's sender block at its end, in the text and in the html (escaped, before
 *  the closing body tag when there is one). The vendor's terms require it in every mail. */
export function withSenderInfo(m: Outgoing, info: string): Outgoing {
  const text = `${m.text.replace(/\s+$/, "")}\n\n${SENDER_SEPARATOR}\n${info}`;
  if (m.html === null) return { ...m, text };
  const block = `<hr><p style="font-size:12px;color:#666">${info.split(/\r?\n/).map(escapeHtml).join("<br>")}</p>`;
  const at = m.html.search(/<\/body>(?![\s\S]*<\/body>)/i);
  const html = at === -1 ? m.html + block : m.html.slice(0, at) + block + m.html.slice(at);
  return { ...m, text, html };
}

/** Classifies one answer of the vendor. Exported for its tests. */
export function classify(status: number, body: string): VendorResult {
  if (status >= 200 && status < 300) {
    let requestId = "";
    try {
      requestId = String((JSON.parse(body) as { request_id?: unknown }).request_id ?? "");
    } catch {
      // An accepted mail with an unreadable answer is still accepted; its events match by our own id.
    }
    return { kind: "accepted", requestId };
  }
  // Only the status, the vendor's codes and the names of the fields it objects to are kept: its text
  // may echo a value of the mail (an address, a link with its token), which must never be stored.
  const codes = [...new Set(body.match(CODE) ?? [])];
  const fields = [...new Set([...body.matchAll(TARGET)].map((t) => t[1]!))];
  const error = `HTTP ${status}${codes.length ? " " + codes.join(" ") : ""}${fields.length ? ` (field ${fields.join(", ")})` : ""}`;
  if (status >= 500 || status === 401 || status === 403 || status === 408 || status === 429) return { kind: "vendor_down", error };
  if (codes.includes("TM_4001") && TO_FIELD.test(body)) return { kind: "address_refused", error };
  if (codes.some((c) => REQUEST_BAD.has(c))) return { kind: "request_bad", error };
  // Account, credits, domain, key and limit codes, and anything unrecognised: the vendor's side.
  return { kind: "vendor_down", error };
}

/** The transport every vendor call uses unless one is passed. Production leaves it at `defaultFetch`
 *  (the seam test asserts it); route tests swap in a vendor double here. */
export const vendorTransport: { fetch: typeof fetch } = { fetch: defaultFetch };

/** One call to the vendor, never longer than SEND_TIMEOUT_MS. Never throws. */
export async function sendViaVendor(cfg: MailConfig, m: Outgoing, transport: typeof fetch = vendorTransport.fetch, timeoutMs = SEND_TIMEOUT_MS): Promise<VendorResult> {
  try {
    const res = await transport(cfg.apiUrl, {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json", authorization: `Zoho-enczapikey ${cfg.apiKey}` },
      body: JSON.stringify(vendorBody(withSenderInfo(m, cfg.senderInfo))),
      signal: AbortSignal.timeout(timeoutMs),
    });
    return classify(res.status, await res.text());
  } catch (e) {
    const name = e instanceof Error ? e.name : "";
    return { kind: "vendor_down", error: name === "TimeoutError" || name === "AbortError" ? "timeout" : short(`network: ${e instanceof Error ? e.message : String(e)}`) };
  }
}
