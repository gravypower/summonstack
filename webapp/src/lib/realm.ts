import { promises as dns } from "node:dns";
import type { ResultSetHeader, RowDataPacket } from "mysql2";
import { AUTH_DB, getPool } from "./db";
import { manifestRealm } from "./realm-manifest";

export interface Realm {
  id: number;
  name: string;
  address: string;
  localAddress: string;
  localSubnetMask: string;
  port: number;
}

/** A realm row plus what the authserver would make of it right now. */
export interface RealmStatus extends Realm {
  resolved: {
    address: string | null;
    localAddress: string | null;
    localSubnetMask: string | null;
  };
  /** True when any column fails to resolve — the authserver drops such realms. */
  broken: boolean;
  /** True when the external address only works from this machine. */
  localOnly: boolean;
}

function rowToRealm(row: RowDataPacket): Realm {
  return {
    id: Number(row.id),
    name: String(row.name),
    address: String(row.address),
    localAddress: String(row.localAddress),
    localSubnetMask: String(row.localSubnetMask),
    port: Number(row.port),
  };
}

export async function listRealms(): Promise<Realm[]> {
  const pool = getPool();
  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT id, name, address, localAddress, localSubnetMask, port
       FROM \`${AUTH_DB}\`.realmlist ORDER BY id`
  );
  return rows.map(rowToRealm);
}

export async function getRealm(id: number): Promise<Realm | null> {
  const pool = getPool();
  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT id, name, address, localAddress, localSubnetMask, port
       FROM \`${AUTH_DB}\`.realmlist WHERE id = ?`,
    [id]
  );
  return rows[0] ? rowToRealm(rows[0]) : null;
}

/**
 * Resolve exactly the way the authserver does: getaddrinfo restricted to IPv4
 * (RealmList::UpdateRealms calls Resolver::Resolve with tcp::v4()). A realm
 * whose address does not resolve is skipped entirely and vanishes from the
 * realm list, so this is worth checking before writing a value.
 */
export async function resolveIpv4(host: string): Promise<string | null> {
  const value = host.trim();
  if (!value) return null;
  try {
    const { address } = await dns.lookup(value, { family: 4 });
    return address;
  } catch {
    return null;
  }
}

export async function describeRealm(realm: Realm): Promise<RealmStatus> {
  const [address, localAddress, localSubnetMask] = await Promise.all([
    resolveIpv4(realm.address),
    resolveIpv4(realm.localAddress),
    resolveIpv4(realm.localSubnetMask),
  ]);
  return {
    ...realm,
    resolved: { address, localAddress, localSubnetMask },
    broken: !address || !localAddress || !localSubnetMask,
    localOnly: address ? address.startsWith("127.") : false,
  };
}

export function isIpv4(value: string): boolean {
  const parts = value.trim().split(".");
  if (parts.length !== 4) return false;
  return parts.every(
    (part) => /^\d{1,3}$/.test(part) && Number(part) >= 0 && Number(part) <= 255
  );
}

/** A netmask must be a run of ones followed by a run of zeroes. */
export function isIpv4Mask(value: string): boolean {
  if (!isIpv4(value)) return false;
  const bits = ipToInt(value);
  // ~bits + 1 is a power of two exactly when bits is contiguous from the left.
  const inverted = (~bits >>> 0) + 1;
  return (inverted & (inverted - 1)) === 0;
}

/**
 * Hostnames are legal in every address column — the authserver resolves them
 * on each refresh — so accept anything that looks like one.
 */
export function isHostname(value: string): boolean {
  const host = value.trim();
  if (!host || host.length > 253) return false;
  return /^[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/.test(
    host
  );
}

export function ipToInt(ip: string): number {
  return (
    ip
      .trim()
      .split(".")
      .reduce((acc, part) => (acc << 8) | Number(part), 0) >>> 0
  );
}

function prefixFromMask(mask: number): number {
  let bits = 0;
  for (let i = 31; i >= 0; i--) {
    if ((mask & (1 << i)) === 0) break;
    bits++;
  }
  return bits;
}

/**
 * Mirror of Acore::Net::IsInNetwork, which tests membership of
 * boost::asio::network_v4::hosts() — that range excludes the network and
 * broadcast addresses unless the prefix is /31 or /32.
 */
export function isInNetwork(
  networkAddress: string,
  mask: string,
  clientAddress: string
): boolean {
  const m = ipToInt(mask);
  const base = (ipToInt(networkAddress) & m) >>> 0;
  const broadcast = (base | (~m >>> 0)) >>> 0;
  const client = ipToInt(clientAddress);
  if (prefixFromMask(m) >= 31) return client >= base && client <= broadcast;
  return client > base && client < broadcast;
}

export type AddressChoice = "local" | "external" | "client-loopback";

export interface ClientPreview {
  /** Which column the authserver reads for this client. */
  choice: AddressChoice;
  /** The literal IPv4 the client is told to connect to. */
  address: string;
  port: number;
}

/**
 * Mirror of Realm::GetAddressForClient. The realm list packet carries a single
 * resolved IPv4 per client, picked between exactly two candidates — there is no
 * way to advertise a list of addresses or to send a hostname.
 */
export function addressForClient(
  realm: RealmStatus,
  clientIp: string
): ClientPreview | null {
  const { address, localAddress, localSubnetMask } = realm.resolved;
  if (!address || !localAddress || !localSubnetMask) return null;
  if (!isIpv4(clientIp)) return null;

  if (clientIp.startsWith("127.")) {
    // A loopback client is handed its own address when either column is
    // loopback, otherwise it is assumed to sit on the realm's local network.
    const eitherLoopback =
      localAddress.startsWith("127.") || address.startsWith("127.");
    return {
      choice: eitherLoopback ? "client-loopback" : "local",
      address: eitherLoopback ? clientIp : localAddress,
      port: realm.port,
    };
  }

  if (isInNetwork(localAddress, localSubnetMask, clientIp)) {
    return { choice: "local", address: localAddress, port: realm.port };
  }
  return { choice: "external", address, port: realm.port };
}

export interface RealmUpdate {
  id: number;
  address: string;
  localAddress: string;
  localSubnetMask: string;
  port: number;
}

export interface ValidationIssue {
  field: keyof Omit<RealmUpdate, "id">;
  message: string;
}

export async function validateRealmUpdate(
  update: RealmUpdate
): Promise<ValidationIssue[]> {
  const issues: ValidationIssue[] = [];

  if (!Number.isInteger(update.port) || update.port < 1 || update.port > 65535) {
    issues.push({ field: "port", message: "Port must be between 1 and 65535." });
  }

  const hosts: Array<[keyof Omit<RealmUpdate, "id">, string]> = [
    ["address", update.address],
    ["localAddress", update.localAddress],
  ];
  for (const [field, value] of hosts) {
    if (!value.trim()) {
      issues.push({ field, message: "Required." });
      continue;
    }
    if (value.length > 255) {
      issues.push({ field, message: "Must be 255 characters or fewer." });
      continue;
    }
    if (!isIpv4(value) && !isHostname(value)) {
      issues.push({ field, message: "Not a valid IPv4 address or hostname." });
      continue;
    }
    // The authserver drops a realm whose address will not resolve to IPv4, so
    // refuse to write one rather than let the realm disappear from the list.
    if (!(await resolveIpv4(value))) {
      issues.push({
        field,
        message: `"${value}" does not resolve to an IPv4 address from the server.`,
      });
    }
  }

  if (!isIpv4Mask(update.localSubnetMask)) {
    issues.push({
      field: "localSubnetMask",
      message: "Must be a valid subnet mask, e.g. 255.255.255.0.",
    });
  }

  return issues;
}

export async function updateRealm(update: RealmUpdate): Promise<void> {
  const pool = getPool();
  await pool.query<ResultSetHeader>(
    `UPDATE \`${AUTH_DB}\`.realmlist
        SET address = ?, localAddress = ?, localSubnetMask = ?, port = ?
      WHERE id = ?`,
    [
      update.address.trim(),
      update.localAddress.trim(),
      update.localSubnetMask.trim(),
      update.port,
      update.id,
    ]
  );
}

export interface RealmConfig extends Realm {
  charsDb: string;
  worldDb: string;
  soapUrl: string;
  worldHost: string;
  worldPort: number;
}

/**
 * Where a realm's databases and worldserver live.
 *
 * Three sources, most specific first: an explicit REALM_<id>_* environment
 * override, the realm manifest exported from realms.yml, then the legacy
 * defaults. The legacy branch only ever knew realms 1 and 2 — for anything else
 * it guessed `ac-realm${id}-worldserver` while the compose generator produced
 * `ac-realm-${id}`, so the portal could not reach a realm it had not been
 * special-cased for. It is kept only so a portal running without the manifest
 * mounted behaves exactly as it did before.
 */
export function getRealmConfig(realm: Realm): RealmConfig {
  const id = realm.id;
  const override = (suffix: string) =>
    process.env[`REALM_${id}_${suffix}`]?.trim() || undefined;
  const entry = manifestRealm(id);

  const legacy = legacyRealmConfig(id);
  if (!entry) warnLegacyGuess(id, legacy);

  const worldPortOverride = override("WORLD_PORT");
  return {
    ...realm,
    charsDb: override("CHARS_DB") || entry?.charsDb || legacy.charsDb,
    worldDb: override("WORLD_DB") || entry?.worldDb || legacy.worldDb,
    soapUrl: override("SOAP_URL") || entry?.soapUrl || legacy.soapUrl,
    worldHost: override("WORLD_HOST") || entry?.worldHost || legacy.worldHost,
    worldPort: worldPortOverride
      ? Number(worldPortOverride)
      : entry?.worldPort || legacy.worldPort,
  };
}

/** Realms already warned about, so the log is one line per realm, not per request. */
const warnedRealms = new Set<number>();

/**
 * The manifest is the source of truth for where a realm lives, and compose
 * mounts it. Falling through to the guesses below means it is missing or
 * unreadable — at which point the portal is talking to databases and
 * worldservers derived from an id, which stopped matching what the compose
 * generator produces once realms.yml could name them freely.
 *
 * Silently guessing is how a realm ends up reading an empty database and
 * reporting nothing wrong, so say it once per realm.
 */
function warnLegacyGuess(id: number, legacy: RealmEndpoints): void {
  if (warnedRealms.has(id)) return;
  warnedRealms.add(id);
  console.warn(
    `[realm ${id}] no manifest entry — falling back to guessed endpoints ` +
      `(charsDb=${legacy.charsDb}, worldHost=${legacy.worldHost}). ` +
      "Run `task realm:render` and check webapp/generated/realms.json is mounted."
  );
}

interface RealmEndpoints {
  charsDb: string;
  worldDb: string;
  soapUrl: string;
  worldHost: string;
  worldPort: number;
}

function legacyRealmConfig(id: number): RealmEndpoints {
  if (id === 1) {
    return {
      charsDb: process.env.CHARS_DB || "acore_characters",
      worldDb: process.env.WORLD_DB || "acore_world",
      soapUrl: process.env.SOAP_URL || "http://ac-worldserver:7878",
      worldHost: process.env.WORLD_HOST || "ac-worldserver",
      worldPort: Number(process.env.WORLD_PORT || 8085),
    };
  }
  if (id === 2) {
    return {
      charsDb: process.env.CHARS_DB_PB || "acore_characters_pb",
      worldDb: process.env.WORLD_DB_PB || "acore_world_pb",
      soapUrl: process.env.SOAP_URL_PB || "http://ac-pb-worldserver:7878",
      worldHost: process.env.WORLD_HOST_PB || "ac-pb-worldserver",
      worldPort: Number(process.env.WORLD_PORT_PB || 8085),
    };
  }
  return {
    charsDb: `acore_characters_${id}`,
    worldDb: "acore_world",
    soapUrl: `http://ac-realm${id}-worldserver:7878`,
    worldHost: `ac-realm${id}-worldserver`,
    worldPort: 8085,
  };
}

export async function listRealmsWithConfig(): Promise<RealmConfig[]> {
  const realms = await listRealms();
  return realms.map(getRealmConfig);
}

export async function getRealmConfigById(id: number): Promise<RealmConfig | null> {
  const realm = await getRealm(id);
  if (!realm) return null;
  return getRealmConfig(realm);
}

