import { listRealmsWithConfig } from "@/lib/realm";
import { getServerStatus } from "@/lib/status";

export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  const realms = await listRealmsWithConfig();
  const status = await getServerStatus();
  return Response.json({
    realms,
    status,
  });
}
