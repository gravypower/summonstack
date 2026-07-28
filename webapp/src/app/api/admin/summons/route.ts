import { errorResponse, requireAdmin } from "@/lib/auth";
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

export async function GET(): Promise<Response> {
  try {
    await requireAdmin();
    const paid = await awardPendingSummons();
    const [rewards, stats, recent, bonuses] = await Promise.all([
      getSummonRewards(),
      getSummonStats(10),
      listRecentSummons(50),
      listSummonBonuses(),
    ]);
    return Response.json({
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
    const current = await getSummonRewards();

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
      rewards: await saveSummonRewards(update, session.username),
    });
  } catch (err) {
    return errorResponse(err);
  }
}
