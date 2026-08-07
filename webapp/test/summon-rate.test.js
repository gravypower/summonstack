const test = require("node:test");
const assert = require("node:assert/strict");

const {
  groupPayingRates,
  isUniformRate,
  describeRate,
  joinNames,
} = require("../.test-build/summon-rate.js");

function rate(realmId, realmName, overrides = {}) {
  return {
    realmId,
    realmName,
    enabled: true,
    pointsPerSummon: 5,
    dailyPointCap: 100,
    pairCooldownMinutes: 30,
    ...overrides,
  };
}

test("realms paying the same rate are quoted once", () => {
  const groups = groupPayingRates([rate(1, "One"), rate(2, "Two")]);
  assert.equal(groups.length, 1);
  assert.deepEqual(groups[0].realmNames, ["One", "Two"]);
  assert.ok(isUniformRate(groups, 2));
});

test("realms paying differently are kept apart", () => {
  const groups = groupPayingRates([
    rate(1, "One"),
    rate(2, "Two", { pointsPerSummon: 1 }),
  ]);
  assert.equal(groups.length, 2);
  assert.ok(!isUniformRate(groups, 2));
});

test("a realm paying nothing is left out entirely", () => {
  const groups = groupPayingRates([
    rate(1, "One"),
    rate(2, "Two", { enabled: false }),
    rate(3, "Three", { pointsPerSummon: 0 }),
  ]);
  assert.equal(groups.length, 1);
  assert.deepEqual(groups[0].realmNames, ["One"]);
});

// The reason isUniformRate takes a total: one group that does not cover every
// realm still has to be attributed, or players on a realm that pays nothing
// are quoted a rate they can never earn.
test("one rate covering only some realms is not uniform", () => {
  const groups = groupPayingRates([
    rate(1, "One"),
    rate(2, "Two", { enabled: false }),
  ]);
  assert.equal(groups.length, 1);
  assert.ok(!isUniformRate(groups, 2), "must still name the realm it applies to");
});

test("nothing paying anywhere yields no groups, so the UI says nothing", () => {
  const groups = groupPayingRates([
    rate(1, "One", { enabled: false }),
    rate(2, "Two", { pointsPerSummon: 0 }),
  ]);
  assert.equal(groups.length, 0);
  assert.ok(!isUniformRate(groups, 2));
});

test("an empty realm list is handled", () => {
  assert.deepEqual(groupPayingRates([]), []);
  assert.ok(!isUniformRate([], 0));
});

test("describeRate mentions the cap only when there is one", () => {
  assert.equal(
    describeRate({ pointsPerSummon: 5, dailyPointCap: 100, realmNames: [] }),
    "5 shop points (up to 100 a day)"
  );
  assert.equal(
    describeRate({ pointsPerSummon: 5, dailyPointCap: 0, realmNames: [] }),
    "5 shop points"
  );
});

test("joinNames reads as a sentence", () => {
  assert.equal(joinNames([]), "");
  assert.equal(joinNames(["One"]), "One");
  assert.equal(joinNames(["One", "Two"]), "One and Two");
  assert.equal(joinNames(["One", "Two", "Three"]), "One, Two and Three");
});
