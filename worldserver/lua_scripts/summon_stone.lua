--[[
  Summoning Stone — a consumable shop item that spawns a Warlock NPC, a Ritual
  Assistant, and a Summoning Portal. The player talks to the warlock, types a
  name, and the target gets the standard "accept summon" dialog. If they
  accept and arrive, the summon is recorded in summonstack_web.summon_events
  and earns shop points, just like a real warlock or meeting-stone summon.

  Uses `target:SummonPlayer(caster)` instead of a spell cast, so no group
  membership is required. The summoned player only needs to be online.

  Spell value 0 in the summon_events row distinguishes a stone summon from a
  warlock ritual (7720) or meeting stone (23598).

  The worldserver's Lua engine (ALE) watches this directory and reloads on
  change, so edits here land within seconds; `.reload ale` from the admin
  console forces it.
]]

-- Must match WEB_DB in docker-compose.yml.
local WEB_DB = "summonstack_web"

-- Which realm this worldserver is. Same logic as summons.lua.
local REALM_ID = (type(GetRealmID) == "function" and GetRealmID()) or 1

-- How often to re-read the panel's settings row and the realm total.
local POLL_SECONDS = 15

-- How often to check whether a summoned player has arrived.
local CHECK_SECONDS = 5

-- Arrival radius — the summoned player must land within this many yards of
-- the caster's position at cast time. Same as summons.lua.
local ARRIVAL_YARDS = 30

-- A summon at someone already standing next to you is no summon at all.
local FAR_YARDS = 60

-- The core gives the target 120s to accept (MAX_PLAYER_SUMMON_DELAY).
local SUMMON_TIMEOUT = 130

-- Entry ids — custom range, must not collide with stock data.
local ITEM_SUMMON_STONE = 90100
local NPC_WARLOCK       = 90101
local NPC_ASSISTANT     = 90102
local GO_PORTAL         = 181622  -- stock Summoning Portal gameobject

-- NPCs and portal vanish after this many seconds.
local SPAWN_SECONDS = 180

-- Cooldown between uses per player, equal to the spawn duration.
local COOLDOWN_SECONDS = SPAWN_SECONDS

-- ALE/Eluna event constants.
local ITEM_EVENT_ON_USE        = 2
local GOSSIP_EVENT_ON_HELLO    = 1
local GOSSIP_EVENT_ON_SELECT   = 2

-- ── State ──────────────────────────────────────────────────────────────────

local state = {
  enabled       = false,
  points        = 0,
  announceEvery = 0,
  bonuses       = {},
  total         = 0,
}

-- targetGuid → offer data, same shape as summons.lua.
local pending = {}

-- playerGuid → GetGameTime() when the cooldown expires.
local activeSpawns = {}

-- Spawned warlock's creature guid → { owner = playerGuid, expires = time }.
--
-- The gossip hooks below are registered per creature *entry*, so without this
-- every summoner warlock answered to every player: one stone bought a whole
-- raid 180 seconds of free cross-map summons, each one recording a summon
-- that earned its caster points.
--
-- Creature guids are reused after a despawn, hence the expiry. A `.reload ale`
-- empties this table and orphans any warlock already standing, which is why
-- the refusal below tells the player to use their own stone rather than
-- claiming the NPC is broken; they despawn within SPAWN_SECONDS anyway.
local spawnOwners = {}

local function claimSpawn(creature, playerGuid, now)
  if not creature then
    return
  end
  spawnOwners[creature:GetGUIDLow()] = {
    owner = playerGuid,
    expires = now + SPAWN_SECONDS + 30,
  }
end

--- Is this player the one who called this warlock?
local function ownsSpawn(creature, player)
  local claim = spawnOwners[creature:GetGUIDLow()]
  return claim ~= nil and claim.owner == player:GetGUIDLow()
end

--- Drop claims for warlocks that have despawned, so guids can be reused.
local function pruneSpawns()
  local now = GetGameTime()
  for creatureGuid, claim in pairs(spawnOwners) do
    if now >= claim.expires then
      spawnOwners[creatureGuid] = nil
    end
  end
  for playerGuid, expires in pairs(activeSpawns) do
    if now >= expires then
      activeSpawns[playerGuid] = nil
    end
  end
end

-- Lazy table-existence check, same pattern as summons.lua.
local tablesReady = {}

-- ── Template injection ─────────────────────────────────────────────────────
-- Run once per script load. REPLACE keeps a `.reload ale` safe: the rows are
-- overwritten in place and no duplicate-key errors.
--
-- These write the database, but the worldserver reads item and creature
-- templates into memory at startup and does not notice a row appearing
-- underneath it. So on a realm that has never had this script loaded before,
-- the item and the two NPCs exist in MySQL but not in the running world:
-- `.send items <name> 90100` fails and SpawnCreature finds no template. Run
--
--     .reload item_template
--     .reload creature_template
--
-- once from the admin console (or restart the worldserver) after the first
-- load. Later loads change nothing, so the reload is only needed that once —
-- and only if the entry ids or column values above are edited.

WorldDBExecute(string.format(
  "REPLACE INTO item_template" ..
  " (entry, class, subclass, name, displayid, Quality, Flags," ..
  "  BuyCount, maxcount, stackable, Material, InventoryType, bonding," ..
  "  description, spellid_1, spelltrigger_1, spellcharges_1)" ..
  " VALUES (%u, 0, 0, 'Summoning Stone', 6295, 3, 0," ..
  "  1, 5, 5, 0, 0, 1," ..
  "  'Spawns a warlock to summon a player to your location.', 483, 0, 0)",
  ITEM_SUMMON_STONE))

WorldDBExecute(string.format(
  "REPLACE INTO creature_template" ..
  " (entry, name, subname, minlevel, maxlevel, faction, npcflag, unit_flags, `type`)" ..
  " VALUES (%u, 'Summoner Warlock', 'Summoning Stone', 80, 80, 35, 1, 2, 7)," ..
  "        (%u, 'Ritual Assistant', '', 80, 80, 35, 0, 2, 7)",
  NPC_WARLOCK, NPC_ASSISTANT))

WorldDBExecute(string.format(
  "REPLACE INTO creature_template_model" ..
  " (CreatureID, Idx, CreatureDisplayID, DisplayScale, Probability)" ..
  " VALUES (%u, 0, 4218, 1, 1)," ..
  "        (%u, 0, 4220, 1, 1)",
  NPC_WARLOCK, NPC_ASSISTANT))

-- ── Helpers ────────────────────────────────────────────────────────────────

local function tableReady(name)
  if tablesReady[name] then
    return true
  end
  local query = WorldDBQuery(string.format(
    "SELECT COUNT(*) FROM information_schema.TABLES " ..
    "WHERE TABLE_SCHEMA = '%s' AND TABLE_NAME = '%s'", WEB_DB, name))
  tablesReady[name] = query ~= nil and query:GetUInt32(0) > 0
  return tablesReady[name]
end

--- AC character names are plain letters; this also guards SQL interpolation.
local function safeName(name)
  return type(name) == "string" and #name >= 2 and #name <= 12
    and name:match("^%a+$") ~= nil
end

--- 200 → "2x", 150 → "1.5x".
local function multiplierLabel(pct)
  if pct % 100 == 0 then
    return string.format("%dx", pct / 100)
  end
  return string.format("%.1fx", pct / 100)
end

-- ── Playerbots ─────────────────────────────────────────────────────────────
--
-- Duplicated from summons.lua, which explains the reasoning in full: random
-- bots summon each other constantly, so their summons are recorded for the
-- audit trail but never paid. Each script in this directory is self-contained
-- (ALE loads them independently), so the alternative to duplicating is a
-- shared file the engine is not guaranteed to resolve.
--
-- Without this the stone was a way around the rule: a stone summon of a bot
-- was written as 'pending' and the portal paid it, while the realm counter
-- below still filtered out a 'playerbot' skip_reason this file never wrote.
local BOT_ACCOUNT_PREFIX = "rndbot"

-- account id → true/false. Accounts are never renamed in practice and the
-- alternative is an auth query per summon.
local botAccounts = {}

local function isBotAccount(accountId)
  if accountId == nil or accountId == 0 then
    return false
  end
  local known = botAccounts[accountId]
  if known ~= nil then
    return known
  end
  local query = AuthDBQuery(string.format(
    "SELECT username FROM account WHERE id = %u", accountId))
  local username = query and query:GetString(0) or nil
  local isBot = username ~= nil
    and username:lower():sub(1, #BOT_ACCOUNT_PREFIX) == BOT_ACCOUNT_PREFIX
  botAccounts[accountId] = isBot
  return isBot
end

-- ── Settings ───────────────────────────────────────────────────────────────

local function refresh()
  if not tableReady("summon_rewards") or not tableReady("summon_events") then
    return
  end

  -- This realm's own settings row; see the note in summons.lua.
  local query = WorldDBQuery(string.format(
    "SELECT enabled, points_per_summon, announce_every FROM `%s`.summon_rewards " ..
    "WHERE id = %u", WEB_DB, REALM_ID))
  if query then
    state.enabled       = query:GetUInt32(0) == 1
    state.points        = query:GetUInt32(1)
    state.announceEvery = query:GetUInt32(2)
  end

  -- Scoped to this realm, excluding playerbot rows.
  local counted = WorldDBQuery(string.format(
    "SELECT COUNT(*) FROM `%s`.summon_events " ..
    "WHERE realm_id = %u AND (skip_reason IS NULL OR skip_reason <> 'playerbot')",
    WEB_DB, REALM_ID))
  if counted then
    state.total = counted:GetUInt32(0)
  end

  if tableReady("summon_account_bonus") then
    local bounties = WorldDBQuery(string.format(
      "SELECT account_id, multiplier_pct FROM `%s`.summon_account_bonus", WEB_DB))
    local fresh = {}
    if bounties then
      repeat
        fresh[bounties:GetUInt32(0)] = bounties:GetUInt32(1)
      until not bounties:NextRow()
    end
    state.bonuses = fresh
  end
end

-- ── Counting ───────────────────────────────────────────────────────────────

--- Append the summon row, tell the summoner, and announce round numbers.
--- Mirrors the record() in summons.lua — same table, same columns.
local function record(offer, targetGuid, targetName, summoner, targetAccount)
  if not safeName(offer.summonerName) or not safeName(targetName) then
    return
  end

  -- A summon involving a random bot on either side is logged but never paid.
  local bot = isBotAccount(offer.summonerAccount) or isBotAccount(targetAccount)
  local awardState = (state.enabled and not bot) and "pending" or "skipped"
  local skipReason = "NULL"
  if bot then
    skipReason = "'playerbot'"
  elseif not state.enabled then
    skipReason = "'rewards_off'"
  end

  -- target_account comes from the characters row for consistency.
  CharDBExecute(string.format(
    "INSERT INTO `%s`.summon_events " ..
    "(realm_id, summoner_guid, summoner_name, summoner_account, target_guid, " ..
    " target_name, target_account, spell, map, zone, award_state, skip_reason) " ..
    "SELECT %u, %u, '%s', %u, %u, '%s', c.account, %u, %u, %u, '%s', %s " ..
    "FROM characters c WHERE c.guid = %u",
    WEB_DB,
    REALM_ID,
    offer.summonerGuid, offer.summonerName, offer.summonerAccount,
    targetGuid, targetName,
    offer.spell, offer.map, offer.zone,
    awardState,
    skipReason,
    targetGuid))

  -- Bot summons are recorded but do not move the counter and are not
  -- announced, for the reasons given in summons.lua.
  if bot then
    return
  end

  state.total = state.total + 1

  local bonusPct = state.bonuses[targetAccount] or 100
  local points   = math.floor(state.points * bonusPct / 100 + 0.5)

  if summoner then
    if state.enabled and points > 0 then
      summoner:SendBroadcastMessage(string.format(
        "|cff00ff00Summon #%d recorded!|r You summoned %s: +%d shop points%s, " ..
        "up to the daily cap. Spend them on the portal.",
        state.total, targetName, points,
        bonusPct == 100 and "" or
          string.format(" (%s bounty)", multiplierLabel(bonusPct))))
    else
      summoner:SendBroadcastMessage(string.format(
        "|cff00ff00Summon #%d recorded!|r You summoned %s.",
        state.total, targetName))
    end
  end

  if state.announceEvery > 0 and state.total % state.announceEvery == 0 then
    SendWorldMessage(string.format(
      "|cff00ff00Summon #%d on the realm!|r %s just summoned %s.",
      state.total, offer.summonerName, targetName))
  end
end

--- Check every pending summon for an arrival.
local function checkArrivals()
  if next(pending) == nil then
    return
  end
  local now = GetGameTime()

  local online = {}
  for _, player in pairs(GetPlayersInWorld()) do
    online[player:GetGUIDLow()] = player
  end

  for targetGuid, offer in pairs(pending) do
    local target = online[targetGuid]
    if target and target:GetMapId() == offer.map and
        target:GetInstanceId() == offer.instance and
        target:GetDistance(offer.x, offer.y, offer.z) <= ARRIVAL_YARDS then
      pending[targetGuid] = nil
      record(offer, targetGuid, target:GetName(), online[offer.summonerGuid],
        target:GetAccountId())
    elseif now >= offer.expires then
      pending[targetGuid] = nil
    end
  end
end

-- ── Item use handler ───────────────────────────────────────────────────────

local function OnItemUse(event, player, item, target)
  local playerGuid = player:GetGUIDLow()
  local now = GetGameTime()

  -- Per-player cooldown while NPCs are alive.
  if activeSpawns[playerGuid] and activeSpawns[playerGuid] > now then
    player:SendBroadcastMessage(
      "|cffff0000You already have active summoners. Wait for them to despawn.|r")
    return false
  end

  local x, y, z, o = player:GetX(), player:GetY(), player:GetZ(), player:GetO()

  -- Spawn the warlock 2 yards in front of the player, facing back.
  local warlockX = x + 2 * math.cos(o)
  local warlockY = y + 2 * math.sin(o)
  local warlockO = o + math.pi  -- face the player
  local warlock = player:SpawnCreature(NPC_WARLOCK, warlockX, warlockY, z, warlockO,
    5, SPAWN_SECONDS * 1000) -- 5 = TEMPSUMMON_TIMED_DESPAWN
  claimSpawn(warlock, playerGuid, now)

  -- Spawn the assistant to the warlock's right.
  local assistO = o + 0.8
  local assistX = x + 2 * math.cos(assistO)
  local assistY = y + 2 * math.sin(assistO)
  player:SpawnCreature(NPC_ASSISTANT, assistX, assistY, z, warlockO,
    5, SPAWN_SECONDS * 1000)

  -- Spawn the Summoning Portal between them.
  local portalO = o + 0.4
  local portalX = x + 1.5 * math.cos(portalO)
  local portalY = y + 1.5 * math.sin(portalO)
  player:SummonGameObject(GO_PORTAL, portalX, portalY, z, o, SPAWN_SECONDS)

  -- Consume one charge.
  player:RemoveItem(ITEM_SUMMON_STONE, 1)

  player:SendBroadcastMessage(
    "|cff00ff00A Summoner Warlock appears!|r Talk to the warlock to summon a player.")

  activeSpawns[playerGuid] = now + COOLDOWN_SECONDS

  -- The charge is already consumed and the NPCs are up, so suppress the item's
  -- own on-use spell rather than letting it cast on top of all that.
  return false
end

-- ── Gossip handlers ────────────────────────────────────────────────────────

--- Refuse anyone but the player whose stone called this warlock.
local function rejectStranger(player, creature)
  if ownsSpawn(creature, player) then
    return false
  end
  player:SendBroadcastMessage(
    "|cffff0000This summoner was called by someone else.|r " ..
    "Use your own Summoning Stone.")
  return true
end

local function OnGossipHello(event, player, creature)
  if rejectStranger(player, creature) then
    player:GossipComplete()
    return
  end
  player:GossipClearMenu()
  player:GossipMenuAddItem(0, "Summon a player", 0, 1, true,
    "Enter the name of the player to summon:")
  player:GossipMenuAddItem(0, "Nevermind", 0, 2)
  player:GossipSendMenu(1, creature)
end

local function OnGossipSelect(event, player, creature, sender, intid, code)
  player:GossipComplete()

  -- Checked here as well as in OnGossipHello: the menu is opened once but
  -- selections arrive as separate packets, so this is the one that decides.
  if rejectStranger(player, creature) then
    return
  end

  if intid == 2 then
    return
  end

  if intid ~= 1 then
    return
  end

  -- Validate the name.
  if not code or not safeName(code) then
    player:SendBroadcastMessage("|cffff0000Invalid name. Use 2-12 letters only.|r")
    return
  end

  -- Find the target online.
  local nameSearch = code:lower()
  local targetPlayer = nil
  for _, p in pairs(GetPlayersInWorld()) do
    if p:GetName():lower() == nameSearch then
      targetPlayer = p
      break
    end
  end

  if not targetPlayer then
    player:SendBroadcastMessage("|cffff0000Player not found or not online.|r")
    return
  end

  if targetPlayer:GetGUIDLow() == player:GetGUIDLow() then
    player:SendBroadcastMessage("|cffff0000You cannot summon yourself.|r")
    return
  end

  -- Don't summon someone already standing here.
  if targetPlayer:GetMapId() == player:GetMapId() and
     targetPlayer:GetInstanceId() == player:GetInstanceId() and
     player:GetDistance(targetPlayer) <= FAR_YARDS then
    player:SendBroadcastMessage("|cffff0000That player is already nearby.|r")
    return
  end

  -- Send the summon offer. No group required.
  targetPlayer:SummonPlayer(player)

  -- Park for arrival tracking.
  pending[targetPlayer:GetGUIDLow()] = {
    summonerGuid    = player:GetGUIDLow(),
    summonerName    = player:GetName(),
    summonerAccount = player:GetAccountId(),
    spell           = 0, -- marks it as a stone summon
    map             = player:GetMapId(),
    instance        = player:GetInstanceId(),
    zone            = player:GetZoneId(),
    x               = player:GetX(),
    y               = player:GetY(),
    z               = player:GetZ(),
    expires         = GetGameTime() + SUMMON_TIMEOUT,
  }

  player:SendBroadcastMessage(string.format(
    "|cff00ff00Summoning %s!|r They have 2 minutes to accept.",
    targetPlayer:GetName()))
end

-- ── Registration ───────────────────────────────────────────────────────────

RegisterItemEvent(ITEM_SUMMON_STONE, ITEM_EVENT_ON_USE, OnItemUse)
RegisterCreatureGossipEvent(NPC_WARLOCK, GOSSIP_EVENT_ON_HELLO, OnGossipHello)
RegisterCreatureGossipEvent(NPC_WARLOCK, GOSSIP_EVENT_ON_SELECT, OnGossipSelect)

refresh()
CreateLuaEvent(refresh, POLL_SECONDS * 1000, 0)
CreateLuaEvent(checkArrivals, CHECK_SECONDS * 1000, 0)
CreateLuaEvent(pruneSpawns, SPAWN_SECONDS * 1000, 0)
