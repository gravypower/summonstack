import type { RowDataPacket } from "mysql2";
import { getPool, WEB_DB } from "./db";
import { listRealmsWithConfig } from "./realm";

/**
 * "Enlightenment" — a dummy aura with no combat effect, picked because 3.3.5a
 * has no Joyous Journeys spell (64371 is Classic-2019 only). The two spells
 * that actually carry SPELL_AURA_MOD_XP_PCT in 3.3.5a are the heirloom bonuses,
 * and using one of those would stack a real +5%/+10% on top of the multiplier
 * below. The buff icon here is decoration; the XP comes from the Lua hook.
 */
export const DEFAULT_AURA_SPELL = 12655;

/** The worldserver polls every 15s, so a gap this long means it is not reading. */
const HEARTBEAT_SECONDS = 60;

export interface XpEvent {
  name: string;
  enabled: boolean;
  /** 1.5 = +50% experience. */
  multiplier: number;
  /** Buff icon shown to players; 0 for none. */
  auraSpell: number;
  endsAt: string | null;
  updatedBy: string | null;
  updatedAt: string | null;
  /** Last time the Lua script read this row. */
  seenAt: string | null;
  /** Enabled and not past ends_at — what players are actually getting. */
  active: boolean;
  /** False when the Lua script has never run or has stopped polling. */
  worldserverReading: boolean;
}

const DEFAULTS: XpEvent = {
  name: "Joyous Journeys",
  enabled: false,
  multiplier: 1.5,
  auraSpell: DEFAULT_AURA_SPELL,
  endsAt: null,
  updatedBy: null,
  updatedAt: null,
  seenAt: null,
  active: false,
  worldserverReading: false,
};

function rowToEvent(row: RowDataPacket): XpEvent {
  return {
    name: String(row.name),
    enabled: Number(row.enabled) === 1,
    multiplier: Number(row.multiplier_pct) / 100,
    auraSpell: Number(row.aura_spell),
    endsAt: row.ends_at ? new Date(row.ends_at).toISOString() : null,
    updatedBy: row.updated_by ? String(row.updated_by) : null,
    updatedAt: row.updated_at ? new Date(row.updated_at).toISOString() : null,
    seenAt: row.seen_at ? new Date(row.seen_at).toISOString() : null,
    active: Number(row.active) === 1,
    worldserverReading: Number(row.seen_recently) === 1,
  };
}

export async function getXpEvent(realmId: number = 1): Promise<XpEvent> {
  const pool = getPool();
  // Activeness and the heartbeat are evaluated by MySQL so they use the same
  // clock the Lua script compares against.
  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT name, enabled, multiplier_pct, aura_spell, ends_at, updated_by,
            updated_at, seen_at,
            (enabled = 1 AND (ends_at IS NULL OR ends_at > NOW())) AS active,
            (seen_at IS NOT NULL AND seen_at > NOW() - INTERVAL ? SECOND)
              AS seen_recently
       FROM \`${WEB_DB}\`.xp_event WHERE id = ?`,
    [HEARTBEAT_SECONDS, realmId]
  );
  return rows[0] ? rowToEvent(rows[0]) : DEFAULTS;
}

export interface XpEventUpdate {
  name: string;
  enabled: boolean;
  multiplier: number;
  auraSpell: number;
  /** Hours from now until the event stops on its own; null runs it until stopped. */
  endsInHours: number | null;
}

export interface ValidationIssue {
  field: keyof XpEventUpdate;
  message: string;
}

export function validateXpEvent(update: XpEventUpdate): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  if (!update.name.trim()) {
    issues.push({ field: "name", message: "Give the event a name." });
  } else if (update.name.length > 64) {
    issues.push({ field: "name", message: "Name must be 64 characters or fewer." });
  }

  // Below 1 would take XP away, which is never what a "boost" toggle means.
  if (!Number.isFinite(update.multiplier) || update.multiplier < 1 || update.multiplier > 10) {
    issues.push({
      field: "multiplier",
      message: "Multiplier must be between 1 and 10.",
    });
  } else if (Math.round(update.multiplier * 100) !== update.multiplier * 100) {
    issues.push({
      field: "multiplier",
      message: "Multiplier is stored to two decimals, e.g. 1.5 or 2.25.",
    });
  }

  if (
    !Number.isInteger(update.auraSpell) ||
    update.auraSpell < 0 ||
    update.auraSpell > 0xffffff
  ) {
    issues.push({ field: "auraSpell", message: "Not a valid spell id." });
  }

  if (
    update.endsInHours !== null &&
    (!Number.isFinite(update.endsInHours) ||
      update.endsInHours <= 0 ||
      update.endsInHours > 24 * 365)
  ) {
    issues.push({
      field: "endsInHours",
      message: "Duration must be between 1 hour and a year, or blank.",
    });
  }

  return issues;
}

export async function saveXpEvent(
  update: XpEventUpdate,
  username: string,
  realmId: number = 1
): Promise<XpEvent> {
  const pool = getPool();
  // A duration is relative to the save, so re-saving an already running event
  // without touching the field extends it — matching what the form shows.
  const endsAt =
    update.endsInHours === null
      ? "NULL"
      : "DATE_ADD(NOW(), INTERVAL ? MINUTE)";
  const params: Array<string | number> = [
    update.name.trim(),
    update.enabled ? 1 : 0,
    Math.round(update.multiplier * 100),
    update.auraSpell,
  ];
  if (update.endsInHours !== null) {
    params.push(Math.round(update.endsInHours * 60));
  }
  params.push(username.slice(0, 32));

  // Upsert rather than update: only realms 1 and 2 are seeded, so a third
  // realm would otherwise save into nothing and silently keep the defaults.
  // realmId is the primary key, so it leads the VALUES list.
  await pool.query(
    `INSERT INTO \`${WEB_DB}\`.xp_event
       (id, name, enabled, multiplier_pct, aura_spell, ends_at, updated_by,
        updated_at)
     VALUES (?, ?, ?, ?, ?, ${endsAt}, ?, NOW())
     ON DUPLICATE KEY UPDATE
       name = VALUES(name),
       enabled = VALUES(enabled),
       multiplier_pct = VALUES(multiplier_pct),
       aura_spell = VALUES(aura_spell),
       ends_at = VALUES(ends_at),
       updated_by = VALUES(updated_by),
       updated_at = NOW()`,
    [realmId, ...params]
  );
  return getXpEvent(realmId);
}

export interface RealmXpEvent extends XpEvent {
  realmId: number;
  realmName: string;
}

/** The XP event on each realm, for the admin realm picker. */
export async function listXpEvents(): Promise<RealmXpEvent[]> {
  const realms = await listRealmsWithConfig();
  return Promise.all(
    realms.map(async (realm) => ({
      realmId: realm.id,
      realmName: realm.name,
      ...(await getXpEvent(realm.id)),
    }))
  );
}
