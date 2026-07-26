import { errorResponse, HttpError, requireSession } from "@/lib/auth";
import { purchase } from "@/lib/shop";

// Purchases are atomic and idempotent, so bursts are safe — this limit just
// keeps a scripted client from generating ledger noise and mail spam.
const RATE_LIMIT = 5;
const RATE_WINDOW_MS = 60_000;
const recent = new Map<number, number[]>();

function checkRateLimit(accountId: number): void {
  const now = Date.now();
  const hits = (recent.get(accountId) ?? []).filter(
    (t) => now - t < RATE_WINDOW_MS
  );
  if (hits.length >= RATE_LIMIT) {
    throw new HttpError(429, "Too many purchases at once — wait a minute.");
  }
  hits.push(now);
  recent.set(accountId, hits);
}

export async function POST(req: Request): Promise<Response> {
  try {
    const session = await requireSession();
    checkRateLimit(session.accountId);

    const body = await req.json().catch(() => ({}));
    const idempotencyKey = String(body.idempotencyKey ?? "");
    if (!/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(idempotencyKey)) {
      throw new HttpError(400, "Missing idempotency key.");
    }

    const txn = await purchase({
      accountId: session.accountId,
      productSlug: String(body.productSlug ?? ""),
      characterGuid: Number(body.characterGuid),
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
