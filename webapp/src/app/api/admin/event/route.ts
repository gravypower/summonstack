import { errorResponse, requireAdmin } from "@/lib/auth";
import { ensureWebDb } from "@/lib/db";
import { listRealmsWithConfig } from "@/lib/realm";
import {
  DEFAULT_AURA_SPELL,
  getXpEvent,
  saveXpEvent,
  validateXpEvent,
} from "@/lib/xp-event";

/**
 * Which realm's event this request is about. The XP event is per realm — one
 * row each — so every read and write has to name one. Defaults to realm 1,
 * which is the only realm a single-realm install has.
 */
function realmIdFrom(value: unknown): number {
  const id = Number(value);
  return Number.isInteger(id) && id > 0 ? id : 1;
}

/** Just enough for the admin page's realm picker. */
async function realmChoices(): Promise<{ id: number; name: string }[]> {
  try {
    return (await listRealmsWithConfig()).map((r) => ({ id: r.id, name: r.name }));
  } catch {
    // Databases may not be imported yet on first boot.
    return [];
  }
}

export async function GET(req: Request): Promise<Response> {
  try {
    await requireAdmin();
    await ensureWebDb();
    const realmId = realmIdFrom(new URL(req.url).searchParams.get("realmId"));
    return Response.json({
      realmId,
      realms: await realmChoices(),
      event: await getXpEvent(realmId),
      defaultAuraSpell: DEFAULT_AURA_SPELL,
    });
  } catch (err) {
    return errorResponse(err);
  }
}

export async function POST(req: Request): Promise<Response> {
  try {
    const session = await requireAdmin();
    await ensureWebDb();
    const body = await req.json().catch(() => ({}));
    const realmId = realmIdFrom(body.realmId);
    const current = await getXpEvent(realmId);

    // Fields left out keep their current value, except endsInHours: a
    // duration is always measured from this save, so omitting it means "run
    // until stopped" rather than "keep the old end time".
    const update = {
      name: typeof body.name === "string" ? body.name : current.name,
      enabled:
        typeof body.enabled === "boolean" ? body.enabled : current.enabled,
      multiplier:
        body.multiplier === undefined
          ? current.multiplier
          : Number(body.multiplier),
      auraSpell:
        body.auraSpell === undefined
          ? current.auraSpell
          : Number(body.auraSpell),
      endsInHours:
        body.endsInHours === undefined || body.endsInHours === null
          ? null
          : Number(body.endsInHours),
    };

    const issues = validateXpEvent(update);
    if (issues.length > 0) {
      return Response.json(
        { error: issues.map((i) => i.message).join(" "), issues },
        { status: 400 }
      );
    }

    return Response.json({
      ok: true,
      realmId,
      event: await saveXpEvent(update, session.username, realmId),
    });
  } catch (err) {
    return errorResponse(err);
  }
}
