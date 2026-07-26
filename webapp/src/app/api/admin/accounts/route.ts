import type { RowDataPacket } from "mysql2";
import { errorResponse, requireAdmin } from "@/lib/auth";
import { AUTH_DB, CHARS_DB, getPool } from "@/lib/db";

export async function GET(req: Request): Promise<Response> {
  try {
    await requireAdmin();
    const q = (new URL(req.url).searchParams.get("q") ?? "").trim();
    const pool = getPool();

    const where = q ? "WHERE a.username LIKE ? OR a.email LIKE ?" : "";
    const params = q ? [`%${q}%`, `%${q}%`] : [];

    const [rows] = await pool.query<RowDataPacket[]>(
      `SELECT a.id, a.username, a.email, a.joindate, a.last_login, a.last_ip,
              COALESCE(acc.gmlevel, 0) AS gmlevel,
              CASE WHEN b.id IS NULL THEN 0 ELSE 1 END AS banned,
              COALESCE(c.chars, 0) AS characters,
              COALESCE(c.online, 0) AS online
         FROM \`${AUTH_DB}\`.account a
         LEFT JOIN (SELECT id, MAX(gmlevel) AS gmlevel
                      FROM \`${AUTH_DB}\`.account_access GROUP BY id) acc
                ON acc.id = a.id
         LEFT JOIN (SELECT id FROM \`${AUTH_DB}\`.account_banned
                     WHERE active = 1
                       AND (unbandate = bandate OR unbandate > UNIX_TIMESTAMP())
                     GROUP BY id) b
                ON b.id = a.id
         LEFT JOIN (SELECT account, COUNT(*) AS chars, MAX(online) AS online
                      FROM \`${CHARS_DB}\`.characters GROUP BY account) c
                ON c.account = a.id
         ${where}
         ORDER BY a.id
         LIMIT 200`,
      params
    );
    return Response.json({ accounts: rows });
  } catch (err) {
    return errorResponse(err);
  }
}
