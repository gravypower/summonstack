const test = require("node:test");
const assert = require("node:assert/strict");

const db = require("../.test-build/db.js");
const realm = require("../.test-build/realm.js");
const { makePool, contains, affected } = require("./helpers/stub-db.js");

const REALMS = [
  { id: 1, name: "SummonCore", charsDb: "acore_characters_1" },
  { id: 2, name: "Playerbots Realm 2", charsDb: "acore_characters_pb_2" },
];

function rewardRow(points, overrides = {}) {
  return {
    enabled: 1,
    points_per_summon: points,
    daily_point_cap: 0,
    pair_cooldown_minutes: 0,
    announce_every: 0,
    updated_by: null,
    updated_at: null,
    seen_at: null,
    seen_recently: 1,
    ...overrides,
  };
}

function pending(id, realmId, summonerAccount, targetAccount) {
  return {
    id,
    realm_id: realmId,
    summoner_name: `S${id}`,
    summoner_account: summonerAccount,
    target_name: `T${id}`,
    target_account: targetAccount,
    created_at: new Date(),
  };
}

/** Runs one sweep and reports what it did. */
async function sweep(pendingRows, rewardsByRealm) {
  const awarded = [];
  const credited = [];
  const skipped = [];
  const rewardReads = [];

  const pool = makePool([
    [
      contains("summon_rewards WHERE id = ?"),
      (flat, params) => {
        rewardReads.push(params[1]);
        const row = rewardsByRealm[params[1]];
        return [row ? [row] : []];
      },
    ],
    [(flat) => flat.startsWith("SELECT") && flat.includes("award_state = 'pending'"),
      () => [pendingRows.map((r) => ({ ...r }))]],
    [contains("summon_account_bonus"), () => [[]]],
    [
      contains("SET award_state = 'awarded'"),
      (flat, params) => {
        awarded.push({ id: params[2], points: params[0] });
        return affected(1);
      },
    ],
    [
      contains("SET award_state = 'skipped'"),
      (flat, params) => {
        skipped.push({ id: params[1], reason: params[0] });
        return affected(1);
      },
    ],
    [
      contains("shop_balances"),
      (flat, params) => {
        credited.push({ accountId: params[0], points: params[1] });
        return affected(1);
      },
    ],
    [contains("shop_ledger"), () => affected(1)],
  ]);

  db.getPool = () => pool;
  db.ensureWebDb = async () => {};
  realm.listRealmsWithConfig = async () => REALMS;

  const summons = require("../.test-build/summons.js");
  const paid = await summons.awardPendingSummons();
  return { paid, awarded, credited, skipped, rewardReads };
}

test("each summon is priced by its own realm", async () => {
  const { awarded } = await sweep(
    [pending(10, 1, 100, 200), pending(11, 2, 101, 201)],
    { 1: rewardRow(5), 2: rewardRow(1) }
  );
  assert.equal(awarded.find((a) => a.id === 10).points, 5);
  assert.equal(awarded.find((a) => a.id === 11).points, 1);
});

test("...so one realm's settings cannot price the whole backlog", async () => {
  const { credited } = await sweep(
    [pending(10, 1, 100, 200), pending(11, 2, 101, 201)],
    { 1: rewardRow(5), 2: rewardRow(1) }
  );
  assert.ok(credited.some((c) => c.accountId === 100 && c.points === 5));
  assert.ok(credited.some((c) => c.accountId === 101 && c.points === 1));
});

test("each realm's settings are read once, not once per row", async () => {
  const { rewardReads } = await sweep(
    [pending(10, 1, 100, 200), pending(11, 1, 102, 202), pending(12, 2, 101, 201)],
    { 1: rewardRow(5), 2: rewardRow(1) }
  );
  assert.equal(rewardReads.filter((r) => r === 1).length, 1);
  assert.equal(rewardReads.filter((r) => r === 2).length, 1);
});

// A realm with no settings row uses the built-in defaults (which do pay, at 5)
// rather than inheriting whatever realm 1 happens to be set to.
test("a realm with no settings row falls back to defaults, not to realm 1", async () => {
  const { awarded, rewardReads } = await sweep([pending(12, 3, 102, 202)], {
    1: rewardRow(99),
  });
  assert.ok(rewardReads.includes(3));
  assert.equal(awarded.find((a) => a.id === 12).points, 5);
});

test("summoning your own alt pays nothing", async () => {
  const { skipped, awarded } = await sweep([pending(10, 1, 100, 100)], {
    1: rewardRow(5),
  });
  assert.equal(awarded.length, 0);
  assert.equal(skipped[0].reason, "same_account");
});

test("rewards switched off on a realm skip that realm's rows", async () => {
  const { skipped, awarded } = await sweep(
    [pending(10, 1, 100, 200), pending(11, 2, 101, 201)],
    { 1: rewardRow(0, { enabled: 0 }), 2: rewardRow(3) }
  );
  assert.equal(skipped.find((s) => s.id === 10).reason, "rewards_off");
  assert.equal(awarded.find((a) => a.id === 11).points, 3);
});

test("an empty backlog costs one query and pays nothing", async () => {
  const { paid, awarded } = await sweep([], { 1: rewardRow(5) });
  assert.equal(paid, 0);
  assert.equal(awarded.length, 0);
});

// ── Cross-realm reads ──────────────────────────────────────────────────────

test("the leaderboard keeps two realms' identical guids apart", async () => {
  const pool = makePool([
    [contains("COUNT(*) AS total"), () => [[{ total: 10, last24h: 4, points_awarded: 50, pending: 0 }]]],
    [
      contains("GROUP BY e.realm_id, e.summoner_guid"),
      () => [[
        { realm_id: 1, guid: 5, name: "Oldname", summons: 7, points: 35 },
        { realm_id: 2, guid: 5, name: "Otherrealm", summons: 3, points: 15 },
      ]],
    ],
    [
      contains("WHERE guid IN"),
      (flat) =>
        flat.includes("acore_characters_1")
          ? [[{ guid: 5, name: "Renamedone" }]]
          : [[{ guid: 5, name: "Otherrealm" }]],
    ],
  ]);
  db.getPool = () => pool;
  db.ensureWebDb = async () => {};
  realm.listRealmsWithConfig = async () => REALMS;

  const summons = require("../.test-build/summons.js");
  const stats = await summons.getSummonStats(10);

  assert.equal(stats.top.length, 2);
  const r1 = stats.top.find((l) => l.realmId === 1);
  const r2 = stats.top.find((l) => l.realmId === 2);
  assert.equal(r1.name, "Renamedone", "should show the current name from its own realm");
  assert.equal(r1.summons, 7);
  assert.equal(r2.name, "Otherrealm");
  assert.equal(r2.summons, 3);
});

// Bounty character names used to come from one hardcoded database that named
// no realm, so the list was always empty — and the UI hides a bounty with no
// characters, making bounties invisible to players.
test("bounty character names are gathered from every realm", async () => {
  const pool = makePool([
    [
      contains("summon_account_bonus b"),
      () => [[
        {
          account_id: 100,
          multiplier_pct: 200,
          note: null,
          created_by: "admin",
          created_at: new Date(),
          username: "PLAYER",
        },
      ]],
    ],
    [
      contains("WHERE account IN"),
      (flat) =>
        flat.includes("acore_characters_1")
          ? [[{ account: 100, name: "Mainchar" }]]
          : [[{ account: 100, name: "Botrealmchar" }, { account: 999, name: "Someoneelse" }]],
    ],
  ]);
  db.getPool = () => pool;
  db.ensureWebDb = async () => {};
  realm.listRealmsWithConfig = async () => REALMS;

  const summons = require("../.test-build/summons.js");
  const bonuses = await summons.listSummonBonuses();

  assert.equal(bonuses.length, 1);
  assert.deepEqual(bonuses[0].characters.sort(), ["Botrealmchar", "Mainchar"]);
  assert.ok(bonuses[0].characters.length > 0, "an empty list hides the bounty in the UI");
});

test("a realm whose database is missing does not fail the whole read", async () => {
  const pool = makePool([
    [
      contains("summon_account_bonus b"),
      () => [[
        { account_id: 100, multiplier_pct: 200, note: null, created_by: "a", created_at: new Date(), username: "P" },
      ]],
    ],
    [
      contains("WHERE account IN"),
      (flat) => {
        if (flat.includes("acore_characters_pb_2")) {
          throw Object.assign(new Error("Unknown database"), { code: "ER_BAD_DB_ERROR" });
        }
        return [[{ account: 100, name: "Mainchar" }]];
      },
    ],
  ]);
  db.getPool = () => pool;
  db.ensureWebDb = async () => {};
  realm.listRealmsWithConfig = async () => REALMS;

  const summons = require("../.test-build/summons.js");
  const bonuses = await summons.listSummonBonuses();
  assert.deepEqual(bonuses[0].characters, ["Mainchar"]);
});
