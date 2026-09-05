async function hmacHex(secret: string, data: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function signImageUrl(secret: string, imagesUrl: string, id: string, expiresAtSec: number): Promise<string> {
  const sig = await hmacHex(secret, `${id}.${expiresAtSec}`);
  return `${imagesUrl.replace(/\/$/, "")}/i/${id}?exp=${expiresAtSec}&sig=${sig}`;
}

export async function verifyImageSig(secret: string, id: string, exp: string, sig: string): Promise<boolean> {
  const n = Number(exp);
  if (!Number.isFinite(n) || n < Math.floor(Date.now() / 1000)) return false;
  const want = await hmacHex(secret, `${id}.${n}`);
  if (want.length !== sig.length) return false;
  let diff = 0;
  for (let i = 0; i < want.length; i++) diff |= want.charCodeAt(i) ^ sig.charCodeAt(i);
  return diff === 0;
}
