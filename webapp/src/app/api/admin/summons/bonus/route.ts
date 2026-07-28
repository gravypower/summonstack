import { findAccountByUsername } from "@/lib/accounts";
import { errorResponse, HttpError, requireAdmin } from "@/lib/auth";
import {
  clearSummonBonus,
  listSummonBonuses,
  setSummonBonus,
} from "@/lib/summons";

/** Put a bounty on an account: summoning its characters pays the multiplier. */
export async function POST(req: Request): Promise<Response> {
  try {
    const session = await requireAdmin();
    const body = await req.json().catch(() => ({}));

    const account = await findAccountByUsername(String(body.username ?? ""));
    if (!account) throw new HttpError(404, "No such game account.");

    // multiplierPct is validated in setSummonBonus, next to the DB write.
    await setSummonBonus({
      accountId: account.id,
      multiplierPct: Number(body.multiplierPct),
      note: typeof body.note === "string" ? body.note : null,
      createdBy: session.username,
    });
    return Response.json({
      ok: true,
      username: account.username,
      bonuses: await listSummonBonuses(),
    });
  } catch (err) {
    return errorResponse(err);
  }
}

export async function DELETE(req: Request): Promise<Response> {
  try {
    await requireAdmin();
    const accountId = Number(new URL(req.url).searchParams.get("accountId"));
    if (!Number.isInteger(accountId) || accountId <= 0) {
      throw new HttpError(400, "Which account?");
    }
    await clearSummonBonus(accountId);
    return Response.json({ ok: true, bonuses: await listSummonBonuses() });
  } catch (err) {
    return errorResponse(err);
  }
}
