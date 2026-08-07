-- Assertions, run after summon_stone.lua has registered its hooks.
local NPC_WARLOCK = 90101
local onUse = HANDLERS["item2"]
local onHello = HANDLERS["gossip" .. NPC_WARLOCK .. "_1"]
local onSelect = HANDLERS["gossip" .. NPC_WARLOCK .. "_2"]
-- refresh, checkArrivals, pruneSpawns — in registration order.
local checkArrivals = TIMERS[2]
local pruneSpawns = TIMERS[3]

check("registered the item-use hook", onUse ~= nil)
check("registered both gossip hooks", onHello ~= nil and onSelect ~= nil)
check("registered the spawn-claim prune timer", pruneSpawns ~= nil)

local owner = newPlayer(1, "Owner", 100)
local stranger = newPlayer(2, "Stranger", 101)
local victim = newPlayer(3, "Victim", 102)
WORLD_PLAYERS = { owner, stranger, victim }

-- ── The item consumes itself and suppresses its own spell ─────────────────
check("item use returns false to suppress the item's own spell",
  onUse(2, owner, nil, nil) == false)

local warlock = { GetGUIDLow = function() return 5000 + NPC_WARLOCK end }

-- ── Ownership ─────────────────────────────────────────────────────────────
onHello(1, stranger, warlock)
check("a stranger opening the menu is refused",
  lastMessage(stranger):find("called by someone else") ~= nil)

CHAR_WRITES = {}
onSelect(2, stranger, warlock, 0, 1, "Victim")
check("a stranger cannot summon through someone else's warlock",
  lastMessage(stranger):find("called by someone else") ~= nil)
check("...they are never told a summon is under way",
  lastMessage(stranger):find("Summoning Victim") == nil)
-- The real proof: nothing was parked for arrival, so even if the victim walks
-- into range no summon is ever recorded and no points are earned.
victim.near = true
GAME_TIME = GAME_TIME + 6
checkArrivals()
check("...and no summon is recorded even if the target arrives",
  #CHAR_WRITES == 0)
victim.near = false

owner.messages = {}
onHello(1, owner, warlock)
check("the owner opening the menu is not refused", #owner.messages == 0)

onSelect(2, owner, warlock, 0, 1, "Victim")
check("the owner's own summon is accepted",
  lastMessage(owner):find("Summoning Victim") ~= nil)

-- ── A real player's arrival is recorded and paid ──────────────────────────
CHAR_WRITES = {}
victim.near = true
GAME_TIME = GAME_TIME + 6
checkArrivals()
check("the arrival wrote one summon_events row", #CHAR_WRITES == 1)
check("...marked pending, so the portal pays it",
  CHAR_WRITES[1]:find("'pending'") ~= nil)
check("...with no skip reason", CHAR_WRITES[1]:find("NULL") ~= nil)
check("the summoner is told they earned points",
  lastMessage(owner):find("shop points") ~= nil)
-- Realm 2's row says 11 points; realm 1's says 5. Quoting 5 here would mean
-- the script had read realm 1's settings on a realm 2 worldserver.
check("...at THIS realm's rate, not realm 1's",
  lastMessage(owner):find("11 shop points") ~= nil)
local askedForOwnRealm = false
for _, q in ipairs(WORLD_QUERIES) do
  if q:find("summon_rewards") and q:find("id = 2") then askedForOwnRealm = true end
end
check("the settings query named this realm", askedForOwnRealm)

-- ── A random bot's arrival is recorded but never paid ─────────────────────
local bot = newPlayer(4, "Botchar", 999)
WORLD_PLAYERS = { owner, bot }
owner.messages = {}
onSelect(2, owner, warlock, 0, 1, "Botchar")
check("summoning a bot is offered normally",
  lastMessage(owner):find("Summoning Botchar") ~= nil)

CHAR_WRITES = {}
bot.near = true
GAME_TIME = GAME_TIME + 6
checkArrivals()
check("the bot arrival still wrote a row for the audit trail", #CHAR_WRITES == 1)
check("...marked skipped, not pending",
  CHAR_WRITES[1]:find("'skipped'") ~= nil)
check("...with skip_reason 'playerbot'",
  CHAR_WRITES[1]:find("'playerbot'") ~= nil)
check("...and the summoner is not promised points",
  lastMessage(owner):find("shop points") == nil)

-- ── Claims expire so reused creature guids do not inherit an owner ────────
GAME_TIME = GAME_TIME + 100000
pruneSpawns()
stranger.messages = {}
onHello(1, stranger, warlock)
check("after the warlock despawns its claim is gone",
  lastMessage(stranger):find("called by someone else") ~= nil)
owner.messages = {}
onHello(1, owner, warlock)
check("...and even the original owner no longer commands it",
  lastMessage(owner):find("called by someone else") ~= nil)


