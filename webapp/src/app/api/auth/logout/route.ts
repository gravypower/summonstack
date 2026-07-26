import { cookies } from "next/headers";
import { SESSION_COOKIE } from "@/lib/session";

export async function POST(): Promise<Response> {
  const store = await cookies();
  store.delete(SESSION_COOKIE);
  return Response.json({ ok: true });
}
