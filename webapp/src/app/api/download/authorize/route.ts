import { assertSessionLive } from "@/lib/auth";
import { getSession } from "@/lib/session";

/**
 * Subrequest target for the download server's nginx `auth_request`.
 *
 * nginx forwards the player's cookies here and serves the client zip only on a
 * 2xx. Nothing but the status line is used, so the body stays empty.
 *
 * The session is re-checked against the account rather than merely unsealed:
 * this is the one gate on an ~18 GB download, so a banned account or a cookie
 * predating a password reset should not still open it.
 */
export async function GET(): Promise<Response> {
  const session = await getSession();
  if (!session) return new Response(null, { status: 401 });
  try {
    await assertSessionLive(session);
  } catch {
    return new Response(null, { status: 401 });
  }
  return new Response(null, { status: 204 });
}
