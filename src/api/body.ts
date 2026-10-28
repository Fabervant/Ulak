import { ApiError } from "../core/errors";
import { MAX_BODY_BYTES } from "../core/validate";

const tooLarge = (cap: number) => new ApiError(413, "payload_too_large", `request body exceeds ${cap} bytes`, false, { max_bytes: cap });

/** Reads a body's bytes, stopping at the cap: a declared length over it is refused before reading,
 *  and a stream that runs past it is cancelled, so no request makes the Worker buffer more. */
export async function readBytesCapped(req: Request, cap: number): Promise<Uint8Array> {
  const declared = Number(req.headers.get("content-length") ?? "0");
  if (declared > cap) throw tooLarge(cap);
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
  return out;
}

const utf8 = (bytes: Uint8Array): string => {
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes);
  } catch {
    throw new ApiError(400, "invalid_request", "body is not valid UTF-8", false, { field: "body" });
  }
};

/** Reads a text body under the cap. */
export async function readTextCapped(req: Request, cap: number): Promise<string> {
  return utf8(await readBytesCapped(req, cap));
}

/** Reads a JSON body under the cap, rejecting before parsing. Order: 413, 415, then 400. */
export async function readJsonCapped(req: Request, cap: number = MAX_BODY_BYTES): Promise<unknown> {
  const declared = Number(req.headers.get("content-length") ?? "0");
  if (declared > cap) throw tooLarge(cap);
  if (!/^application\/json\b/i.test(req.headers.get("content-type") ?? "")) throw new ApiError(415, "unsupported_media_type", "Content-Type must be application/json", false);
  const text = utf8(await readBytesCapped(req, cap));
  try {
    return JSON.parse(text);
  } catch {
    throw new ApiError(400, "invalid_request", "body is not valid JSON", false, { field: "body" });
  }
}
