const test = require("node:test");
const assert = require("node:assert/strict");

const db = require("../.test-build/db.js");
const realm = require("../.test-build/realm.js");
const soap = require("../.test-build/soap.js");
const { makePool, contains, affected } = require("./helpers/stub-db.js");

const REALMS = {
  1: { id: 1, name: "SummonCore", charsDb: "acore_characters_1" },
  2: { id: 2, name: "Playerbots Realm 2", charsDb: "acore_characters_pb_2" },
};

// Guid 5 exists on both realms as different characters. Addressing the wrong
// realm hits "Wrongguy" — which is what used to happen, because the delivery
// command carried no realm and always went to realm 1.
const NAMES = {
  acore_characters_1: { 5: "Wrongguy" },
  acore_characters_pb_2: { 5: "Rightguy" },
};

/** Sets up stubs for one delivery and returns what it did. */
async function deliverWith(snapshot, { realmId = 2, soapResult } = {}) {
  const soapCalls = [];
  const txn = {
    id: 1,
    account_id: 100,
    character_guid: 5,
    realm_id: realmId,
    price_paid: 500,
    status: "pending",
    payload_snapshot: JSON.stringify(snapshot),
  };

  const pool = makePool([
    [contains("shop_transactions", "SET status = 'delivering'"), () => affected(1)],
    [contains("SELECT * FROM", "shop_transactions"), () => [[txn]]],
    [
      contains("SELECT name FROM"),
      (flat, params) => {
        const dbName = /`([a-z0-9_]+)`\.characters/.exec(flat)[1];
        const name = (NAMES[dbName] ?? {})[params[0]];
        return [name ? [{ name }] : []];
      },
    ],
    [contains("SELECT online FROM"), () => [[{ online: 0 }]]],
    [contains("SELECT skill FROM"), () => [[{ skill: 164 }]]],
    [contains("character_skills", "UPDATE"), () => affected(1)],
    [contains("shop_transactions", "SET status = ?"), () => affected(1)],
    [contains("SET status = 'refunded'"), () => affected(1)],
    [contains("shop_balances"), () => affected(1)],
    [contains("shop_ledger"), () => affected(1)],
  ]);

  db.getPool = () => pool;
  db.ensureWebDb = async () => {};
  realm.getRealmConfigById = async (id) => REALMS[id] ?? null;
  realm.listRealmsWithConfig = async () => Object.values(REALMS);
  soap.soapCommand = async (command, id) => {
    soapCalls.push({ command, realmId: id });
    return soapResult ?? { success: true, output: "done" };
  };

  const shop = require("../.test-build/shop.js");
  await shop.deliver(1);
  return { soapCalls, statements: pool.log };
}

test("a level boost is run on the realm it was bought on", async () => {
  const { soapCalls } = await deliverWith({ type: "level_boost", level: 80 });
  assert.equal(soapCalls.length, 1);
  assert.equal(soapCalls[0].realmId, 2, "must not fall back to the default worldserver");
  assert.equal(soapCalls[0].command, ".character level Rightguy 80");
});

test("...and never touches the same-guid character on another realm", async () => {
  const { soapCalls, statements } = await deliverWith({
    type: "level_boost",
    level: 80,
  });
  assert.ok(!soapCalls.some((c) => c.command.includes("Wrongguy")));
  assert.ok(
    statements.some((s) => s.sql.includes("`acore_characters_pb_2`.characters")),
    "the name should be read from realm 2's database"
  );
  assert.ok(!statements.some((s) => s.sql.includes("`acore_characters`.")));
});

test("every mail of an item pack goes to the same realm", async () => {
  const { soapCalls } = await deliverWith({
    type: "item_pack",
    pack: "wotlk",
    spec: null,
    mails: [[{ itemId: 49623, count: 1 }], [{ itemId: 40592, count: 2 }]],
  });
  assert.equal(soapCalls.length, 2);
  assert.ok(soapCalls.every((c) => c.realmId === 2));
  assert.ok(soapCalls.every((c) => c.command.includes("Rightguy")));
});

test("a profession boost writes to the buyer's realm database", async () => {
  const { statements } = await deliverWith({
    type: "profession_boost",
    skillCap: 450,
  });
  const write = statements.find(
    (s) => s.sql.includes("character_skills") && s.sql.startsWith("UPDATE")
  );
  assert.ok(write, "expected a character_skills update");
  assert.ok(
    write.sql.includes("`acore_characters_pb_2`.character_skills"),
    `wrote to the wrong database: ${write.sql}`
  );
});

test("...and checks the character is offline on that realm, before and after", async () => {
  const { statements } = await deliverWith({
    type: "profession_boost",
    skillCap: 450,
  });
  const checks = statements.filter(
    (s) => s.sql.includes("SELECT online FROM `acore_characters_pb_2`")
  );
  assert.equal(checks.length, 2);
});

// A realm removed from the manifest between purchase and delivery must not
// fall back to some other realm's database or worldserver.
test("an unknown realm runs nothing and refunds", async () => {
  const { soapCalls, statements } = await deliverWith(
    { type: "level_boost", level: 80 },
    { realmId: 99 }
  );
  assert.equal(soapCalls.length, 0);
  assert.ok(!statements.some((s) => s.sql.includes("SELECT name FROM")));
  assert.ok(
    statements.some((s) => s.sql.includes("SET status = 'refunded'")),
    "a clean fault should refund"
  );
});

// 'unreachable' means the command may well have executed, so refunding would
// hand back points for something the player might have received.
test("an unreachable worldserver parks the order instead of refunding", async () => {
  const { statements } = await deliverWith(
    { type: "level_boost", level: 80 },
    { soapResult: { success: false, unreachable: true, output: "timeout" } }
  );
  assert.ok(!statements.some((s) => s.sql.includes("SET status = 'refunded'")));
  const parked = statements.find((s) => s.sql.includes("shop_transactions SET status = ?"));
  assert.ok(parked);
  assert.equal(parked.params[0], "delivering");
});

test("a rejected command refunds, because nothing was granted", async () => {
  const { statements } = await deliverWith(
    { type: "level_boost", level: 80 },
    { soapResult: { success: false, output: "no such player" } }
  );
  assert.ok(statements.some((s) => s.sql.includes("SET status = 'refunded'")));
});

// purchase() awaits deliver(), so a throw here surfaced as a 500 on a purchase
// whose money had already moved, leaving the row stuck in 'delivering'.
test("a refund that itself fails parks the order rather than escaping", async () => {
  const soapCalls = [];
  const txn = {
    id: 1,
    account_id: 100,
    character_guid: 5,
    realm_id: 2,
    price_paid: 500,
    status: "pending",
    payload_snapshot: JSON.stringify({ type: "level_boost", level: 80 }),
  };
  const pool = makePool([
    [contains("shop_transactions", "SET status = 'delivering'"), () => affected(1)],
    [contains("SELECT * FROM", "shop_transactions"), () => [[txn]]],
    [contains("SELECT name FROM"), () => [[{ name: "Rightguy" }]]],
    [contains("shop_transactions", "SET status = ?"), () => affected(1)],
  ]);
  // The refund runs on a connection; make that connection fail.
  pool.getConnection = async () => {
    throw new Error("pool exhausted");
  };

  db.getPool = () => pool;
  realm.getRealmConfigById = async (id) => REALMS[id] ?? null;
  soap.soapCommand = async (command, id) => {
    soapCalls.push({ command, realmId: id });
    return { success: false, output: "no such player" };
  };

  const shop = require("../.test-build/shop.js");
  await assert.doesNotReject(() => shop.deliver(1));

  const parked = pool.log.find((s) => s.sql.includes("shop_transactions SET status = ?"));
  assert.ok(parked, "the order should be parked for admin review");
  assert.equal(parked.params[0], "failed");
  assert.match(parked.params[1], /refund failed/);
});
