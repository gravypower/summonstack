import { errorResponse, requireAdmin } from "@/lib/auth";
import { listRealmsWithConfig } from "@/lib/realm";
import {
  awardPendingSummons,
  DEFAULT_BONUS_PCT,
  getSummonRewards,
  getSummonStats,
  listRecentSummons,
  listSummonBonuses,
  saveSummonRewards,
  validateSummonRewards,
} from "@/lib/summons";

/**
 * Which realm's settings this request is about. Summon rewards are per realm —
 * one row each — so every read and write has to name one. Defaults to realm 1,
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
    const realmId = realmIdFrom(new URL(req.url).searchParams.get("realmId"));
    const paid = await awardPendingSummons();
    const [rewards, realms, stats, recent, bonuses] = await Promise.all([
      getSummonRewards(realmId),
      realmChoices(),
      getSummonStats(10),
      listRecentSummons(50),
      listSummonBonuses(),
    ]);
    return Response.json({
      realmId,
      realms,
      rewards,
      stats,
      recent,
      bonuses,
      defaultBonusPct: DEFAULT_BONUS_PCT,
      justAwarded: paid,
    });
  } catch (err) {
    return errorResponse(err);
  }
}

export async function POST(req: Request): Promise<Response> {
  try {
    const session = await requireAdmin();
    const body = await req.json().catch(() => ({}));
    const realmId = realmIdFrom(body.realmId);
    const current = await getSummonRewards(realmId);

    // Fields left out keep their current value.
    const update = {
      enabled:
        typeof body.enabled === "boolean" ? body.enabled : current.enabled,
      pointsPerSummon:
        body.pointsPerSummon === undefined
          ? current.pointsPerSummon
          : Number(body.pointsPerSummon),
      dailyPointCap:
        body.dailyPointCap === undefined
          ? current.dailyPointCap
          : Number(body.dailyPointCap),
      pairCooldownMinutes:
        body.pairCooldownMinutes === undefined
          ? current.pairCooldownMinutes
          : Number(body.pairCooldownMinutes),
      announceEvery:
        body.announceEvery === undefined
          ? current.announceEvery
          : Number(body.announceEvery),
    };

    const issues = validateSummonRewards(update);
    if (issues.length > 0) {
      return Response.json(
        { error: issues.map((i) => i.message).join(" "), issues },
        { status: 400 }
      );
    }

    return Response.json({
      ok: true,
      realmId,
      rewards: await saveSummonRewards(update, session.username, realmId),
    });
  } catch (err) {
    return errorResponse(err);
  }
}
