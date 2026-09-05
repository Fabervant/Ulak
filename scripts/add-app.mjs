// Usage: node scripts/add-app.mjs <app-id> [--remote] [--retention 90] [--images] [--origins https://a.example,https://b.example]
// Creates an app row through wrangler and prints its key once. The admin surface offers the same.
import { execSync } from "node:child_process";
import { randomBytes, createHash } from "node:crypto";

const [, , id, ...rest] = process.argv;
if (!id || !/^[a-z0-9_-]{2,32}$/.test(id)) {
  console.error("app id must match [a-z0-9_-]{2,32}");
  process.exit(1);
}
const flag = (n) => rest.includes(n);
const val = (n, d) => {
  const i = rest.indexOf(n);
  return i >= 0 ? rest[i + 1] : d;
};
const retention = Number(val("--retention", 90));
if (!Number.isInteger(retention) || retention < 1 || retention > 3650) {
  console.error("--retention must be 1 to 3650");
  process.exit(1);
}
const origins = val("--origins", "").split(",").filter(Boolean);
for (const o of origins) {
  if (!/^https?:\/\/[^/\s]+$/.test(o)) {
    console.error(`bad origin ${o}`);
    process.exit(1);
  }
}
const key = `ulak_${id}_${randomBytes(24).toString("hex")}`;
const hash = createHash("sha256").update(key).digest("hex");
const sql = `INSERT INTO apps (id,key_hash,retention_days,images_enabled,allowed_origins,created_at) VALUES ('${id}','${hash}',${retention},${flag("--images") ? 1 : 0},'${JSON.stringify(origins)}','${new Date().toISOString()}')`;
execSync(`npx wrangler d1 execute ulak ${flag("--remote") ? "--remote" : "--local"} -c wrangler.api.jsonc --command "${sql.replace(/"/g, '\\"')}"`, { stdio: "inherit" });
console.log(`\nApp '${id}' created. Its key (shown once, store it in the app's own config):\n${key}\n`);
