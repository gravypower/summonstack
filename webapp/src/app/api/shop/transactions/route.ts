import { errorResponse, requireSession } from "@/lib/auth";
import { listTransactions } from "@/lib/shop";

export async function GET(): Promise<Response> {
  try {
    const session = await requireSession();
    const transactions = await listTransactions(session.accountId);
    return Response.json({ transactions });
  } catch (err) {
    return errorResponse(err);
  }
}
