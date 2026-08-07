--[[
  XP rules — the server-wide XP event (Joyous Journeys) and the per-character
  XP locks bought from the shop.

  Both live in one file on purpose: they share PLAYER_EVENT_ON_GIVE_XP. Two
  scripts registering that hook would both run and the engine keeps whichever
  handler returned last, so a running event could hand XP back to a locked
  character. One hook, one decision — a lock wins, otherwise the event
  multiplier applies.

  The webapp owns both pieces of state: `summonstack_web`.xp_event (one row)
  and `summonstack_web`.shop_xp_locks (one row per character ever locked).
  This script only reads them, so a change in the panel or a purchase in the
  shop lands in the world within the poll interval, and the worldserver never
  has to restart.

  The worldserver's Lua engine (ALE) watches this directory and reloads on
  change, so edits here land within seconds; `.reload ale` from the admin
  console forces it.

  Note on the name: Joyous Journeys is a Classic-2019 spell (64371) and does not
  exist in 3.3.5a, so there is no such buff icon to give players. The XP itself
  is applied in the OnGiveXP hook below — which covers kill, quest and
  exploration XP, since all three go through Player::GiveXP — and the aura is
  only there so players can see the event is running.
]]

-- Must match WEB_DB in docker-compose.yml.
local WEB_DB = "summonstack_web"

-- Which realm this worldserver is. Every realm runs this same script from the
-- same shared lua_scripts mount, and character guids restart at 1 in each
-- character database — so guid 5 here and guid 5 on another realm are
-- different characters, and locks must be matched on both columns.
-- Falls back to 1 if the engine does not expose it, which is the id the
-- webapp defaulted to before locks were realm-scoped.
local REALM_ID = (type(GetRealmID) == "function" and GetRealmID()) or 1

-- How often to re-read the panel's row. Also the worst-case delay between
-- hitting Save and players seeing the change.
local POLL_SECONDS = 15

-- Locks are re-read more often than the event: the gap between paying for a
-- lock and it taking hold is XP the buyer did not want. Logins read their own
-- lock directly, so this only has to catch purchases made mid-session.
local LOCK_POLL_SECONDS = 5

-- Re-applied on every poll while the event runs, so the spell's own duration
-- does not matter.
local AURA_DURATION_MS = 2 * 60 * 60 * 1000

local PLAYER_EVENT_ON_LOGIN = 3
local PLAYER_EVENT_ON_GIVE_XP = 12

local state = {
  active = false,
  multiplier = 1,
  aura = 0,
  name = "Joyous Journeys",
  -- A reload starts from active = false. Without this the first poll of a
  -- running event would announce it a second time.
  primed = false,
}

-- guid → the level that character is held at. Absent = XP counts as normal.
local locks = {}

-- The tables are created lazily by the webapp, which may not have served a
-- request yet. Querying one before then logs an SQL error every poll.
local tablesReady = {}

local function percent()
  return math.floor((state.multiplier - 1) * 100 + 0.5)
end

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

-- ── XP locks ───────────────────────────────────────────────────────────────

--- The level a character is being held at, or nil if its XP still counts.
local function lockedAt(player)
  local target = locks[player:GetGUIDLow()]
  -- A lock may be bought below its target level and takes hold on arrival, so
  -- a character under it still levels normally.
  if target and player:GetLevel() >= target then
    return target
  end
  return nil
end

local function refreshLocks()
  if not tableReady("shop_xp_locks") then
    return
  end
  local query = WorldDBQuery(string.format(
    "SELECT character_guid, target_level FROM `%s`.shop_xp_locks " ..
    "WHERE realm_id = %u AND released_at IS NULL", WEB_DB, REALM_ID))
  -- Rebuilt rather than merged: a released lock simply stops being returned.
  local fresh = {}
  if query then
    repeat
      fresh[query:GetUInt32(0)] = query:GetUInt32(1)
    until not query:NextRow()
  end
  locks = fresh
end

--- Read one character's lock, so a login never races the poll above.
local function refreshLockFor(player)
  if not tableReady("shop_xp_locks") then
    return
  end
  local guid = player:GetGUIDLow()
  local query = WorldDBQuery(string.format(
    "SELECT target_level FROM `%s`.shop_xp_locks " ..
    "WHERE character_guid = %u AND realm_id = %u AND released_at IS NULL",
    WEB_DB, guid, REALM_ID))
  locks[guid] = query and query:GetUInt32(0) or nil
end

-- ── XP event ───────────────────────────────────────────────────────────────

local function applyAura(player)
  if state.aura == 0 then
    return
  end
  local aura = player:AddAura(state.aura, player)
  if aura then
    aura:SetMaxDuration(AURA_DURATION_MS)
    aura:SetDuration(AURA_DURATION_MS)
  end
end

--- Bring every online player's buff icon in line with the current state.
local function syncAuras()
  if state.aura == 0 then
    return
  end
  for _, player in pairs(GetPlayersInWorld()) do
    if state.active then
      if not player:HasAura(state.aura) then
        applyAura(player)
      end
    elseif player:HasAura(state.aura) then
      player:RemoveAura(state.aura)
    end
  end
end

local function refresh()
  if not tableReady("xp_event") then
    return
  end

  -- Activeness is decided by MySQL so the expiry uses the same clock that
  -- wrote ends_at, rather than the worldserver's.
  -- Keyed by realm: each realm has its own row, so one realm can run an
  -- event while another does not. Reading id = 1 unconditionally meant every
  -- realm mirrored realm 1 and no other realm's row could ever take effect.
  local query = WorldDBQuery(string.format(
    "SELECT (enabled = 1 AND (ends_at IS NULL OR ends_at > NOW())), " ..
    "multiplier_pct, aura_spell, name FROM `%s`.xp_event WHERE id = %u",
    WEB_DB, REALM_ID))
  if not query then
    return
  end

  local wasActive = state.active
  local previousAura = state.aura

  state.active = query:GetUInt32(0) == 1
  state.multiplier = query:GetUInt32(1) / 100
  state.aura = query:GetUInt32(2)
  state.name = query:GetString(3)

  -- Changing the spell mid-event would otherwise leave the old icon behind.
  if previousAura ~= 0 and previousAura ~= state.aura then
    for _, player in pairs(GetPlayersInWorld()) do
      if player:HasAura(previousAura) then
        player:RemoveAura(previousAura)
      end
    end
  end

  if state.primed and state.active and not wasActive then
    SendWorldMessage(string.format(
      "|cff00ff00%s has begun! All experience gains are increased by %d%%.|r",
      state.name, percent()))
  elseif state.primed and wasActive and not state.active then
    SendWorldMessage(string.format(
      "|cffffa500%s has ended. Experience gains are back to normal.|r",
      state.name))
  end
  state.primed = true

  syncAuras()

  -- Heartbeat, so the admin panel can tell the difference between "the event
  -- is off" and "this script never loaded".
  WorldDBExecute(string.format(
    "UPDATE `%s`.xp_event SET seen_at = NOW() WHERE id = %u", WEB_DB, REALM_ID))
end

-- ── Hooks ──────────────────────────────────────────────────────────────────

RegisterPlayerEvent(PLAYER_EVENT_ON_GIVE_XP, function(event, player, amount, victim)
  -- A lock beats the event: there is no multiplier that turns zero into XP.
  if lockedAt(player) then
    return 0
  end
  if not state.active or state.multiplier == 1 then
    return
  end
  return math.floor(amount * state.multiplier)
end)

RegisterPlayerEvent(PLAYER_EVENT_ON_LOGIN, function(event, player)
  refreshLockFor(player)
  local target = lockedAt(player)
  if target then
    player:SendBroadcastMessage(string.format(
      "|cffffa500Your experience is locked at level %d.|r " ..
      "Buy the unlock in the shop to start gaining experience again.", target))
  end

  if not state.active then
    return
  end
  applyAura(player)
  player:SendBroadcastMessage(string.format(
    "|cff00ff00%s is running: +%d%% experience.|r", state.name, percent()))
end)

refresh()
refreshLocks()
CreateLuaEvent(refresh, POLL_SECONDS * 1000, 0)
CreateLuaEvent(refreshLocks, LOCK_POLL_SECONDS * 1000, 0)
