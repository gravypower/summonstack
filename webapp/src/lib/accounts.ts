import type { ResultSetHeader, RowDataPacket } from "mysql2";
import { AUTH_DB, getPool } from "./db";
import { makeRegistrationData } from "./srp6";
import { HttpError } from "./auth";

export const USERNAME_RE = /^[A-Za-z0-9]{3,16}$/;

export interface AccountRow extends RowDataPacket {
  id: number;
  username: string;
  salt: Buffer;
  verifier: Buffer;
  email: string;
}

export function validateCredentials(username: string, password: string): void {
  if (!USERNAME_RE.test(username)) {
    throw new HttpError(
      400,
      "Username must be 3-16 letters or numbers (no spaces or symbols)."
    );
  }
  if (
    typeof password !== "string" ||
    password.length < 8 ||
    password.length > 16
  ) {
    // The 3.3.5a client silently truncates at 16 characters.
    throw new HttpError(400, "Password must be 8-16 characters.");
  }
  if (!/^[\x21-\x7e]+$/.test(password)) {
    throw new HttpError(
      400,
      "Password may only contain visible ASCII characters (no spaces)."
    );
  }
}

export async function findAccountByUsername(
  username: string
): Promise<AccountRow | null> {
  const pool = getPool();
  const [rows] = await pool.query<AccountRow[]>(
    `SELECT id, username, salt, verifier, email
       FROM \`${AUTH_DB}\`.account
      WHERE username = ?`,
    [username.toUpperCase()]
  );
  return rows[0] ?? null;
}

/**
 * Returns the new account id and the salt it was created with — the caller
 * needs the salt to stamp the session cookie, and re-reading it back out just
 * to hash it would be a second round trip for something we just generated.
 */
export async function createGameAccount(
  username: string,
  password: string,
  email: string
): Promise<{ id: number; salt: Buffer }> {
  const pool = getPool();
  const { salt, verifier } = makeRegistrationData(username, password);
  const [result] = await pool.query<ResultSetHeader>(
    `INSERT INTO \`${AUTH_DB}\`.account
       (username, salt, verifier, email, reg_mail, joindate, expansion)
     VALUES (?, ?, ?, ?, ?, NOW(), 2)`,
    [username.toUpperCase(), salt, verifier, email, email]
  );
  return { id: result.insertId, salt };
}

/** Returns the new salt, so the caller can re-stamp its own session cookie. */
export async function setAccountPassword(
  accountId: number,
  username: string,
  password: string
): Promise<Buffer> {
  const pool = getPool();
  const { salt, verifier } = makeRegistrationData(username, password);
  // Clear session_key so any cached game session is invalidated.
  await pool.query(
    `UPDATE \`${AUTH_DB}\`.account
        SET salt = ?, verifier = ?, session_key = NULL
      WHERE id = ?`,
    [salt, verifier, accountId]
  );
  return salt;
}

export async function isBanned(accountId: number): Promise<boolean> {
  const pool = getPool();
  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT 1 FROM \`${AUTH_DB}\`.account_banned
      WHERE id = ? AND active = 1
        AND (unbandate = bandate OR unbandate > UNIX_TIMESTAMP())
      LIMIT 1`,
    [accountId]
  );
  return rows.length > 0;
}
