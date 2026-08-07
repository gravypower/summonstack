// Runs a worldserver Lua script under a real Lua VM (fengari) with the Eluna
// API stubbed out, so the scripts can be exercised without a worldserver.
//
// The script is loaded as its own chunk, exactly as the engine loads it. Its
// top-level locals stay private; the handlers escape through the stubbed
// Register*/CreateLuaEvent globals, which is also how the engine gets them.
const fs = require("node:fs");
const path = require("node:path");
const { lua, lauxlib, lualib, to_luastring } = require("fengari");

const SCRIPT_DIR = path.join(__dirname, "..", "..", "..", "worldserver", "lua_scripts");
const PRELUDE = path.join(__dirname, "eluna-prelude.lua");

function scriptPath(name) {
  return path.join(SCRIPT_DIR, name);
}

function readScript(name) {
  return fs.readFileSync(scriptPath(name), "utf8");
}

/**
 * Load prelude + script + assertions into one Lua state.
 *
 * `assertions` is Lua source run after the script has registered its hooks; it
 * sets FAILURES, and any message it prints comes back in `output`.
 */
function runScript(name, assertions) {
  const L = lauxlib.luaL_newstate();
  lualib.luaL_openlibs(L);

  const output = [];
  // Capture print() so a failing assertion can be reported by node:test rather
  // than only appearing on stdout.
  lua.lua_pushjsfunction(L, (state) => {
    const parts = [];
    for (let i = 1; i <= lua.lua_gettop(state); i++) {
      parts.push(lua.lua_tojsstring(state, i));
    }
    output.push(parts.join("\t"));
    return 0;
  });
  lua.lua_setglobal(L, to_luastring("print"));

  const chunks = [
    ["prelude", fs.readFileSync(PRELUDE, "utf8")],
    [name, readScript(name)],
    ["assertions", assertions],
  ];
  for (const [label, source] of chunks) {
    if (lauxlib.luaL_dostring(L, to_luastring(source)) !== lua.LUA_OK) {
      throw new Error(`Lua chunk "${label}" failed: ${lua.lua_tojsstring(L, -1)}`);
    }
  }

  lua.lua_getglobal(L, to_luastring("FAILURES"));
  return { failures: lua.lua_tointeger(L, -1), output };
}

module.exports = { runScript, readScript, scriptPath, SCRIPT_DIR };
