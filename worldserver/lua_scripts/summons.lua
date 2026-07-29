--[[
  Summons — the server-wide summon counter, and the shop points a player earns
  for summoning someone else.

  What counts as a summon: a player casts one of SUMMON_SPELLS at another
  player, and that player actually turns up. The cast alone proves nothing —
  the core sends the summon as an offer with two minutes to accept or decline,
  and the accepted teleport lands the target on the *caster's position at cast
  time*. So each cast is parked in `pending` and only counted once the target
  appears within ARRIVAL_YARDS of that spot. A ritual spammed at a friend who
  never clicks Accept therefore earns nothing.

  The webapp owns the money. This script only appends rows to
  `summonstack_web`.summon_events; the portal turns each row into shop points,
  keyed on the row id so one summon can never pay twice. The rules that decide
  whether a row pays at all — alts on the same account, the per-pair cooldown,
  the daily cap — live there too, which is why the chat line below says "up to
  the daily cap" instead of promising a balance.

  Only ON_SPELL_CAST is registered here, so this file does not collide with the
  ON_GIVE_XP handler in xp.lua (see the note at the top of that file).

  The worldserver's Lua engine (ALE) watches this directory and reloads on
  change, so edits here land within seconds; `.reload ale` from the admin
  console forces it.
]]

-- Must match WEB_DB in docker-compose.yml.
local WEB_DB = "summonstack_web"

-- Which realm this worldserver is, stamped on every row so summons can be
-- attributed to the realm they happened on. Every realm runs this same script
-- from the same shared lua_scripts mount, so it cannot be a constant.
-- Falls back to 1 if the engine does not expose it, which is the id the column
-- defaulted to before rows were realm-scoped.
local REALM_ID = (type(GetRealmID) == "function" and GetRealmID()) or 1

-- There is deliberately no CHARS_DB constant. The character database differs
-- per realm (acore_characters, acore_characters_3, acore_characters_pb_4 …),
-- so the row below is written with CharDBExecute, whose connection is already
-- bound to whichever one this realm uses. A hardcoded name here looked up
-- another realm's characters table and credited the wrong account, or none.

-- How often to re-read the panel's settings row and the realm total.
local POLL_SECONDS = 15

-- How often parked casts are checked for an arrival. The summoned player sees
-- nothing from this script, so a few seconds' lag costs nothing.
local CHECK_SECONDS = 5

-- The two ways one player teleports another on 3.3.5a:
--   7720  cast by the warlock when a Summoning Portal ritual completes
--         (gameobject_template 36727, summoningRitual.spellId = 7720)
--   23598 cast by whoever clicks a Meeting Stone with a raid member selected
-- Both are cast by the *summoner* with the summoned player as their current
-- selection, which is what SPELL_EFFECT_SUMMON_PLAYER reads.
local SUMMON_SPELLS = { [7720] = true, [23598] = true }

-- Arrival is an exact teleport to the recorded point, so this only has to
-- absorb the few steps a player takes before the next check.
local ARRIVAL_YARDS = 30

-- A cast at someone already standing here summons nobody anywhere, and
-- counting it would make "walk together, cast, get paid" a points farm.
local FAR_YARDS = 60

-- The core gives the target 120s to accept (MAX_PLAYER_SUMMON_DELAY).
local SUMMON_TIMEOUT = 130

local PLAYER_EVENT_ON_SPELL_CAST = 5

local state = {
  -- Rewards being off does not stop the counting: rows are still appended,
  -- marked so the portal never pays them out retroactively.
  enabled = false,
  points = 0,
  announceEvery = 0,
  -- Bounties: summoned account id → percentage of the usual points. Only used
  -- to quote the right number in chat; the portal applies the real one.
  bonuses = {},
  -- Realm total. Re-read from the DB on every poll, so a miscount between
  -- polls (or a second worldserver) self-heals.
  total = 0,
}

-- Summoned player's guid → the cast waiting for them to arrive. Keyed by the
-- target so a second summoner simply takes over an unaccepted offer.
local pending = {}

-- The tables are created lazily by the webapp, which may not have served a
-- request yet. Querying one before then logs an SQL error every poll.
local tablesReady = {}

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
  return type(name) == "string" and #name <= 12 and name:match("^%a+$") ~= nil
end

-- ── Playerbots ─────────────────────────────────────────────────────────────

-- On a playerbots realm most "players" are bots, and up to MaxRandomBots of
-- them summon each other constantly. Left alone they would dominate the ledger
-- and pay out points to the accounts that own them, so their summons are
-- recorded for the audit trail but never awarded.
--
-- Random bots live on accounts named with this prefix — mod-playerbots'
-- AiPlayerbot.RandomBotAccountPrefix, whose default is "rndbot". Change it here
-- if you change it there; a Lua script cannot read the module's config.
-- Characters a player adds as bots themselves sit on that player's own
-- account and are deliberately not caught by this.
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

  local query = WorldDBQuery(string.format(
    "SELECT enabled, points_per_summon, announce_every FROM `%s`.summon_rewards " ..
    "WHERE id = 1", WEB_DB))
  if query then
    state.enabled = query:GetUInt32(0) == 1
    state.points = query:GetUInt32(1)
    state.announceEvery = query:GetUInt32(2)
  end

  -- Scoped to this realm: the milestone this feeds is announced as "Summon #N
  -- on the realm", so counting every realm's rows would overstate it and make
  -- each realm announce at points that mean nothing to the players there.
  -- Playerbot summons are excluded for the same reason — they are logged for
  -- the audit trail, not because a player did anything.
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
    -- Rebuilt rather than merged, so a removed bounty stops applying.
    local fresh = {}
    if bounties then
      repeat
        fresh[bounties:GetUInt32(0)] = bounties:GetUInt32(1)
      until not bounties:NextRow()
    end
    state.bonuses = fresh
  end

  -- Heartbeat, so the admin panel can tell "nobody has summoned anyone" apart
  -- from "this script never loaded".
  WorldDBExecute(string.format(
    "UPDATE `%s`.summon_rewards SET seen_at = NOW() WHERE id = 1", WEB_DB))
end

-- ── Counting ───────────────────────────────────────────────────────────────

--- 200 → "2x", 150 → "1.5x".
local function multiplierLabel(pct)
  if pct % 100 == 0 then
    return string.format("%dx", pct / 100)
  end
  return string.format("%.1fx", pct / 100)
end

--- Append the summon, tell the summoner, and announce round numbers.
--- `summoner` is nil when they logged out between the cast and the arrival;
--- the row is still written, so the summon still counts and still pays.
--- `targetAccount` only shapes the chat line — the row's own account comes
--- from the characters table below.
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

  -- target_account comes from the characters row rather than the client, and
  -- the SELECT is also the existence check: a character deleted mid-summon
  -- simply inserts nothing.
  --
  -- Run on the character connection so `characters` resolves to this realm's
  -- own database, with the web database named explicitly. Written this way
  -- rather than as two statements so the account lookup and the insert stay a
  -- single atomic statement, as they were before.
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

  -- Bot summons are recorded but do not move the counter, and nobody is told
  -- about them: on a realm with a couple of hundred random bots they would
  -- otherwise drown out the milestone and spam every player with world
  -- announcements about summons no person performed.
  if bot then
    return
  end

  state.total = state.total + 1

  local bonusPct = state.bonuses[targetAccount] or 100
  local points = math.floor(state.points * bonusPct / 100 + 0.5)

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

--- Count the parked casts whose target has arrived, and drop the rest.
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
    -- Instance id as well as map id: two copies of the same dungeon share a
    -- map, and arriving in the wrong one is not this summon.
    if target and target:GetMapId() == offer.map and
        target:GetInstanceId() == offer.instance and
        target:GetDistance(offer.x, offer.y, offer.z) <= ARRIVAL_YARDS then
      pending[targetGuid] = nil
      record(offer, targetGuid, target:GetName(), online[offer.summonerGuid],
        target:GetAccountId())
    elseif now >= offer.expires then
      -- Declined, timed out, or the summon was refused by the core.
      pending[targetGuid] = nil
    end
  end
end

-- ── Hooks ──────────────────────────────────────────────────────────────────

RegisterPlayerEvent(PLAYER_EVENT_ON_SPELL_CAST, function(event, player, spell)
  if not SUMMON_SPELLS[spell:GetEntry()] then
    return
  end

  local target = player:GetSelection()
  if not target or not target:IsPlayer() then
    return
  end
  local targetGuid = target:GetGUIDLow()
  if targetGuid == player:GetGUIDLow() then
    return
  end

  -- Nothing to reward if they are already standing here. Same map plus a
  -- generous radius, so a summon across a city still counts.
  local map = player:GetMapId()
  if target:GetMapId() == map and
      target:GetInstanceId() == player:GetInstanceId() and
      player:GetDistance(target) <= FAR_YARDS then
    return
  end

  pending[targetGuid] = {
    summonerGuid = player:GetGUIDLow(),
    summonerName = player:GetName(),
    summonerAccount = player:GetAccountId(),
    spell = spell:GetEntry(),
    map = map,
    instance = player:GetInstanceId(),
    zone = player:GetZoneId(),
    -- Where the target will land if they accept.
    x = player:GetX(),
    y = player:GetY(),
    z = player:GetZ(),
    expires = GetGameTime() + SUMMON_TIMEOUT,
  }
end)

refresh()
CreateLuaEvent(refresh, POLL_SECONDS * 1000, 0)
CreateLuaEvent(checkArrivals, CHECK_SECONDS * 1000, 0)
