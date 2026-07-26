import { errorResponse, HttpError, requireAdmin } from "@/lib/auth";
import {
  addressForClient,
  describeRealm,
  getRealm,
  isIpv4,
  listRealms,
  updateRealm,
  validateRealmUpdate,
  type RealmStatus,
} from "@/lib/realm";

/** Best guess at the browser's IP, for the "what would this client get" box. */
function clientIp(req: Request): string | null {
  const forwarded = req.headers.get("x-forwarded-for");
  const candidate =
    forwarded?.split(",")[0]?.trim() || req.headers.get("x-real-ip")?.trim();
  if (!candidate) return null;
  // ::ffff:192.168.1.5 — an IPv4 client on an IPv6 socket.
  const unmapped = candidate.replace(/^::ffff:/i, "");
  return isIpv4(unmapped) ? unmapped : null;
}

/**
 * The host the admin actually typed to reach this page is usually the address
 * the realm should hand out, so offer it as a one-click suggestion.
 */
function suggestions(req: Request): string[] {
  const found: string[] = [];
  const push = (value: string | undefined | null) => {
    if (!value) return;
    const host = value.split(":")[0];
    if (host && host !== "localhost" && !host.startsWith("127.") && !found.includes(host)) {
      found.push(host);
    }
  };
  push(req.headers.get("host"));
  try {
    push(new URL(process.env.SITE_URL || "").hostname);
  } catch {
    // SITE_URL unset or malformed — nothing to suggest from it.
  }
  return found;
}

export async function GET(req: Request): Promise<Response> {
  try {
    await requireAdmin();

    let realms: RealmStatus[] = [];
    let unavailable = false;
    try {
      realms = await Promise.all((await listRealms()).map(describeRealm));
    } catch {
      // Databases may not be imported yet on first boot.
      unavailable = true;
    }

    const url = new URL(req.url);
    const probeIp = url.searchParams.get("clientIp")?.trim() || clientIp(req);

    return Response.json({
      realms,
      unavailable,
      clientIp: clientIp(req),
      suggestions: suggestions(req),
      preview: probeIp
        ? {
            clientIp: probeIp,
            results: realms.map((realm) => ({
              id: realm.id,
              name: realm.name,
              outcome: addressForClient(realm, probeIp),
            })),
          }
        : null,
    });
  } catch (err) {
    return errorResponse(err);
  }
}

export async function POST(req: Request): Promise<Response> {
  try {
    await requireAdmin();
    const body = await req.json().catch(() => ({}));

    const id = Number(body.id);
    if (!Number.isInteger(id)) throw new HttpError(400, "Missing realm id.");
    const existing = await getRealm(id);
    if (!existing) throw new HttpError(404, "No such realm.");

    const update = {
      id,
      address: String(body.address ?? "").trim(),
      localAddress: String(body.localAddress ?? "").trim(),
      localSubnetMask: String(body.localSubnetMask ?? "").trim(),
      port: Number(body.port),
    };

    const issues = await validateRealmUpdate(update);
    if (issues.length > 0) {
      return Response.json(
        { error: issues.map((i) => i.message).join(" "), issues },
        { status: 400 }
      );
    }

    await updateRealm(update);
    const saved = await getRealm(id);
    return Response.json({
      ok: true,
      realm: saved ? await describeRealm(saved) : null,
    });
  } catch (err) {
    return errorResponse(err);
  }
}
