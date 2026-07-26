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
    })().catch((err) => {
      global.__ssWebDbReady = undefined;
      throw err;
    });
  }
  return global.__ssWebDbReady;
}
