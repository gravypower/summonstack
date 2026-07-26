import { getSession } from "@/lib/session";

/**
 * Subrequest target for the download server's nginx `auth_request`.
 *
 * nginx forwards the player's cookies here and serves the client zip only on a
 * 2xx. Nothing but the status line is used, so the body stays empty.
 */
export async function GET(): Promise<Response> {
  const session = await getSession();
  return new Response(null, { status: session ? 204 : 401 });
}
