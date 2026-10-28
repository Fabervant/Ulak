import { ApiError } from "../core/errors";
import { MAX_BODY_BYTES } from "../core/validate";

const tooLarge = (cap: number) => new ApiError(413, "payload_too_large", `request body exceeds ${cap} bytes`, false, { max_bytes: cap });

/** Reads a JSON body under the cap, rejecting before parsing. Order: 413, 415, then 400. */
export async function readJsonCapped(req: Request, cap: number = MAX_BODY_BYTES): Promise<unknown> {
  const declared = Number(req.headers.get("content-length") ?? "0");
  if (declared > cap) throw tooLarge(cap);
  if (!/^application\/json\b/i.test(req.headers.get("content-type") ?? "")) throw new ApiError(415, "unsupported_media_type", "Content-Type must be application/json", false);
  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = req.body?.getReader();
  if (reader) {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > cap) {
        await reader.cancel();
        throw tooLarge(cap);
      }
      chunks.push(value);
    }
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const ch of chunks) {
    out.set(ch, off);
    off += ch.byteLength;
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(out);
  } catch {
    throw new ApiError(400, "invalid_request", "body is not valid UTF-8", false, { field: "body" });
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new ApiError(400, "invalid_request", "body is not valid JSON", false, { field: "body" });
  }
}
