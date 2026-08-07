const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

// The shop schema is written out twice: lib/db.ts creates it lazily on the
// first request, and scripts/seed-shop.mjs creates it so the catalog can be
// seeded before the portal has served anything. Two copies drift — these
// tests pin the parts that have to agree.
const DB_TS = fs.readFileSync(
  path.join(__dirname, "..", "src", "lib", "db.ts"),
  "utf8"
);
const SEED = fs.readFileSync(
  path.join(__dirname, "..", "scripts", "seed-shop.mjs"),
  "utf8"
);

/**
 * The column and key lines of one CREATE TABLE, normalised.
 *
 * Two differences are by design and normalised away rather than reported:
 *
 *  - db.ts templates the database name as __WEB_DB__ and substitutes it at
 *    runtime; the seed script interpolates ${WEB_DB} directly. Only
 *    shop_pack_items shows this, in its foreign key.
 *  - db.ts creates shop_ledger without the 'summon' reason and widens the enum
 *    in SUMMON_DDL, because that value arrived after the first installs. The
 *    seed script writes the final shape. They agree on the end state, which is
 *    what the last test in this file checks.
 */
function normalise(body) {
  return body
    .replace(/__WEB_DB__/g, "WEB_DB")
    .replace(/\$\{WEB_DB\}/g, "WEB_DB")
    .replace(
      /reason ENUM\('vote','donation','admin_grant','purchase','refund'\)/,
      "reason ENUM('vote','donation','admin_grant','purchase','refund','summon')"
    );
}

function tableBody(source, table) {
  const start = source.indexOf(`.${table} (`);
  if (start === -1) return null;
  const open = source.indexOf("(", start);
  let depth = 0;
  let end = open;
  for (let i = open; i < source.length; i++) {
    if (source[i] === "(") depth++;
    else if (source[i] === ")") {
      depth--;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  return normalise(
    source
      .slice(open + 1, end)
      .split("\n")
      .map((line) => line.trim().replace(/,$/, ""))
      .filter((line) => line && !line.startsWith("--"))
      .join("\n")
  );
}

// Tables both files create. The summon and xp_event tables are deliberately
// only in db.ts — the seed does not touch them — which is why this list is
// explicit rather than "every table in either file".
const SHARED_TABLES = [
  "shop_balances",
  "shop_ledger",
  "shop_products",
  "shop_transactions",
  "shop_packs",
  "shop_pack_items",
  "shop_xp_locks",
];

for (const table of SHARED_TABLES) {
  test(`${table} is defined identically in db.ts and seed-shop.mjs`, () => {
    const fromDb = tableBody(DB_TS, table);
    const fromSeed = tableBody(SEED, table);
    assert.ok(fromDb, `${table} missing from lib/db.ts`);
    assert.ok(fromSeed, `${table} missing from scripts/seed-shop.mjs`);
    assert.equal(
      fromSeed,
      fromDb,
      `${table} has drifted between the two schema copies`
    );
  });
}

// These live only in db.ts. If one ever gains a copy in the seed script, it
// belongs in SHARED_TABLES above so it is kept in step.
test("summon and xp_event tables are only in db.ts", () => {
  for (const table of [
    "summon_events",
    "summon_account_bonus",
    "summon_rewards",
    "xp_event",
    "invites",
  ]) {
    assert.ok(tableBody(DB_TS, table), `${table} should be in lib/db.ts`);
    assert.equal(
      tableBody(SEED, table),
      null,
      `${table} is now in seed-shop.mjs too — add it to SHARED_TABLES`
    );
  }
});

// realm_id reaches shop_transactions and summon_events through a migration
// rather than the CREATE, so an install seeded before the portal ever ran
// gets the column on the portal's first request. The migration is therefore
// not optional — assert it is still there.
test("the realm_id migrations still exist", () => {
  for (const table of ["shop_xp_locks", "shop_transactions", "summon_events"]) {
    assert.ok(
      DB_TS.includes(`.${table} ADD COLUMN realm_id`),
      `${table} should still be migrated to carry realm_id`
    );
  }
  // And through the helper that swallows only "column already exists" — a
  // bare catch here is what made a real failure look like a no-op.
  assert.ok(DB_TS.includes("addColumnIfMissing"));
  assert.match(DB_TS, /ER_DUP_FIELDNAME/);
});

test("the ledger reason enum agrees between both copies", () => {
  const reasons = (source) => {
    const match = /reason\s+ENUM\(([^)]*)\)/.exec(source);
    return match ? match[1].replace(/\s/g, "") : null;
  };
  // db.ts creates the enum without 'summon' and widens it in SUMMON_DDL; the
  // seed script writes the final shape directly. Compare against the widened
  // form, which is what both end up with.
  const widened = /MODIFY\s+reason\s+ENUM\(([^)]*)\)/.exec(DB_TS);
  assert.ok(widened, "db.ts should widen the ledger reason enum");
  assert.equal(reasons(SEED), widened[1].replace(/\s/g, ""));
});
