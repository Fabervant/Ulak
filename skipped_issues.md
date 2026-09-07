# Skipped issues

## Wrap-Up — What Else Is Needed (Open)

- [S2, 2026-09-07] Per-IP and read rate limits remain best-effort on the platform limiter, which is
  approximate and counted per location. Why: only the per-user submit ceilings were moved to the
  database this session; moving the other two needs a request log that does not exist, which is a
  larger change than the session had room for. Re-eval trigger: a client is observed exceeding the
  stated read limit, or a request log is added for another reason.
- [S2, 2026-09-07] This session's four fixes had no independent review. Why: found, fixed and
  tested by the same agent in one session; the red-then-green demonstrations are real evidence but
  are not a second reader. Re-eval trigger: before the first real client application depends on
  Ulak, or at the next drift review.

---
