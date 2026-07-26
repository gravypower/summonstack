import type { RowDataPacket } from "mysql2";
import { errorResponse, getGmLevel, requireSession } from "@/lib/auth";
import { AUTH_DB, getPool } from "@/lib/db";

export async function GET(): Promise<Response> {
  try {
    const session = await requireSession();
    const pool = getPool();
    const [rows] = await pool.query<RowDataPacket[]>(
      `SELECT username, email, joindate, last_login
         FROM \`${AUTH_DB}\`.account WHERE id = ?`,
      [session.accountId]
    );
    if (!rows[0]) return Response.json({ error: "Account not found" }, { status: 404 });
    const gmLevel = await getGmLevel(session.accountId);
    return Response.json({
      username: rows[0].username,
      email: rows[0].email,
      joindate: rows[0].joindate,
      lastLogin: rows[0].last_login,
      isAdmin: gmLevel >= 3,
    });
  } catch (err) {
    return errorResponse(err);
  }
}
