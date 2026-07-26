import type { RowDataPacket } from "mysql2";
import { AUTH_DB, getPool } from "./db";
import { getSession, type Session } from "./session";

/** Live GM level from account_access (RealmID -1 = all realms). */
export async function getGmLevel(accountId: number): Promise<number> {
  const pool = getPool();
  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT MAX(gmlevel) AS gmlevel FROM \`${AUTH_DB}\`.account_access WHERE id = ?`,
    [accountId]
  );
  return Number(rows[0]?.gmlevel ?? 0) || 0;
}

export async function requireSession(): Promise<Session> {
  const session = await getSession();
  if (!session) throw new HttpError(401, "Not logged in");
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
