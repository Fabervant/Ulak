# Skipped issues

## Wrap-Up — What Else Is Needed (Open)

- [S9, 2026-10-11] Shown-once key edges: one `ulak_reveal` cookie serves both pages, so two key-making posts in two tabs within 60 s show only the later key, and a key is lost if the page's own read fails after the cookie is cleared. Why: both need an unlikely operator sequence; the old path lost a key the same way; a fix needs per-secret cookies or a server-side store. Re-eval trigger: an operator loses a key this way, or the admin panel gains more than one operator. No executable pointer; it may die here.

---
