import mysql from "mysql2/promise";

export const AUTH_DB = process.env.AUTH_DB || "acore_auth";
export const CHARS_DB = process.env.CHARS_DB || "acore_characters";
export const WEB_DB = process.env.WEB_DB || "summonstack_web";

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
     delivery_type ENUM('level_boost','profession_boost','item_pack') NOT NULL,
     payload JSON NOT NULL,
     enabled TINYINT(1) NOT NULL DEFAULT 1,
     created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
     PRIMARY KEY (id),
     UNIQUE KEY uq_slug (slug)
   ) ENGINE=InnoDB`,
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
     category ENUM('gear','consumable') NOT NULL,
     slot_hint VARCHAR(16) NULL,
     PRIMARY KEY (id),
     KEY idx_lookup (pack_id, class_id, spec),
     CONSTRAINT fk_pack_items_pack FOREIGN KEY (pack_id)
       REFERENCES \`__WEB_DB__\`.shop_packs (id) ON DELETE CASCADE
   ) ENGINE=InnoDB`,
];

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
      for (const ddl of SHOP_DDL) {
        await pool.query(ddl.replace("__WEB_DB__", WEB_DB));
      }
    })().catch((err) => {
      global.__ssWebDbReady = undefined;
      throw err;
    });
  }
  return global.__ssWebDbReady;
}
