const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const luaparse = require("luaparse");

const { runScript, scriptPath, SCRIPT_DIR } = require("./helpers/lua.js");

const SCRIPTS = ["summons.lua", "xp.lua", "summon_stone.lua"];

// The worldserver's Lua engine is 5.1. A syntax error here is only discovered
// when a realm starts, so parse them all on every run.
test("every worldserver script parses as Lua 5.1", () => {
  for (const name of SCRIPTS) {
    const source = fs.readFileSync(scriptPath(name), "utf8");
    assert.doesNotThrow(
      () => luaparse.parse(source, { luaVersion: "5.1" }),
      `${name} should parse`
    );
  }
});

// Every realm runs the same files from one shared mount, so a settings query
// keyed to a literal id makes every realm mirror realm 1.
test("no script reads a settings row by a hardcoded id", () => {
  for (const name of SCRIPTS) {
    const source = fs.readFileSync(scriptPath(name), "utf8");
    for (const table of ["summon_rewards", "xp_event"]) {
      const lines = source
        .split("\n")
        .filter((l) => l.includes(table) && /id = 1\b/.test(l));
      assert.deepEqual(
        lines,
        [],
        `${name} reads ${table} by a literal id: ${lines.join(" / ")}`
      );
    }
  }
});

test("every script derives its realm from the engine", () => {
  for (const name of SCRIPTS) {
    const source = fs.readFileSync(scriptPath(name), "utf8");
    assert.match(source, /GetRealmID/, `${name} should read its own realm id`);
  }
});

// ── summon_stone.lua behaviour ─────────────────────────────────────────────
//
// Driven through the script's own registered hooks. The prelude makes this a
// realm 2 worldserver where realm 1 pays 5 and realm 2 pays 11, so reading the
// wrong settings row shows up in the points quoted to the summoner.

const STONE_ASSERTIONS = fs.readFileSync(
  require("node:path").join(__dirname, "helpers", "summon-stone-cases.lua"),
  "utf8"
);

test("summon_stone.lua: ownership, bots and realm settings", () => {
  const { failures, output } = runScript("summon_stone.lua", STONE_ASSERTIONS);
  const failed = output.filter((line) => line.startsWith("FAIL"));
  assert.deepEqual(failed, [], `\n${output.join("\n")}`);
  assert.equal(failures, 0);
});

test("the shared lua_scripts directory holds only the expected scripts", () => {
  // A stray file in this directory is loaded by every realm's engine on start.
  const found = fs.readdirSync(SCRIPT_DIR).filter((f) => f.endsWith(".lua"));
  assert.deepEqual(found.sort(), [...SCRIPTS].sort());
});
