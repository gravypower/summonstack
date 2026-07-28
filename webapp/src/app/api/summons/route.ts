import { errorResponse } from "@/lib/auth";
import {
  awardPendingSummons,
  getSummonRewards,
  getSummonStats,
  listSummonBonuses,
} from "@/lib/summons";

export const dynamic = "force-dynamic";

/** Public: the realm summon counter, the leaderboard, and what a summon pays. */
export async function GET(): Promise<Response> {
  try {
    // No scheduler in this stack, so page loads are what settle the backlog.
    await awardPendingSummons();
    const [stats, rewards, bonuses] = await Promise.all([
      getSummonStats(10),
      getSummonRewards(),
      listSummonBonuses(),
    ]);
    return Response.json({
      total: stats.total,
      last24h: stats.last24h,
      pointsAwarded: stats.pointsAwarded,
      top: stats.top,
      rewards: {
        enabled: rewards.enabled,
        pointsPerSummon: rewards.pointsPerSummon,
        dailyPointCap: rewards.dailyPointCap,
        pairCooldownMinutes: rewards.pairCooldownMinutes,
      },
      // Who is currently worth more (or less) to summon. Character names only:
      // players need to know who to look for, not whose account it is.
      bounties: bonuses
        .filter((b) => b.multiplierPct !== 100 && b.characters.length > 0)
        .map((b) => ({
          multiplierPct: b.multiplierPct,
          characters: b.characters,
        })),
    });
  } catch (err) {
    return errorResponse(err);
  }
}
