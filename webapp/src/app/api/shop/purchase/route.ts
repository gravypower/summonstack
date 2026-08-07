import { errorResponse, HttpError, requireSession } from "@/lib/auth";
import { RateLimiter } from "@/lib/rate-limit";
import { purchase } from "@/lib/shop";

// Purchases are atomic and idempotent, so bursts are safe — this limit just
// keeps a scripted client from generating ledger noise and mail spam.
const purchaseLimit = new RateLimiter(5, 60_000);

export async function POST(req: Request): Promise<Response> {
  try {
    const session = await requireSession();
    purchaseLimit.check(session.accountId);

    const body = await req.json().catch(() => ({}));
    const idempotencyKey = String(body.idempotencyKey ?? "");
    if (!/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(idempotencyKey)) {
      throw new HttpError(400, "Missing idempotency key.");
    }

    const txn = await purchase({
      accountId: session.accountId,
      productSlug: String(body.productSlug ?? ""),
      characterGuid: Number(body.characterGuid),
      realmId: typeof body.realmId === "number" ? body.realmId : undefined,
      spec: typeof body.spec === "string" && body.spec ? body.spec : null,
      idempotencyKey,
    });

    return Response.json({
      ok: txn.status === "delivered",
      transaction: {
        id: txn.id,
        status: txn.status,
        characterName: txn.character_name,
        pricePaid: txn.price_paid,
        error: txn.error,
      },
    });
  } catch (err) {
    return errorResponse(err);
  }
}
