import type { ResultSetHeader, RowDataPacket } from "mysql2";
import { cookies } from "next/headers";
import {
  createGameAccount,
  findAccountByUsername,
  validateCredentials,
} from "@/lib/accounts";
import { errorResponse, HttpError } from "@/lib/auth";
import { ensureWebDb, getPool, WEB_DB } from "@/lib/db";
import {
  createSessionToken,
  SESSION_COOKIE,
  sessionCookieOptions,
} from "@/lib/session";

export async function POST(req: Request): Promise<Response> {
  try {
    const { token, username, password, email } = await req.json();
    if (typeof token !== "string" || token.length < 16) {
      throw new HttpError(400, "Missing invite token.");
    }
    validateCredentials(String(username ?? ""), String(password ?? ""));
    const cleanEmail =
      typeof email === "string" && email.length <= 255 ? email.trim() : "";

    await ensureWebDb();
    const pool = getPool();

    if (await findAccountByUsername(username)) {
      throw new HttpError(409, "That username is already taken.");
    }

    // Claim the invite atomically so it can only be used once.
    const [claim] = await pool.query<ResultSetHeader>(
      `UPDATE \`${WEB_DB}\`.invites
          SET used_by = ?, used_at = NOW()
        WHERE token = ? AND used_by IS NULL
          AND (expires_at IS NULL OR expires_at > NOW())`,
      [username.toUpperCase(), token]
    );
    if (claim.affectedRows !== 1) {
      throw new HttpError(
        403,
        "This invite link is invalid, expired, or already used."
      );
    }

    let accountId: number;
    try {
      accountId = await createGameAccount(username, password, cleanEmail);
    } catch (err) {
      // Release the invite if account creation raced or failed.
      await pool.query(
        `UPDATE \`${WEB_DB}\`.invites
            SET used_by = NULL, used_at = NULL
          WHERE token = ?`,
        [token]
      );
      const dup = (err as { code?: string }).code === "ER_DUP_ENTRY";
      throw dup ? new HttpError(409, "That username is already taken.") : err;
    }

    const store = await cookies();
    store.set(
      SESSION_COOKIE,
      createSessionToken(accountId, username.toUpperCase()),
      sessionCookieOptions()
    );
    return Response.json({ ok: true });
  } catch (err) {
    return errorResponse(err);
  }
}

/** GET /api/auth/register?token=... — check an invite before showing the form. */
export async function GET(req: Request): Promise<Response> {
  try {
    const token = new URL(req.url).searchParams.get("token") ?? "";
    if (token.length < 16) return Response.json({ valid: false });
    await ensureWebDb();
    const pool = getPool();
    const [rows] = await pool.query<RowDataPacket[]>(
      `SELECT 1 FROM \`${WEB_DB}\`.invites
        WHERE token = ? AND used_by IS NULL
          AND (expires_at IS NULL OR expires_at > NOW())
        LIMIT 1`,
      [token]
    );
    return Response.json({ valid: rows.length > 0 });
  } catch (err) {
    return errorResponse(err);
  }
}
