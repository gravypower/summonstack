import { findAccountByUsername } from "@/lib/accounts";
import { errorResponse, HttpError, requireAdmin } from "@/lib/auth";
import { grantPoints, listBalances, listRecentLedger } from "@/lib/shop";

export async function GET(): Promise<Response> {
  try {
    await requireAdmin();
    const [balances, ledger] = await Promise.all([
      listBalances(),
      listRecentLedger(),
    ]);
    return Response.json({ balances, ledger });
  } catch (err) {
    return errorResponse(err);
  }
}

export async function POST(req: Request): Promise<Response> {
  try {
    const session = await requireAdmin();
    const body = await req.json().catch(() => ({}));

    const account = await findAccountByUsername(String(body.username ?? ""));
    if (!account) throw new HttpError(404, "No such game account.");

    const amount = Number(body.amount);
    if (!Number.isInteger(amount) || amount === 0 || Math.abs(amount) > 1_000_000) {
      throw new HttpError(400, "Amount must be a non-zero integer.");
    }
    const note = typeof body.note === "string" ? body.note.slice(0, 200) : "";

    const balance = await grantPoints({
      accountId: account.id,
      delta: amount,
      reason: "admin_grant",
      reference: null,
      note: `by ${session.username}${note ? `: ${note}` : ""}`,
    });
    return Response.json({ ok: true, username: account.username, balance });
  } catch (err) {
    return errorResponse(err);
  }
}
