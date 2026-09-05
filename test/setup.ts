import { applyD1Migrations, env } from "cloudflare:test";
import { beforeEach } from "vitest";

// Setup files run outside per-test storage isolation and may run more than
// once; applyD1Migrations only applies what has not been applied yet.
await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);

// Storage is shared between the tests of one file, so every test starts from
// empty tables and an empty bucket.
beforeEach(async () => {
  await env.DB.batch(
    ["admin_tokens", "admins", "images", "replies", "messages", "apps"].map((t) => env.DB.prepare(`DELETE FROM ${t}`)),
  );
  const objects = await env.IMAGES.list();
  await Promise.all(objects.objects.map((o) => env.IMAGES.delete(o.key)));
});
