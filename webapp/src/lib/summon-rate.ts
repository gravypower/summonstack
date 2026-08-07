// Presentation helpers for per-realm summon rates.
//
// Kept apart from lib/summons.ts on purpose: this module is imported by client
// components, and lib/summons.ts pulls in mysql2. Nothing here touches a
// database — it only shapes what the portal says about what a summon pays.

export interface RealmRate {
  realmId: number;
  realmName: string;
  enabled: boolean;
  pointsPerSummon: number;
  dailyPointCap: number;
  pairCooldownMinutes: number;
}

/** Realms that pay the same rate, quoted once. */
export interface RateGroup {
  pointsPerSummon: number;
  dailyPointCap: number;
  realmNames: string[];
}

/**
 * The realms currently paying for summons, collapsed so realms paying the same
 * are quoted together. Empty means nothing pays anywhere, which is the signal
 * to say nothing at all rather than to quote zero.
 */
export function groupPayingRates(rates: RealmRate[]): RateGroup[] {
  const groups = new Map<string, RateGroup>();
  for (const rate of rates) {
    if (!rate.enabled || rate.pointsPerSummon <= 0) continue;
    const key = `${rate.pointsPerSummon}:${rate.dailyPointCap}`;
    const group = groups.get(key) ?? {
      pointsPerSummon: rate.pointsPerSummon,
      dailyPointCap: rate.dailyPointCap,
      realmNames: [],
    };
    group.realmNames.push(rate.realmName);
    groups.set(key, group);
  }
  return [...groups.values()];
}

/**
 * True when one rate covers every realm, so it can be stated plainly instead
 * of being attributed to particular realms. A single group that leaves some
 * realms out still needs naming — otherwise players on a realm that pays
 * nothing are quoted a rate they will never earn.
 */
export function isUniformRate(
  groups: RateGroup[],
  totalRealms: number
): boolean {
  return groups.length === 1 && groups[0].realmNames.length === totalRealms;
}

/** "5 shop points (up to 100 a day)" */
export function describeRate(group: RateGroup): string {
  const cap = group.dailyPointCap > 0 ? ` (up to ${group.dailyPointCap} a day)` : "";
  return `${group.pointsPerSummon} shop points${cap}`;
}

/** "SummonCore", "SummonCore and Playerbots", "A, B and C" */
export function joinNames(names: string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}
