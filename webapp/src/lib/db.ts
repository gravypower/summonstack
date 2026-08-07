import mysql from "mysql2/promise";
import type { RowDataPacket } from "mysql2";

export const AUTH_DB = process.env.AUTH_DB || "acore_auth";
export const WEB_DB = process.env.WEB_DB || "summonstack_web";

// There is deliberately no CHARS_DB export. The character database differs per
// realm (acore_characters_1, acore_characters_pb_2 …), so a single constant
// named no realm at all once realms.yml took over — reads returned nothing and
// writes landed on an unrelated character, both silently. Get the database
// from getRealmConfig()/getRealmConfigById() in lib/realm.ts instead, which
// resolves it per realm from the manifest. (The same reasoning is written out
// at the top of worldserver/lua_scripts/summons.lua, which hit this first.)

declare global {
  // eslint-disable-next-line no-var
  var __ssPool: mysql.Pool | undefined;
  // eslint-disable-next-line no-var
  var __ssWebDbReady: Promise<void> | undefined;
}

export function getPool(): mysql.Pool {
  if (!global.__ssPool) {
    global.__ssPool = mysql.createPool({
      host: process.env.DB_HOST || "127.0.0.1",
      port: Number(process.env.DB_PORT || 3306),
      user: process.env.DB_USER || "root",
      password: process.env.DB_PASS || "",
      waitForConnections: true,
      connectionLimit: 10,
      // account.salt / account.verifier are BINARY(32)
      supportBigNumbers: true,
    });
  }
  return global.__ssPool;
}

// The web DB is the ledger for shop currency; the game server only ever
// receives delivery instructions after a transaction row is committed.
const SHOP_DDL = [
  // Balance is a cache; shop_ledger is the truth. One row per game account
  // (acore_auth.account.id — no FK across databases, verified in code).
  `CREATE TABLE IF NOT EXISTS \`__WEB_DB__\`.shop_balances (
     account_id INT UNSIGNED NOT NULL,
     balance INT UNSIGNED NOT NULL DEFAULT 0,
     updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
     PRIMARY KEY (account_id)
   ) ENGINE=InnoDB`,
  // Append-only: corrections are new rows, never UPDATE/DELETE. uq_reason_ref
  // makes external credit callbacks (votes, payments) idempotent.
  `CREATE TABLE IF NOT EXISTS \`__WEB_DB__\`.shop_ledger (
     id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
     account_id INT UNSIGNED NOT NULL,
     delta INT NOT NULL,
     reason ENUM('vote','donation','admin_grant','purchase','refund') NOT NULL,
     reference VARCHAR(64) NULL,
     note VARCHAR(255) NULL,
     created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
     PRIMARY KEY (id),
     KEY idx_account_time (account_id, created_at),
     UNIQUE KEY uq_reason_ref (reason, reference)
   ) ENGINE=InnoDB`,
  `CREATE TABLE IF NOT EXISTS \`__WEB_DB__\`.shop_products (
     id INT UNSIGNED NOT NULL AUTO_INCREMENT,
     slug VARCHAR(64) NOT NULL,
     name VARCHAR(128) NOT NULL,
     description TEXT NULL,
     price INT UNSIGNED NOT NULL,
     delivery_type ENUM('level_boost','profession_boost','item_pack','xp_lock','playerbot_slot') NOT NULL,
     payload JSON NOT NULL,
     enabled TINYINT(1) NOT NULL DEFAULT 1,
     created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
     PRIMARY KEY (id),
     UNIQUE KEY uq_slug (slug)
   ) ENGINE=InnoDB`,
  // 'xp_lock' and 'playerbot_slot' were added after the first installs; CREATE TABLE IF NOT EXISTS
  // above won't widen an existing enum, and re-running a MODIFY is harmless.
  `ALTER TABLE \`__WEB_DB__\`.shop_products
     MODIFY delivery_type
       ENUM('level_boost','profession_boost','item_pack','xp_lock','playerbot_slot') NOT NULL`,
  // payload_snapshot freezes the resolved delivery (exact items for the
  // buyer's class/spec) so later catalog edits never change what was sold.
  `CREATE TABLE IF NOT EXISTS \`__WEB_DB__\`.shop_transactions (
     id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
     idempotency_key CHAR(36) NOT NULL,
     account_id INT UNSIGNED NOT NULL,
     product_id INT UNSIGNED NOT NULL,
     price_paid INT UNSIGNED NOT NULL,
     character_guid INT UNSIGNED NOT NULL,
     character_name VARCHAR(12) NOT NULL,
     payload_snapshot JSON NOT NULL,
     status ENUM('pending','delivering','delivered','failed','refunded') NOT NULL DEFAULT 'pending',
     attempts TINYINT UNSIGNED NOT NULL DEFAULT 0,
     error TEXT NULL,
     created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
     updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
     PRIMARY KEY (id),
     UNIQUE KEY uq_idem (idempotency_key),
     KEY idx_account (account_id, created_at),
     KEY idx_status (status)
   ) ENGINE=InnoDB`,
  `CREATE TABLE IF NOT EXISTS \`__WEB_DB__\`.shop_packs (
     id INT UNSIGNED NOT NULL AUTO_INCREMENT,
     slug VARCHAR(32) NOT NULL,
     name VARCHAR(64) NOT NULL,
     level_cap TINYINT UNSIGNED NOT NULL,
     min_level TINYINT UNSIGNED NOT NULL,
     PRIMARY KEY (id),
     UNIQUE KEY uq_slug (slug)
   ) ENGINE=InnoDB`,
  // class_id NULL = every class gets it; spec NULL = every spec of the class.
  `CREATE TABLE IF NOT EXISTS \`__WEB_DB__\`.shop_pack_items (
     id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
     pack_id INT UNSIGNED NOT NULL,
     class_id TINYINT UNSIGNED NULL,
     spec VARCHAR(24) NULL,
     item_id INT UNSIGNED NOT NULL,
     count SMALLINT UNSIGNED NOT NULL DEFAULT 1,
     category ENUM('gear','consumable','bag') NOT NULL,
     slot_hint VARCHAR(16) NULL,
     PRIMARY KEY (id),
     KEY idx_lookup (pack_id, class_id, spec),
     CONSTRAINT fk_pack_items_pack FOREIGN KEY (pack_id)
       REFERENCES \`__WEB_DB__\`.shop_packs (id) ON DELETE CASCADE
   ) ENGINE=InnoDB`,
  // One row per character ever locked, read every few seconds by
  // worldserver/lua_scripts/xp.lua. released_at IS NULL means the lock is
  // live; releasing keeps the row so the history survives a re-lock.
  //
  // Keyed by realm as well as guid: character guids restart at 1 in every
  // character database, so guid 5 on one realm and guid 5 on another are
  // different characters and must be able to hold locks independently.
  `CREATE TABLE IF NOT EXISTS \`__WEB_DB__\`.shop_xp_locks (
     character_guid INT UNSIGNED NOT NULL,
     account_id INT UNSIGNED NOT NULL,
     realm_id INT UNSIGNED NOT NULL DEFAULT 1,
     target_level TINYINT UNSIGNED NOT NULL,
     locked_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
     released_at DATETIME NULL,
     PRIMARY KEY (realm_id, character_guid),
     KEY idx_active (released_at)
   ) ENGINE=InnoDB`,
];

// Summon rewards. worldserver/lua_scripts/summons.lua appends one row per
// counted summon and reads the settings row; the webapp turns rows into
// points. Kept apart from SHOP_DDL only because the shop predates it — both
// are duplicated in scripts/seed-shop.mjs.
const SUMMON_DDL = [
  // 'summon' was added after the first installs, so the enum in the CREATE
  // above will not have it; re-running a MODIFY is harmless.
  `ALTER TABLE \`__WEB_DB__\`.shop_ledger
     MODIFY reason
       ENUM('vote','donation','admin_grant','purchase','refund','summon') NOT NULL`,
  // Append-only log of summons, and the realm's summon counter. Names and
  // accounts are frozen at the summon: a rename or a character transfer must
  // not rewrite history, and awarding reads accounts from here.
  //
  // award_state starts 'pending'; awardPendingSummons() in lib/summons.ts
  // moves each row to 'awarded' (with a shop_ledger row keyed on this id) or
  // 'skipped' (with the rule that refused it). Rows written while rewards are
  // off arrive 'skipped' so re-enabling never pays out the backlog.
  `CREATE TABLE IF NOT EXISTS \`__WEB_DB__\`.summon_events (
     id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
     summoner_guid INT UNSIGNED NOT NULL,
     summoner_name VARCHAR(12) NOT NULL,
     summoner_account INT UNSIGNED NOT NULL,
     target_guid INT UNSIGNED NOT NULL,
     target_name VARCHAR(12) NOT NULL,
     target_account INT UNSIGNED NOT NULL,
     spell INT UNSIGNED NOT NULL,
     map SMALLINT UNSIGNED NOT NULL,
     zone SMALLINT UNSIGNED NOT NULL,
     award_state ENUM('pending','awarded','skipped') NOT NULL DEFAULT 'pending',
     awarded_points INT UNSIGNED NOT NULL DEFAULT 0,
     -- The bounty on the summoned account at payout time, frozen here so a
     -- doubled payout still explains itself after the bounty is removed.
     bonus_pct SMALLINT UNSIGNED NOT NULL DEFAULT 100,
     skip_reason VARCHAR(32) NULL,
     created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
     PRIMARY KEY (id),
     KEY idx_pending (award_state, id),
     KEY idx_summoner (summoner_account, created_at),
     KEY idx_pair (summoner_account, target_account, created_at),
     KEY idx_leaderboard (summoner_guid)
   ) ENGINE=InnoDB`,
  // Bounties: summoning any character on one of these accounts pays the
  // summoner multiplier_pct of the usual points. Keyed on the *summoned*
  // account — being on the list is worth nothing to its own summons.
  `CREATE TABLE IF NOT EXISTS \`__WEB_DB__\`.summon_account_bonus (
     account_id INT UNSIGNED NOT NULL,
     multiplier_pct SMALLINT UNSIGNED NOT NULL DEFAULT 200,
     note VARCHAR(255) NULL,
     created_by VARCHAR(32) NULL,
     created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
     PRIMARY KEY (account_id)
   ) ENGINE=InnoDB`,
  // One row per realm, keyed by realm id, read by that realm's Lua script
  // every 15s — so a playerbots realm can pay differently, or not at all,
  // without touching the main realm's economy. updated_at is written
  // explicitly rather than ON UPDATE, so the script's seen_at heartbeat does
  // not look like an admin edit.
  `CREATE TABLE IF NOT EXISTS \`__WEB_DB__\`.summon_rewards (
     id TINYINT UNSIGNED NOT NULL DEFAULT 1,
     enabled TINYINT(1) NOT NULL DEFAULT 1,
     points_per_summon SMALLINT UNSIGNED NOT NULL DEFAULT 5,
     daily_point_cap SMALLINT UNSIGNED NOT NULL DEFAULT 100,
     pair_cooldown_minutes SMALLINT UNSIGNED NOT NULL DEFAULT 30,
     announce_every INT UNSIGNED NOT NULL DEFAULT 50,
     updated_by VARCHAR(32) NULL,
     updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
     seen_at DATETIME NULL,
     PRIMARY KEY (id)
   ) ENGINE=InnoDB`,
];

/**
 * MySQL has no ADD COLUMN IF NOT EXISTS, so re-running a migration on an
 * install that already has the column is normal and must not fail.
 *
 * Only ER_DUP_FIELDNAME is swallowed. These blocks used to be `catch {}`,
 * which made a permission error, a lock timeout or a typo look exactly like
 * "already applied" — the app then carried on against a half-migrated schema
 * and the realm-scoping bugs this column exists to fix came back silently.
 */
async function addColumnIfMissing(
  pool: mysql.Pool,
  sql: string
): Promise<void> {
  try {
    await pool.query(sql);
  } catch (err) {
    if ((err as { code?: string }).code !== "ER_DUP_FIELDNAME") throw err;
  }
}

/** Create the webapp's own database/tables on first use. */
export async function ensureWebDb(): Promise<void> {
  if (!global.__ssWebDbReady) {
    global.__ssWebDbReady = (async () => {
      const pool = getPool();
      await pool.query(
        `CREATE DATABASE IF NOT EXISTS \`${WEB_DB}\` CHARACTER SET utf8mb4`
      );
      await pool.query(
        `CREATE TABLE IF NOT EXISTS \`${WEB_DB}\`.invites (
           id INT UNSIGNED NOT NULL AUTO_INCREMENT,
           token VARCHAR(64) NOT NULL,
           note VARCHAR(255) NULL,
           created_by VARCHAR(32) NOT NULL,
           created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
           expires_at DATETIME NULL,
           used_by VARCHAR(32) NULL,
           used_at DATETIME NULL,
           PRIMARY KEY (id),
           UNIQUE KEY uq_token (token)
         ) ENGINE=InnoDB`
      );
      // Shop tables. This DDL is duplicated in scripts/seed-shop.mjs, which
      // must be able to run before the webapp has served a request.
      for (const ddl of [...SHOP_DDL, ...SUMMON_DDL]) {
        // replaceAll, not replace: shop_pack_items names the database twice
        // (the table and its foreign key target).
        await pool.query(ddl.replaceAll("__WEB_DB__", WEB_DB));
      }
      // Seeds the two realms a stock install has. Realms added later get
      // their row from the first admin save (saveSummonRewards upserts). Until
      // then getSummonRewards() returns the built-in DEFAULTS for them — which
      // do pay, at 5 points a summon — rather than inheriting realm 1's row.
      await pool.query(
        `INSERT IGNORE INTO \`${WEB_DB}\`.summon_rewards (id) VALUES (1), (2)`
      );
      // One row per realm, keyed by realm id, read by that realm's copy of
      // worldserver/lua_scripts/xp.lua — so one realm can run an event while
      // another does not. updated_at is written explicitly rather than ON
      // UPDATE: the Lua script touches seen_at every few seconds and must not
      // look like an edit.
      await pool.query(
        `CREATE TABLE IF NOT EXISTS \`${WEB_DB}\`.xp_event (
           id TINYINT UNSIGNED NOT NULL DEFAULT 1,
           name VARCHAR(64) NOT NULL DEFAULT 'Joyous Journeys',
           enabled TINYINT(1) NOT NULL DEFAULT 0,
           multiplier_pct SMALLINT UNSIGNED NOT NULL DEFAULT 150,
           aura_spell INT UNSIGNED NOT NULL DEFAULT 12655,
           ends_at DATETIME NULL,
           updated_by VARCHAR(32) NULL,
           updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
           seen_at DATETIME NULL,
           PRIMARY KEY (id)
         ) ENGINE=InnoDB`
      );
      // Same as summon_rewards above: later realms get their row on first
      // save, and until then their event simply reads as off.
      await pool.query(
        `INSERT IGNORE INTO \`${WEB_DB}\`.xp_event (id) VALUES (1), (2)`
      );
      // Migrations for multi-realm support. Each adds a column that newer
      // installs already have from the CREATE above, so "duplicate column" is
      // the expected outcome and the only one worth swallowing — see
      // addColumnIfMissing.
      await addColumnIfMissing(
        pool,
        `ALTER TABLE \`${WEB_DB}\`.shop_xp_locks ADD COLUMN realm_id INT UNSIGNED NOT NULL DEFAULT 1 AFTER account_id`
      );
      await addColumnIfMissing(
        pool,
        `ALTER TABLE \`${WEB_DB}\`.shop_transactions ADD COLUMN realm_id INT UNSIGNED NOT NULL DEFAULT 1 AFTER account_id`
      );
      await addColumnIfMissing(
        pool,
        `ALTER TABLE \`${WEB_DB}\`.summon_events ADD COLUMN realm_id INT UNSIGNED NOT NULL DEFAULT 1 AFTER id`
      );
      // Widen the lock key to include the realm. Must run after the realm_id
      // column exists above. While the key was character_guid alone, a second
      // realm's character with the same guid collided with the first realm's
      // row instead of getting one of its own — so a lock bought on one realm
      // silently overwrote an unrelated character's lock on another.
      //
      // Guarded by inspecting the current key rather than by catching: getting
      // this wrong reintroduces that bug silently, so a failure here has to
      // reach the caller.
      const [pk] = await pool.query<RowDataPacket[]>(
        `SELECT COUNT(*) AS n FROM information_schema.STATISTICS
          WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'shop_xp_locks'
            AND INDEX_NAME = 'PRIMARY'`,
        [WEB_DB]
      );
      // One column in the primary key means it is still the old guid-only key.
      if (Number(pk[0]?.n ?? 0) === 1) {
        await pool.query(
          `ALTER TABLE \`${WEB_DB}\`.shop_xp_locks
             DROP PRIMARY KEY, ADD PRIMARY KEY (realm_id, character_guid)`
        );
      }
    })().catch((err) => {
      global.__ssWebDbReady = undefined;
      throw err;
    });
  }
  return global.__ssWebDbReady;
}
