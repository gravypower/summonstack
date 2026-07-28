import { errorResponse, requireSession } from "@/lib/auth";
import { getBalance, listCharacters, listXpLocks } from "@/lib/shop";
import {
  awardPendingSummons,
  getAccountSummonSummary,
  getSummonRewards,
  listSummonBonuses,
} from "@/lib/summons";

export async function GET(): Promise<Response> {
  try {
    const session = await requireSession();
    // Summon points are credited by a sweep rather than by the game server, so
    // settle the backlog before reading the balance the player is about to see.
    await awardPendingSummons();
    const [balance, characters, xpLocks, summons, rewards, bonuses] =
      await Promise.all([
        getBalance(session.accountId),
        listCharacters(session.accountId),
        listXpLocks(session.accountId),
        getAccountSummonSummary(session.accountId),
        getSummonRewards(),
        listSummonBonuses(),
      ]);
    return Response.json({
      balance,
      summons: {
        count: summons.summons,
        pointsEarned: summons.points,
        enabled: rewards.enabled,
        pointsPerSummon: rewards.pointsPerSummon,
        dailyPointCap: rewards.dailyPointCap,
        pairCooldownMinutes: rewards.pairCooldownMinutes,
        // Who is worth extra to summon. Character names only — players need to
        // know who to look for, not whose account it is.
        bounties: bonuses
          .filter((b) => b.multiplierPct > 100 && b.characters.length > 0)
          .map((b) => ({
            multiplierPct: b.multiplierPct,
            characters: b.characters,
          })),
      },
      characters: characters.map((c) => ({
        guid: c.guid,
        name: c.name,
        race: c.race,
        class: c.class,
        level: c.level,
        // The shop UI uses this to warn profession-boost buyers to log out.
        online: c.online !== 0,
        // Level this character's XP is held at, or null if it still levels.
        xpLockedAt: xpLocks[c.guid] ?? null,
      })),
    });
  } catch (err) {
    return errorResponse(err);
  }
}
