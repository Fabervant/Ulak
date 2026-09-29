export function nowIso(): string {
  return new Date().toISOString();
}

/** Unix seconds, the unit of session times and signed-link expiries. */
export function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

export function addMinutes(iso: string, minutes: number): string {
  return new Date(Date.parse(iso) + minutes * 60_000).toISOString();
}

export function isIso(s: string): boolean {
  if (typeof s !== "string" || s.length < 20 || s.length > 35) return false;
  const t = Date.parse(s);
  return Number.isFinite(t) && /^\d{4}-\d{2}-\d{2}T/.test(s);
}
