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
  const codes = [...new Set(body.match(CODE) ?? [])];
  const error = short(`HTTP ${status}${codes.length ? " " + codes.join(" ") : ""}: ${body}`);
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
      body: JSON.stringify(vendorBody(m)),
      signal: AbortSignal.timeout(timeoutMs),
    });
    return classify(res.status, await res.text());
  } catch (e) {
    const name = e instanceof Error ? e.name : "";
    return { kind: "vendor_down", error: name === "TimeoutError" || name === "AbortError" ? "timeout" : short(`network: ${e instanceof Error ? e.message : String(e)}`) };
  }
}
