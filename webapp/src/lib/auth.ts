import type { RowDataPacket } from "mysql2";
import { AUTH_DB, getPool } from "./db";
import { getSession, passwordFingerprint, type Session } from "./session";

/** Live GM level from account_access (RealmID -1 = all realms). */
export async function getGmLevel(accountId: number): Promise<number> {
  const pool = getPool();
  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT MAX(gmlevel) AS gmlevel FROM \`${AUTH_DB}\`.account_access WHERE id = ?`,
    [accountId]
  );
  return Number(rows[0]?.gmlevel ?? 0) || 0;
}

/**
 * Re-check a signed cookie against the account it names.
 *
 * A signature only proves the cookie was ours when it was issued. Two things
 * can happen afterwards that must end the session immediately rather than in
 * up to seven days: the password changes (which regenerates the SRP salt, so
 * the fingerprint stops matching), and the account is banned. Both used to be
 * invisible here — a banned player kept full portal and shop access, and a
 * password reset an admin performed to lock someone out did not log them out.
 *
 * One indexed lookup per authenticated request, which is the price of the
 * cookie being revocable at all.
 */
export async function assertSessionLive(session: Session): Promise<void> {
  const [rows] = await getPool().query<RowDataPacket[]>(
    `SELECT a.salt,
            (b.id IS NOT NULL) AS banned
       FROM \`${AUTH_DB}\`.account a
       LEFT JOIN \`${AUTH_DB}\`.account_banned b
              ON b.id = a.id AND b.active = 1
             AND (b.unbandate = b.bandate OR b.unbandate > UNIX_TIMESTAMP())
      WHERE a.id = ?`,
    [session.accountId]
  );
  const row = rows[0];
  if (!row) throw new HttpError(401, "Please log in again.");
  if (Number(row.banned) === 1) throw new HttpError(403, "This account is banned.");
  if (passwordFingerprint(row.salt as Buffer) !== session.pv) {
    throw new HttpError(401, "Your password changed — please log in again.");
  }
}

export async function requireSession(): Promise<Session> {
  const session = await getSession();
  if (!session) throw new HttpError(401, "Not logged in");
  await assertSessionLive(session);
  return session;
}

/** Session + gmlevel >= 3, for admin pages and APIs. */
export async function requireAdmin(): Promise<Session> {
  const session = await requireSession();
  const gmLevel = await getGmLevel(session.accountId);
  if (gmLevel < 3) throw new HttpError(403, "Admin access required");
  return session;
}

export class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export function errorResponse(err: unknown): Response {
  if (err instanceof HttpError) {
    return Response.json({ error: err.message }, { status: err.status });
  }
  console.error(err);
  return Response.json({ error: "Internal server error" }, { status: 500 });
}
