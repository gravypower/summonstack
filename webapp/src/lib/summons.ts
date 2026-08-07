// Summon rewards. The realm-wide summon counter and the shop points a player
// earns for summoning someone else.
//
// Division of labour:
//   - worldserver/lua_scripts/summons.lua decides what *is* a summon (a cast
//     the target actually accepted) and appends one summon_events row.
//   - This file decides what a summon is *worth*, and is the only thing that
//     moves points. Same money invariant as the shop: balance and ledger move
//     together inside one DB transaction.
//   - Every payout is guarded twice — the pending → awarded transition is a
//     conditional UPDATE, and the ledger row is keyed (reason='summon',
//     reference=<event id>) under uq_reason_ref. A row cannot pay twice even
//     if two sweeps run at once.
import type { ResultSetHeader, RowDataPacket } from "mysql2";
import { HttpError } from "./auth";
import { AUTH_DB, WEB_DB, ensureWebDb, getPool } from "./db";
import { listRealmsWithConfig } from "./realm";

/** The Lua script polls every 15s, so a longer gap means it is not reading. */
const HEARTBEAT_SECONDS = 60;

/** How many pending rows one sweep will settle. */
const SWEEP_LIMIT = 200;

export interface SummonRewards {
  /** Off still counts summons — it only stops them being worth points. */
  enabled: boolean;
  pointsPerSummon: number;
  /** Most points one account can earn from summons in 24h; 0 = uncapped. */
  dailyPointCap: number;
  /** How long before the same pair of accounts pays again; 0 = never wait. */
  pairCooldownMinutes: number;
  /** Announce every Nth realm summon in game; 0 = stay quiet. */
  announceEvery: number;
  updatedBy: string | null;
  updatedAt: string | null;
  /** Last time the Lua script read this row. */
  seenAt: string | null;
  /** False when the Lua script has never run or has stopped polling. */
  worldserverReading: boolean;
}

const DEFAULTS: SummonRewards = {
  enabled: true,
  pointsPerSummon: 5,
  dailyPointCap: 100,
  pairCooldownMinutes: 30,
  announceEvery: 50,
  updatedBy: null,
  updatedAt: null,
  seenAt: null,
  worldserverReading: false,
};

export async function getSummonRewards(): Promise<SummonRewards> {
  await ensureWebDb();
  // The heartbeat is evaluated by MySQL so it uses the same clock the Lua
  // script writes seen_at with.
  const [rows] = await getPool().query<RowDataPacket[]>(
    `SELECT enabled, points_per_summon, daily_point_cap, pair_cooldown_minutes,
            announce_every, updated_by, updated_at, seen_at,
            (seen_at IS NOT NULL AND seen_at > NOW() - INTERVAL ? SECOND)
              AS seen_recently
       FROM \`${WEB_DB}\`.summon_rewards WHERE id = 1`,
    [HEARTBEAT_SECONDS]
  );
  const row = rows[0];
  if (!row) return DEFAULTS;
  return {
    enabled: Number(row.enabled) === 1,
    pointsPerSummon: Number(row.points_per_summon),
    dailyPointCap: Number(row.daily_point_cap),
    pairCooldownMinutes: Number(row.pair_cooldown_minutes),
    announceEvery: Number(row.announce_every),
    updatedBy: row.updated_by ? String(row.updated_by) : null,
    updatedAt: row.updated_at ? new Date(row.updated_at).toISOString() : null,
    seenAt: row.seen_at ? new Date(row.seen_at).toISOString() : null,
    worldserverReading: Number(row.seen_recently) === 1,
  };
}

export interface SummonRewardsUpdate {
  enabled: boolean;
  pointsPerSummon: number;
  dailyPointCap: number;
  pairCooldownMinutes: number;
  announceEvery: number;
}

export interface ValidationIssue {
  field: keyof SummonRewardsUpdate;
  message: string;
}

export function validateSummonRewards(
  update: SummonRewardsUpdate
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  type NumericField = Exclude<keyof SummonRewardsUpdate, "enabled">;
  const limits: [NumericField, number, string][] = [
    ["pointsPerSummon", 10000, "Points per summon"],
    ["dailyPointCap", 65535, "Daily cap"],
    ["pairCooldownMinutes", 30 * 24 * 60, "Pair cooldown"],
    ["announceEvery", 1000000, "Announce interval"],
  ];
  for (const [field, max, label] of limits) {
    const value = update[field];
    if (!Number.isInteger(value) || value < 0 || value > max) {
      issues.push({
        field,
        message: `${label} must be a whole number between 0 and ${max}.`,
      });
    }
  }
  // A cap below the per-summon price would pay nothing at all, which reads as
  // "rewards are broken" rather than "the cap is low".
  if (
    issues.length === 0 &&
    update.dailyPointCap > 0 &&
    update.dailyPointCap < update.pointsPerSummon
  ) {
    issues.push({
      field: "dailyPointCap",
      message:
        "The daily cap must be at least the points per summon, or nothing is ever awarded.",
    });
  }
  return issues;
}

export async function saveSummonRewards(
  update: SummonRewardsUpdate,
  username: string
): Promise<SummonRewards> {
  await ensureWebDb();
  await getPool().query(
    `UPDATE \`${WEB_DB}\`.summon_rewards
        SET enabled = ?, points_per_summon = ?, daily_point_cap = ?,
            pair_cooldown_minutes = ?, announce_every = ?,
            updated_by = ?, updated_at = NOW()
      WHERE id = 1`,
    [
      update.enabled ? 1 : 0,
      update.pointsPerSummon,
      update.dailyPointCap,
      update.pairCooldownMinutes,
      update.announceEvery,
      username.slice(0, 32),
    ]
  );
  return getSummonRewards();
}

// ── Bounties ───────────────────────────────────────────────────────────────
//
// A bounty is a multiplier on the *summoned* account: summoning any character
// on that account pays the summoner more (or, at 0, nothing at all). It does
// nothing for that account's own summons.

/** 2× — what the admin form offers by default. */
export const DEFAULT_BONUS_PCT = 200;

/** 200 → "2×", 150 → "1.5×". */
export function formatMultiplier(pct: number): string {
  const times = pct / 100;
  return `${Number.isInteger(times) ? times : times.toFixed(1)}×`;
}

export interface SummonBonus {
  accountId: number;
  username: string | null;
  multiplierPct: number;
  note: string | null;
  createdBy: string | null;
  createdAt: string | null;
  /** Characters players will actually see on the bounty list. */
  characters: string[];
}

export async function listSummonBonuses(): Promise<SummonBonus[]> {
  await ensureWebDb();
  const pool = getPool();
  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT b.account_id, b.multiplier_pct, b.note, b.created_by, b.created_at,
            a.username
       FROM \`${WEB_DB}\`.summon_account_bonus b
       LEFT JOIN \`${AUTH_DB}\`.account a ON a.id = b.account_id
      ORDER BY b.multiplier_pct DESC, a.username`
  );
  if (rows.length === 0) return [];

  // A bounty is on the account, and an account's characters are spread across
  // every realm — so the names players are told to look for have to come from
  // all of them. Queried per realm rather than from one hardcoded database,
  // which named no realm at all once realms.yml took over and left every
  // bounty with an empty character list (and so hidden from the UI, which
  // filters them out).
  const accountIds = rows.map((r) => Number(r.account_id));
  const realms = await listRealmsWithConfig();
  const byAccount = new Map<number, string[]>();
  for (const realm of realms) {
    try {
      const [chars] = await pool.query<RowDataPacket[]>(
        `SELECT account, name FROM \`${realm.charsDb}\`.characters
          WHERE account IN (?) AND deleteInfos_Account IS NULL
          ORDER BY level DESC, name`,
        [accountIds]
      );
      for (const c of chars) {
        const list = byAccount.get(Number(c.account)) ?? [];
        list.push(String(c.name));
        byAccount.set(Number(c.account), list);
      }
    } catch {
      // A realm whose database is not imported yet contributes no names.
    }
  }

  return rows.map((r) => ({
    accountId: Number(r.account_id),
    username: r.username ? String(r.username) : null,
    multiplierPct: Number(r.multiplier_pct),
    note: r.note ? String(r.note) : null,
    createdBy: r.created_by ? String(r.created_by) : null,
    createdAt: r.created_at ? new Date(r.created_at).toISOString() : null,
    characters: byAccount.get(Number(r.account_id)) ?? [],
  }));
}

/** account_id → multiplier percentage, for one sweep. */
async function bonusMap(): Promise<Map<number, number>> {
  const [rows] = await getPool().query<RowDataPacket[]>(
    `SELECT account_id, multiplier_pct FROM \`${WEB_DB}\`.summon_account_bonus`
  );
  return new Map(
    rows.map((r) => [Number(r.account_id), Number(r.multiplier_pct)])
  );
}

export async function setSummonBonus(input: {
  accountId: number;
  multiplierPct: number;
  note: string | null;
  createdBy: string;
}): Promise<void> {
  // 10× is already absurd on a private realm; the ceiling only exists so a
  // typo cannot mint a fortune.
  if (
    !Number.isInteger(input.multiplierPct) ||
    input.multiplierPct < 0 ||
    input.multiplierPct > 1000
  ) {
    throw new HttpError(400, "Multiplier must be between 0 and 10.");
  }
  await ensureWebDb();
  await getPool().query(
    `INSERT INTO \`${WEB_DB}\`.summon_account_bonus
       (account_id, multiplier_pct, note, created_by)
     VALUES (?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       multiplier_pct = VALUES(multiplier_pct),
       note = VALUES(note),
       created_by = VALUES(created_by),
       created_at = NOW()`,
    [
      input.accountId,
      input.multiplierPct,
      input.note ? input.note.slice(0, 255) : null,
      input.createdBy.slice(0, 32),
    ]
  );
}

export async function clearSummonBonus(accountId: number): Promise<void> {
  await ensureWebDb();
  await getPool().query(
    `DELETE FROM \`${WEB_DB}\`.summon_account_bonus WHERE account_id = ?`,
    [accountId]
  );
}

// ── Awarding ───────────────────────────────────────────────────────────────

interface PendingRow extends RowDataPacket {
  id: number;
  summoner_name: string;
  summoner_account: number;
  target_name: string;
  target_account: number;
  created_at: Date;
}

/**
 * Turn every pending summon into points (or a recorded reason it earned none).
 *
 * There is no scheduler in this stack, so this is called from the routes a
 * player or admin is already loading — the shop, the summon stats, the admin
 * page. It is idempotent and cheap when there is nothing to do: one indexed
 * lookup on (award_state, id).
 *
 * Returns how many rows were paid.
 */
export async function awardPendingSummons(): Promise<number> {
  await ensureWebDb();
  const pool = getPool();
  const [rows] = await pool.query<PendingRow[]>(
    `SELECT id, summoner_name, summoner_account, target_name, target_account,
            created_at
       FROM \`${WEB_DB}\`.summon_events
      WHERE award_state = 'pending'
      ORDER BY id
      LIMIT ${SWEEP_LIMIT}`
  );
  if (rows.length === 0) return 0;

  // Read once: settling a backlog must not change the price halfway through.
  const config = await getSummonRewards();
  const bonuses = await bonusMap();
  let paid = 0;

  for (const row of rows) {
    // A bounty on the summoned account multiplies the payout; 0 makes
    // summoning that account worthless, which is the way to shut down a farm
    // without turning rewards off for everyone.
    const bonusPct = bonuses.get(row.target_account) ?? 100;
    const points = Math.round((config.pointsPerSummon * bonusPct) / 100);

    // Rewards are usually already 'skipped' by the Lua script when they are
    // off; this catches the rows cast in the up-to-15s window before it saw
    // the change.
    if (!config.enabled || config.pointsPerSummon === 0) {
      await skip(row.id, "rewards_off");
      continue;
    }
    if (row.summoner_account === row.target_account) {
      await skip(row.id, "same_account");
      continue;
    }
    if (
      config.pairCooldownMinutes > 0 &&
      (await pairOnCooldown(row, config.pairCooldownMinutes))
    ) {
      await skip(row.id, "pair_cooldown");
      continue;
    }
    if (points === 0) {
      // Only reachable through a 0× bounty — the settings-level cases are
      // handled above.
      await skip(row.id, "zero_bounty");
      continue;
    }
    if (
      config.dailyPointCap > 0 &&
      (await pointsToday(row)) + points > config.dailyPointCap
    ) {
      await skip(row.id, "daily_cap");
      continue;
    }
    if (await credit(row, points, bonusPct)) paid++;
  }
  return paid;
}

/** Has this pair of accounts already been paid recently enough to matter? */
async function pairOnCooldown(
  row: PendingRow,
  minutes: number
): Promise<boolean> {
  // Anchored on the summon's own timestamp, not now(), so a backlog settles to
  // the same answer it would have had in real time.
  const [rows] = await getPool().query<RowDataPacket[]>(
    `SELECT 1 FROM \`${WEB_DB}\`.summon_events
      WHERE summoner_account = ? AND target_account = ?
        AND award_state = 'awarded' AND id <> ?
        AND created_at > DATE_SUB(?, INTERVAL ? MINUTE)
        AND created_at <= ?
      LIMIT 1`,
    [
      row.summoner_account,
      row.target_account,
      row.id,
      row.created_at,
      minutes,
      row.created_at,
    ]
  );
  return rows.length > 0;
}

/** Summon points this account already earned in the 24h up to this summon. */
async function pointsToday(row: PendingRow): Promise<number> {
  const [rows] = await getPool().query<RowDataPacket[]>(
    `SELECT COALESCE(SUM(awarded_points), 0) AS points
       FROM \`${WEB_DB}\`.summon_events
      WHERE summoner_account = ? AND award_state = 'awarded'
        AND created_at > DATE_SUB(?, INTERVAL 1 DAY)
        AND created_at <= ?`,
    [row.summoner_account, row.created_at, row.created_at]
  );
  return Number(rows[0]?.points ?? 0);
}

async function skip(id: number, reason: string): Promise<void> {
  await getPool().query(
    `UPDATE \`${WEB_DB}\`.summon_events
        SET award_state = 'skipped', skip_reason = ?
      WHERE id = ? AND award_state = 'pending'`,
    [reason, id]
  );
}

/** Pay one summon. False means another sweep got there first. */
async function credit(
  row: PendingRow,
  points: number,
  bonusPct: number
): Promise<boolean> {
  const conn = await getPool().getConnection();
  try {
    await conn.beginTransaction();
    const [claim] = await conn.query<ResultSetHeader>(
      `UPDATE \`${WEB_DB}\`.summon_events
          SET award_state = 'awarded', awarded_points = ?, bonus_pct = ?,
              skip_reason = NULL
        WHERE id = ? AND award_state = 'pending'`,
      [points, bonusPct, row.id]
    );
    if (claim.affectedRows === 0) {
      await conn.rollback();
      return false;
    }
    await conn.query(
      `INSERT INTO \`${WEB_DB}\`.shop_balances (account_id, balance)
       VALUES (?, ?) ON DUPLICATE KEY UPDATE balance = balance + VALUES(balance)`,
      [row.summoner_account, points]
    );
    await conn.query(
      `INSERT INTO \`${WEB_DB}\`.shop_ledger
         (account_id, delta, reason, reference, note)
       VALUES (?, ?, 'summon', ?, ?)`,
      [
        row.summoner_account,
        points,
        String(row.id),
        `${row.summoner_name} summoned ${row.target_name}` +
          (bonusPct === 100 ? "" : ` (${formatMultiplier(bonusPct)} bounty)`),
      ]
    );
    await conn.commit();
    return true;
  } catch (err) {
    await conn.rollback();
    // uq_reason_ref: this event was already paid, so the UPDATE above raced a
    // sweep that had already committed its ledger row. Nothing left to do.
    if ((err as { code?: string }).code === "ER_DUP_ENTRY") return false;
    throw err;
  } finally {
    conn.release();
  }
}

// ── Reads ──────────────────────────────────────────────────────────────────

export interface SummonLeader {
  /** Guids restart at 1 in every character database, so one alone is ambiguous. */
  realmId: number;
  guid: number;
  /** Current character name, falling back to the name at the last summon. */
  name: string;
  summons: number;
  points: number;
}

export interface SummonStats {
  /** Every summon ever counted on the realm. */
  total: number;
  last24h: number;
  pointsAwarded: number;
  pending: number;
  top: SummonLeader[];
}

export async function getSummonStats(limit = 5): Promise<SummonStats> {
  await ensureWebDb();
  const pool = getPool();
  const [totals] = await pool.query<RowDataPacket[]>(
    `SELECT COUNT(*) AS total,
            COALESCE(SUM(created_at > NOW() - INTERVAL 1 DAY), 0) AS last24h,
            COALESCE(SUM(awarded_points), 0) AS points_awarded,
            COALESCE(SUM(award_state = 'pending'), 0) AS pending
       FROM \`${WEB_DB}\`.summon_events`
  );
  // Grouped by realm as well as guid: guids restart at 1 in every character
  // database, so grouping on the guid alone merged two realms' summoners into
  // one leaderboard row and credited both to whichever name won.
  const [top] = await pool.query<RowDataPacket[]>(
    `SELECT e.realm_id, e.summoner_guid AS guid,
            MAX(e.summoner_name) AS name,
            COUNT(*) AS summons,
            COALESCE(SUM(e.awarded_points), 0) AS points
       FROM \`${WEB_DB}\`.summon_events e
      GROUP BY e.realm_id, e.summoner_guid
      ORDER BY summons DESC, name
      LIMIT ${Math.max(1, Math.min(50, Math.trunc(limit)))}`
  );

  const leaders: SummonLeader[] = top.map((t) => ({
    realmId: Number(t.realm_id),
    guid: Number(t.guid),
    name: String(t.name),
    summons: Number(t.summons),
    points: Number(t.points),
  }));
  await resolveCurrentNames(leaders);

  const row = totals[0];
  return {
    total: Number(row?.total ?? 0),
    last24h: Number(row?.last24h ?? 0),
    pointsAwarded: Number(row?.points_awarded ?? 0),
    pending: Number(row?.pending ?? 0),
    top: leaders,
  };
}

/**
 * Replace each leader's frozen summon-time name with the character's current
 * one, so a rename shows on the leaderboard. Mutates in place.
 *
 * Looked up per realm rather than against one hardcoded database: that
 * database names no realm on a manifest-driven install, so every name fell
 * back to the recorded one and a rename never appeared.
 */
async function resolveCurrentNames(leaders: SummonLeader[]): Promise<void> {
  if (leaders.length === 0) return;
  const byRealm = new Map<number, SummonLeader[]>();
  for (const leader of leaders) {
    const list = byRealm.get(leader.realmId) ?? [];
    list.push(leader);
    byRealm.set(leader.realmId, list);
  }

  const pool = getPool();
  for (const realm of await listRealmsWithConfig()) {
    const group = byRealm.get(realm.id);
    if (!group) continue;
    try {
      const [chars] = await pool.query<RowDataPacket[]>(
        `SELECT guid, name FROM \`${realm.charsDb}\`.characters WHERE guid IN (?)`,
        [group.map((leader) => leader.guid)]
      );
      const names = new Map(
        chars.map((c) => [Number(c.guid), String(c.name)])
      );
      for (const leader of group) {
        leader.name = names.get(leader.guid) ?? leader.name;
      }
    } catch {
      // A realm whose database is not imported yet keeps the recorded names.
    }
  }
}

/** The newest summons, for the admin page. */
export async function listRecentSummons(limit = 50): Promise<RowDataPacket[]> {
  await ensureWebDb();
  const [rows] = await getPool().query<RowDataPacket[]>(
    `SELECT e.id, e.summoner_name, e.target_name, e.spell, e.map, e.zone,
            e.award_state, e.awarded_points, e.bonus_pct, e.skip_reason,
            e.created_at, a.username AS summoner_account_name
       FROM \`${WEB_DB}\`.summon_events e
       LEFT JOIN \`${AUTH_DB}\`.account a ON a.id = e.summoner_account
      ORDER BY e.id DESC
      LIMIT ${Math.max(1, Math.min(200, Math.trunc(limit)))}`
  );
  return rows;
}

/** Summons credited to one account, for the shop page. */
export async function getAccountSummonSummary(
  accountId: number
): Promise<{ summons: number; points: number }> {
  await ensureWebDb();
  const [rows] = await getPool().query<RowDataPacket[]>(
    `SELECT COUNT(*) AS summons, COALESCE(SUM(awarded_points), 0) AS points
       FROM \`${WEB_DB}\`.summon_events
      WHERE summoner_account = ?`,
    [accountId]
  );
  return {
    summons: Number(rows[0]?.summons ?? 0),
    points: Number(rows[0]?.points ?? 0),
  };
}
