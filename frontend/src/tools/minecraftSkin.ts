/** Minecraft skin render URLs (public CDN). Prefer UUID for online-mode accuracy. */

const CDN = "https://mc-heads.net";

export type SkinKind = "avatar" | "body";

const failedKeys = new Set<string>();

function normalizeId(id?: string | null): string {
  return (id || "").trim();
}

function cacheKey(kind: SkinKind, id: string, size: number): string {
  return `${kind}:${id.toLowerCase()}:${size}`;
}

/** True when we already saw this render fail in-session. */
export function isSkinBroken(kind: SkinKind, id?: string | null, size = 32): boolean {
  const n = normalizeId(id);
  if (!n) return true;
  return failedKeys.has(cacheKey(kind, n, size));
}

export function markSkinBroken(kind: SkinKind, id?: string | null, size = 32): void {
  const n = normalizeId(id);
  if (!n) return;
  failedKeys.add(cacheKey(kind, n, size));
}

/**
 * Build a skin render URL.
 * Prefer UUID; fall back to player name (works for many online accounts).
 * Verified endpoints:
 *   avatar: /avatar/<id>/<size>
 *   body:   /body/<id>/<size>
 */
export function skinUrl(kind: SkinKind, id?: string | null, size = 32): string | undefined {
  const n = normalizeId(id);
  if (!n) return undefined;
  if (isSkinBroken(kind, n, size)) return undefined;
  const path = kind === "body" ? "body" : "avatar";
  return `${CDN}/${path}/${encodeURIComponent(n)}/${size}`;
}

/** Prefer uuid, then name. */
export function playerSkinId(uuid?: string | null, name?: string | null): string | undefined {
  const u = normalizeId(uuid);
  if (u) return u;
  const n = normalizeId(name);
  return n || undefined;
}

export function playerInitial(name?: string | null): string {
  const n = normalizeId(name);
  if (!n) return "?";
  return n.charAt(0).toUpperCase();
}
