import fs from "node:fs";
import path from "node:path";

/**
 * The realm manifest, exported from realms.yml by `task realm:render` and bind
 * mounted into this container.
 *
 * Without it the portal has to derive a realm's container name and databases
 * from its id, which only ever worked for the two realms it was special-cased
 * for. Everything here is optional: if the file is missing the callers fall
 * back to that older guessing, so an unmounted manifest degrades rather than
 * breaks the portal.
 */
export interface PortalRealm {
  id: number;
  name: string;
  type: string;
  enabled: boolean;
  service: string;
  worldDb: string;
  charsDb: string;
  /** Reachable over ac-network — the compose service name doubles as the alias. */
  worldHost: string;
  /** The port inside the container, not the one published on the host. */
  worldPort: number;
  soapUrl: string;
}

const CANDIDATES = [
  process.env.REALMS_MANIFEST?.trim(),
  "/app/generated/realms.json",
  path.join(process.cwd(), "generated", "realms.json"),
].filter((p): p is string => Boolean(p));

let cache: { path: string; mtimeMs: number; realms: PortalRealm[] } | null = null;

function readManifest(): PortalRealm[] | null {
  for (const candidate of CANDIDATES) {
    let stat: fs.Stats;
    try {
      stat = fs.statSync(candidate);
    } catch {
      continue;
    }
    // Adding a realm rewrites this file without restarting the portal, so the
    // cache is keyed on mtime rather than held for the life of the process.
    if (cache && cache.path === candidate && cache.mtimeMs === stat.mtimeMs) {
      return cache.realms;
    }
    try {
      const parsed = JSON.parse(fs.readFileSync(candidate, "utf8"));
      const realms: PortalRealm[] = Array.isArray(parsed?.realms) ? parsed.realms : [];
      cache = { path: candidate, mtimeMs: stat.mtimeMs, realms };
      return realms;
    } catch {
      // A half-written or malformed file is treated as absent.
      return null;
    }
  }
  return null;
}

export function manifestRealms(): PortalRealm[] | null {
  return readManifest();
}

export function manifestRealm(id: number): PortalRealm | null {
  const realms = readManifest();
  if (!realms) return null;
  return realms.find((realm) => realm.id === id) ?? null;
}
