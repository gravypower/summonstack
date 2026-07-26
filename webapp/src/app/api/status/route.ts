import { getServerStatus } from "@/lib/status";

export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  return Response.json(await getServerStatus());
}
