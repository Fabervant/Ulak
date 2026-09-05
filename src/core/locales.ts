import en from "./locales/en.json";
import tr from "./locales/tr.json";

type Bundle = { status: Record<string, string> };
const bundles: Record<string, Bundle> = { en, tr };

/** Status name in the message's language, English fallback, then the raw key for custom statuses. */
export function statusLabel(status: string, locale: string | null): string {
  const lang = (locale ?? "en").toLowerCase().split(/[-_]/)[0]!;
  return bundles[lang]?.status[status] ?? en.status[status as keyof typeof en.status] ?? status;
}
