# Injection seam audit — 2026-09-08

Three of the four defects the first deployment exposed lived in the same place: a seam that
exists so a test can inject a substitute, whose production default nothing ever ran. The suite
was green because every test drove the substitute. This audit lists every such seam, says what
now drives the production side of it, and — where the production side still cannot be reached
from a test — says so plainly and names what covers it instead.

`test/seams.test.ts` is the executable half of this document. Anything asserted below is
asserted there.

## The seams

| Seam | Production default | What the suite ran before | What drives the default now |
| --- | --- | --- | --- |
| `codecFromEnv` → `BindingCodec.info` | Images binding | `PassthroughCodec` — no image service was bound in the test config | The test config binds the image service, so the whole suite takes the production branch; the seam test drives `info` on PNG, JPEG, a vector, and bytes that cannot be decoded |
| `codecFromEnv` → `BindingCodec.reencode` | Images binding | `PassthroughCodec`, plus a hand-written echo binding for the metadata fix | The real binding re-encodes both formats and the result is checked for format and for leftover JPEG metadata |
| `limiterFor` → `BindingRateLimiter` | Rate-limit binding | `MemoryRateLimiter` — no namespace was bound | A probe namespace, `RL_PROBE`, exists in the test config only; the seam test drives the adapter against the real binding until the namespace is spent |
| `TelegramNotifier` transport | `defaultFetch` | an injected function, every time | The probe added after the first deployment, now over the shared `defaultFetch` |
| `exchangeCode` transport | `defaultFetch` | an injected function, every time | The same probe: both call sites now default to one exported value, so one test covers both |
| Signed-URL builder | real WebCrypto, no substitute | real, but only ever from a URL the test itself assembled | The seam test takes the URL the admin API actually minted and feeds it to the image origin Worker |
| Object store (`env.IMAGES`) | R2, no substitute | R2 API against the runtime's local store | Unchanged in kind; the seam test adds the paths where the store and the database can disagree |

## What this audit changed in the code

**A file the image codec cannot decode used to come back as `500 {error: "internal",
retryable: true}`.** Nothing in the suite could see it, because the passthrough codec reads the
header itself and never fails the way a codec does. A truncated file whose first bytes still
sniff as PNG reaches the codec, the codec throws its own error type, and that error went
straight past the handler into the generic 500. A client honouring the `retryable` flag would
have resent a file that can never succeed, forever.

This was confirmed against the live instance, not inferred. A throwaway application was created
on production, two corrupt files were uploaded, and both came back
`500 {"error":"internal","retryable":true}`. The application was deleted immediately; a rejected
upload writes no row and no object, and the database and bucket were read back empty afterwards.

The same probe, watched through `wrangler tail`, gave the answer no test could:

```
IMAGES_INFO_ERROR 9516: Could not resize the image: error during decoding:
Error while decoding the PNG image. The file may be incomplete or damaged
```

**9516.** The type definitions document 9412 for "input is not an image"; the local service
answers 9523; the live service answers 9516. Three implementations, three numbers, for one
undecodable PNG. The first version of this fix switched on the documented code and would
therefore have classified the real production error as a retryable service outage — the exact
client loop it was written to prevent. Finding that is why the probe was worth a production
write.

`BindingCodec` now maps on the shape of the error rather than its number:

- the service threw with a numeric code — it read the file and refused it → `415
  unsupported_media_type`, `retryable: false`, carrying `platform_code` for the operator
- the service threw without one — it never got that far → `503 image_service_unavailable`,
  `retryable: true`

A bad file answered as retryable is a client loop, and that is the failure worth engineering
against. The residual risk runs the other way: if the image service ever reports a genuine
outage as a coded error, a good upload is refused as undecodable. `platform_code` in the
response and the service's own message in the Worker log are what make that visible.

**The image origin serves the re-encoded bytes, not the uploaded bytes.** `test/images.test.ts`
asserted the served body equalled the uploaded PNG. That only ever held under the passthrough
codec, which does not re-encode. It now compares the served body against what the bucket holds.

## What is still not proven, and by what

**The local image service is not the production codec, and the difference is measurable.** The
Workers runtime backs the image binding locally with libvips; Cloudflare runs its own codec in
production. Everything the seam test asserts is Ulak's side of that seam — which branch is
taken, the stream plumbing, the shape of the info response, the guard that keeps a vector out of
the bucket, the mapping of a thrown error. The live probe above closed the one question the
local service answered wrongly. It leaves two behind:

- **The fix is not deployed.** The live instance still answers a corrupt upload with the
  retryable 500. No client is affected — the instance has no applications — but the defect is
  live until the API Worker is redeployed, which is the operator's call.
- **Nothing pins the codes.** The seam test deliberately asserts the rule (a numeric code means
  415) over any particular number, because pinning 9516 would describe today's live service the
  way pinning 9412 described the type definitions. If the live behaviour ever needs rechecking,
  the method is the one used here: a throwaway application, a corrupt upload, `wrangler tail`,
  and delete the application afterwards.

**The local object store is not R2.** Same shape of caveat, but a much smaller one: there is no
substitute in the code, the same API is called in both places, and the paths under test are our
own — a delete over a key the store no longer holds, and whether the bucket ends up holding
anything the database did not record. Consistency and durability differences between the local
store and R2 are not exercised and cannot be from a test.

**The test run now prints two `uncaught exception ... Error: internal error` lines.** They come
from the local image service when it refuses a file, they appear only when the whole suite runs
in parallel and never when the same tests run alone, and every test passes. Cancelling the
request stream on our side does not remove them, so they are inside the local service, not in
Ulak. Recorded here because a green run carrying an uncaught-exception line is exactly the sort
of thing that later hides a real one: if the count ever moves away from two, find out why before
assuming it is the same noise.

**The rate-limit probe namespace is not one of the four production namespaces.** It proves the
adapter over the binding, which is the seam. It does not exercise the production limits, and it
is not meant to: the per-user submit ceilings are counted in the database precisely because the
platform limiter is approximate and per-location.
