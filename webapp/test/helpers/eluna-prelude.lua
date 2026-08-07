-- Stubbed Eluna surface. Loaded as its own chunk before summon_stone.lua, so
-- the script under test is loaded exactly as the engine loads it.
FAILURES = 0
function check(label, cond)
  print((cond and "ok   " or "FAIL ") .. label)
  if not cond then FAILURES = FAILURES + 1 end
end

GAME_TIME = 1000
-- This worldserver is realm 2, so the script must read realm 2's rows.
REALM_UNDER_TEST = 2
function GetRealmID() return REALM_UNDER_TEST end
WORLD_QUERIES = {}
CHAR_WRITES = {}
BOT_ACCOUNTS = { [999] = true }
WORLD_PLAYERS = {}
HANDLERS = {}
TIMERS = {}

function GetGameTime() return GAME_TIME end
function SendWorldMessage() end
function WorldDBExecute() end
function CharDBExecute(sql) table.insert(CHAR_WRITES, sql) end
function GetPlayersInWorld() return WORLD_PLAYERS end
function RegisterItemEvent(_, ev, fn) HANDLERS["item" .. ev] = fn end
function RegisterCreatureGossipEvent(entry, ev, fn)
  HANDLERS["gossip" .. entry .. "_" .. ev] = fn
end
function CreateLuaEvent(fn) table.insert(TIMERS, fn) end

local function fakeQuery(rows)
  local i = 1
  return {
    GetUInt32 = function(_, col) return rows[i] and rows[i][col + 1] or 0 end,
    GetString = function(_, col) return rows[i] and rows[i][col + 1] or nil end,
    NextRow = function() i = i + 1; return rows[i] ~= nil end,
  }
end

function WorldDBQuery(sql)
  table.insert(WORLD_QUERIES, sql)
  if sql:find("information_schema") then return fakeQuery({ { 1 } }) end
  -- Realm 1 pays 5, realm 2 pays 11. Reading the wrong row is visible in the
  -- points quoted to the summoner.
  if sql:find("summon_rewards") then
    if sql:find("id = 2") then return fakeQuery({ { 1, 11, 0 } }) end
    return fakeQuery({ { 1, 5, 0 } })
  end
  if sql:find("summon_account_bonus") then return nil end
  if sql:find("COUNT") then return fakeQuery({ { 0 } }) end
  return nil
end

function AuthDBQuery(sql)
  local id = tonumber(sql:match("id = (%d+)"))
  return fakeQuery({ { BOT_ACCOUNTS[id] and ("rndbot" .. id) or ("player" .. id) } })
end

function newPlayer(guid, name, account)
  local p
  p = {
    messages = {},
    near = false,
    GetGUIDLow = function() return guid end,
    GetName = function() return name end,
    GetAccountId = function() return account end,
    GetX = function() return 0 end,
    GetY = function() return 0 end,
    GetZ = function() return 0 end,
    GetO = function() return 0 end,
    GetMapId = function() return 1 end,
    GetInstanceId = function() return 0 end,
    GetZoneId = function() return 12 end,
    GetLevel = function() return 80 end,
    -- Far away until the summon lands, then within the arrival radius.
    GetDistance = function() return p.near and 1 or 500 end,
    SendBroadcastMessage = function(_, m) table.insert(p.messages, m) end,
    RemoveItem = function() end,
    SummonGameObject = function() end,
    SpawnCreature = function(_, entry)
      return { GetGUIDLow = function() return 5000 + entry end }
    end,
    SummonPlayer = function() end,
    GossipClearMenu = function() end,
    GossipMenuAddItem = function() end,
    GossipSendMenu = function() end,
    GossipComplete = function() end,
  }
  return p
end

function lastMessage(p)
  return p.messages[#p.messages] or ""
end
