/** Upgrade absolute http:// URLs to https:// for mixed-content safety. */
export function upgradeInsecureUrl(url?: string | null): string {
  const raw = String(url || "").trim();
  if (!raw) return "";
  if (/^https:\/\//i.test(raw)) return raw;
  if (/^http:\/\//i.test(raw)) return raw.replace(/^http:\/\//i, "https://");
  return raw;
}
