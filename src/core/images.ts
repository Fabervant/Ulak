// Stubs so the retention job compiles; replaced with the real image module in Task 10.
import type { Env } from "./env";

export async function purgeUnclaimedImages(_env: Env, _now: string): Promise<number> {
  return 0;
}

export async function deleteImageObjects(env: Env, keys: string[]): Promise<void> {
  await Promise.all(keys.map((k) => env.IMAGES.delete(k)));
}
