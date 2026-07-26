import { randomBytes } from "node:crypto";
import type { ResultSetHeader, RowDataPacket } from "mysql2";
import { errorResponse, HttpError, requireAdmin } from "@/lib/auth";
import { ensureWebDb, getPool, WEB_DB } from "@/lib/db";

function inviteUrl(token: string): string {
  const base = (process.env.SITE_URL || "http://localhost:8080").replace(/\/$/, "");
  return `${base}/register?token=${token}`;
}

export async function GET(): Promise<Response> {
  try {
    await requireAdmin();
    await ensureWebDb();
    const pool = getPool();
    const [rows] = await pool.query<RowDataPacket[]>(
      `SELECT id, token, note, created_by, created_at, expires_at, used_by, used_at
         FROM \`${WEB_DB}\`.invites
        ORDER BY id DESC LIMIT 200`
    );
    return Response.json({
      invites: rows.map((row) => ({ ...row, url: inviteUrl(String(row.token)) })),
    });
  } catch (err) {
    return errorResponse(err);
  }
}

export async function POST(req: Request): Promise<Response> {
  try {
    const session = await requireAdmin();
    await ensureWebDb();
    const body = await req.json().catch(() => ({}));
    const note =
      typeof body.note === "string" ? body.note.slice(0, 255) : null;
    const expiresDays = Number(body.expiresDays);
    const token = randomBytes(24).toString("base64url");

    const pool = getPool();
    await pool.query(
      `INSERT INTO \`${WEB_DB}\`.invites (token, note, created_by, expires_at)
       VALUES (?, ?, ?, ${
         Number.isFinite(expiresDays) && expiresDays > 0
           ? "DATE_ADD(NOW(), INTERVAL ? DAY)"
           : "NULL"
       })`,
      Number.isFinite(expiresDays) && expiresDays > 0
        ? [token, note, session.username, Math.min(expiresDays, 365)]
        : [token, note, session.username]
    );
    return Response.json({ ok: true, token, url: inviteUrl(token) });
  } catch (err) {
    return errorResponse(err);
  }
}

export async function DELETE(req: Request): Promise<Response> {
  try {
    await requireAdmin();
    await ensureWebDb();
    const id = Number(new URL(req.url).searchParams.get("id"));
    if (!Number.isInteger(id)) throw new HttpError(400, "Missing invite id.");
    const pool = getPool();
    const [result] = await pool.query<ResultSetHeader>(
      `DELETE FROM \`${WEB_DB}\`.invites WHERE id = ? AND used_by IS NULL`,
      [id]
    );
    if (result.affectedRows !== 1) {
      throw new HttpError(409, "Invite not found or already used.");
    }
    return Response.json({ ok: true });
  } catch (err) {
    return errorResponse(err);
  }
}
