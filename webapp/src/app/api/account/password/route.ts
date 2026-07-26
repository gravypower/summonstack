import {
  findAccountByUsername,
  setAccountPassword,
  validateCredentials,
} from "@/lib/accounts";
import { errorResponse, HttpError, requireSession } from "@/lib/auth";
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
    await setAccountPassword(account.id, session.username, newPassword);
    return Response.json({ ok: true });
  } catch (err) {
    return errorResponse(err);
  }
}
