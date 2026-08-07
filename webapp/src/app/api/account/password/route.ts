import {
  findAccountByUsername,
  setAccountPassword,
  validateCredentials,
} from "@/lib/accounts";
import { cookies } from "next/headers";
import { errorResponse, HttpError, requireSession } from "@/lib/auth";
import {
  createSessionToken,
  passwordFingerprint,
  SESSION_COOKIE,
  sessionCookieOptions,
} from "@/lib/session";
import { verifyPassword } from "@/lib/srp6";

export async function POST(req: Request): Promise<Response> {
  try {
    const session = await requireSession();
    const { currentPassword, newPassword } = await req.json();

    const account = await findAccountByUsername(session.username);
    if (
      !account ||
      !verifyPassword(
        session.username,
        String(currentPassword ?? ""),
        account.salt,
        account.verifier
      )
    ) {
      throw new HttpError(403, "Current password is incorrect.");
    }

    validateCredentials(session.username, String(newPassword ?? ""));
    const salt = await setAccountPassword(account.id, session.username, newPassword);

    // Changing the password invalidates every cookie stamped with the old
    // salt — including this request's own. Re-issue it so the person who just
    // changed their password stays logged in, while sessions opened elsewhere
    // (or by whoever they are changing it away from) are dropped.
    const store = await cookies();
    store.set(
      SESSION_COOKIE,
      createSessionToken(account.id, session.username, passwordFingerprint(salt)),
      sessionCookieOptions()
    );
    return Response.json({ ok: true });
  } catch (err) {
    return errorResponse(err);
  }
}
