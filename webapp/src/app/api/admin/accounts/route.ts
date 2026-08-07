import type { RowDataPacket } from "mysql2";
import { errorResponse, requireAdmin } from "@/lib/auth";
import { AUTH_DB, getPool } from "@/lib/db";
import { listRealmsWithConfig } from "@/lib/realm";

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
              CASE WHEN b.id IS NULL THEN 0 ELSE 1 END AS banned
         FROM \`${AUTH_DB}\`.account a
         LEFT JOIN (SELECT id, MAX(gmlevel) AS gmlevel
                      FROM \`${AUTH_DB}\`.account_access GROUP BY id) acc
                ON acc.id = a.id
         LEFT JOIN (SELECT id FROM \`${AUTH_DB}\`.account_banned
                     WHERE active = 1
                       AND (unbandate = bandate OR unbandate > UNIX_TIMESTAMP())
                     GROUP BY id) b
                ON b.id = a.id
         ${where}
         ORDER BY a.id
         LIMIT 200`,
      params
    );

    // Character counts come from every realm's own database and are summed
    // here, rather than from one hardcoded database that names no realm on a
    // manifest-driven install — which showed every account as having none.
    // Done as a second pass so one unimported realm cannot fail the whole page.
    const accountIds = rows.map((r) => Number(r.id));
    const counts = new Map<number, { characters: number; online: number }>();
    if (accountIds.length > 0) {
      for (const realm of await listRealmsWithConfig()) {
        try {
          const [chars] = await pool.query<RowDataPacket[]>(
            `SELECT account, COUNT(*) AS chars, MAX(online) AS online
               FROM \`${realm.charsDb}\`.characters
              WHERE account IN (?)
              GROUP BY account`,
            [accountIds]
          );
          for (const c of chars) {
            const id = Number(c.account);
            const seen = counts.get(id) ?? { characters: 0, online: 0 };
            counts.set(id, {
              characters: seen.characters + Number(c.chars),
              // Online anywhere is online.
              online: Math.max(seen.online, Number(c.online)),
            });
          }
        } catch {
          // A realm whose database is not imported yet contributes nothing.
        }
      }
    }

    return Response.json({
      accounts: rows.map((row) => ({
        ...row,
        characters: counts.get(Number(row.id))?.characters ?? 0,
        online: counts.get(Number(row.id))?.online ?? 0,
      })),
    });
  } catch (err) {
    return errorResponse(err);
  }
}
