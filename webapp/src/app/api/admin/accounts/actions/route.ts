import type { RowDataPacket } from "mysql2";
import { setAccountPassword, validateCredentials } from "@/lib/accounts";
import { errorResponse, HttpError, requireAdmin } from "@/lib/auth";
import { AUTH_DB, getPool } from "@/lib/db";

async function getUsername(accountId: number): Promise<string> {
  const pool = getPool();
  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT username FROM \`${AUTH_DB}\`.account WHERE id = ?`,
    [accountId]
  );
  if (!rows[0]) throw new HttpError(404, "Account not found.");
  return String(rows[0].username);
}

export async function POST(req: Request): Promise<Response> {
  try {
    const session = await requireAdmin();
    const body = await req.json();
    const accountId = Number(body.accountId);
    const action = String(body.action ?? "");
    if (!Number.isInteger(accountId) || accountId <= 0) {
      throw new HttpError(400, "Missing accountId.");
    }
    const pool = getPool();

    switch (action) {
      case "ban": {
        const reason = String(body.reason ?? "Banned via admin panel").slice(0, 255);
        const days = Number(body.days);
        const username = await getUsername(accountId);
        if (username.toUpperCase() === session.username.toUpperCase()) {
          throw new HttpError(400, "You cannot ban your own account.");
        }
        // unbandate == bandate means permanent in AzerothCore.
        await pool.query(
          `INSERT INTO \`${AUTH_DB}\`.account_banned
             (id, bandate, unbandate, bannedby, banreason, active)
           VALUES (?, UNIX_TIMESTAMP(), ${
             Number.isFinite(days) && days > 0
               ? "UNIX_TIMESTAMP() + ? * 86400"
               : "UNIX_TIMESTAMP()"
           }, ?, ?, 1)
           ON DUPLICATE KEY UPDATE active = 1, unbandate = VALUES(unbandate),
             bannedby = VALUES(bannedby), banreason = VALUES(banreason)`,
          Number.isFinite(days) && days > 0
            ? [accountId, Math.min(days, 3650), session.username, reason]
            : [accountId, session.username, reason]
        );
        return Response.json({ ok: true });
      }

      case "unban": {
        await pool.query(
          `UPDATE \`${AUTH_DB}\`.account_banned SET active = 0 WHERE id = ?`,
          [accountId]
        );
        return Response.json({ ok: true });
      }

      case "gmlevel": {
        const level = Number(body.level);
        if (![0, 1, 2, 3].includes(level)) {
          throw new HttpError(400, "GM level must be 0-3.");
        }
        const username = await getUsername(accountId);
        if (
          username.toUpperCase() === session.username.toUpperCase() &&
          level < 3
        ) {
          throw new HttpError(400, "You cannot remove your own admin access.");
        }
        if (level === 0) {
          await pool.query(
            `DELETE FROM \`${AUTH_DB}\`.account_access WHERE id = ?`,
            [accountId]
          );
        } else {
          await pool.query(
            `INSERT INTO \`${AUTH_DB}\`.account_access (id, gmlevel, RealmID, comment)
             VALUES (?, ?, -1, ?)
             ON DUPLICATE KEY UPDATE gmlevel = VALUES(gmlevel)`,
            [accountId, level, `Set via admin panel by ${session.username}`]
          );
        }
        return Response.json({ ok: true });
      }

      case "password": {
        const newPassword = String(body.newPassword ?? "");
        const username = await getUsername(accountId);
        validateCredentials(username, newPassword);
        await setAccountPassword(accountId, username, newPassword);
        return Response.json({ ok: true });
      }

      default:
        throw new HttpError(400, `Unknown action: ${action}`);
    }
  } catch (err) {
    return errorResponse(err);
  }
}
