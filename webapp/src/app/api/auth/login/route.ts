import { cookies } from "next/headers";
import { findAccountByUsername, isBanned } from "@/lib/accounts";
import { errorResponse, HttpError } from "@/lib/auth";
import { verifyPassword } from "@/lib/srp6";
import {
  createSessionToken,
  SESSION_COOKIE,
  sessionCookieOptions,
} from "@/lib/session";

export async function POST(req: Request): Promise<Response> {
  try {
    const { username, password } = await req.json();
    if (typeof username !== "string" || typeof password !== "string") {
      throw new HttpError(400, "Username and password are required.");
    }

    const account = await findAccountByUsername(username);
    if (
      !account ||
      !verifyPassword(username, password, account.salt, account.verifier)
    ) {
      throw new HttpError(401, "Wrong username or password.");
    }
    if (await isBanned(account.id)) {
      throw new HttpError(403, "This account is banned.");
    }

    const store = await cookies();
    store.set(
      SESSION_COOKIE,
      createSessionToken(account.id, account.username),
      sessionCookieOptions()
    );
    return Response.json({ ok: true, username: account.username });
  } catch (err) {
    return errorResponse(err);
  }
}
