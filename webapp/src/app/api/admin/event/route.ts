import { errorResponse, requireAdmin } from "@/lib/auth";
import { ensureWebDb } from "@/lib/db";
import {
  DEFAULT_AURA_SPELL,
  getXpEvent,
  saveXpEvent,
  validateXpEvent,
} from "@/lib/xp-event";

export async function GET(): Promise<Response> {
  try {
    await requireAdmin();
    await ensureWebDb();
    return Response.json({
      event: await getXpEvent(),
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
    const current = await getXpEvent();

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
      event: await saveXpEvent(update, session.username),
    });
  } catch (err) {
    return errorResponse(err);
  }
}
