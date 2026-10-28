const enc = new TextEncoder();
const hex = (b: ArrayBuffer) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");

async function hmac(key: BufferSource, data: string): Promise<ArrayBuffer> {
  const k = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return crypto.subtle.sign("HMAC", k, enc.encode(data));
}

/** The address as Ulak compares it: trimmed and lower-cased. */
export const normalAddress = (address: string): string => address.trim().toLowerCase();

/** The address's keyed hash in one app. Each app's key is derived from the secret and the app id
 *  and never stored, so the same address hashes differently in each app and no list can be merged. */
export async function addrHash(secret: string, app: string, address: string): Promise<string> {
  const appKey = await hmac(enc.encode(secret), `ulak-mail-addr:${app}`);
  return hex(await hmac(appKey, normalAddress(address)));
}

/** HMAC-SHA256 of `data` under `key`, base64: the vendor's webhook signature. */
export async function hmacBase64(key: string, data: string): Promise<string> {
  const sig = new Uint8Array(await hmac(enc.encode(key), data));
  return btoa(String.fromCharCode(...sig));
}

const ADDRESS = /[^\s<>"'(),;:@]+@[^\s<>"'(),;:@]+/g;

/** Every address in a text masked, for anything stored or logged: vendor error texts carry the recipient. */
export const scrubAddresses = (s: string): string => s.replace(ADDRESS, "***@***");
