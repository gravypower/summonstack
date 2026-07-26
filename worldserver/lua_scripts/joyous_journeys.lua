--[[
  Joyous Journeys — a server-wide XP event, switched on from the admin panel.

  The webapp owns the state: one row in `summonstack_web`.xp_event. This script
  only reads it. Turning the event off in the panel turns it off in the world
  within POLL_SECONDS whether or not anyone touches this file, and the
  worldserver never has to restart.

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

-- How often to re-read the panel's row. Also the worst-case delay between
-- hitting Save and players seeing the change.
local POLL_SECONDS = 15

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
  -- The table is created lazily by the webapp, which may not have served a
  -- request yet. Querying it before then logs an SQL error every poll.
  tableReady = false,
  -- A reload starts from active = false. Without this the first poll of a
  -- running event would announce it a second time.
  primed = false,
}

local function percent()
  return math.floor((state.multiplier - 1) * 100 + 0.5)
end

local function tableReady()
  if state.tableReady then
    return true
  end
  local query = WorldDBQuery(string.format(
    "SELECT COUNT(*) FROM information_schema.TABLES " ..
    "WHERE TABLE_SCHEMA = '%s' AND TABLE_NAME = 'xp_event'", WEB_DB))
  state.tableReady = query ~= nil and query:GetUInt32(0) > 0
  return state.tableReady
end

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
  if not tableReady() then
    return
  end

  -- Activeness is decided by MySQL so the expiry uses the same clock that
  -- wrote ends_at, rather than the worldserver's.
  local query = WorldDBQuery(string.format(
    "SELECT (enabled = 1 AND (ends_at IS NULL OR ends_at > NOW())), " ..
    "multiplier_pct, aura_spell, name FROM `%s`.xp_event WHERE id = 1", WEB_DB))
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
    "UPDATE `%s`.xp_event SET seen_at = NOW() WHERE id = 1", WEB_DB))
end

RegisterPlayerEvent(PLAYER_EVENT_ON_GIVE_XP, function(event, player, amount, victim)
  if not state.active or state.multiplier == 1 then
    return
  end
  return math.floor(amount * state.multiplier)
end)

RegisterPlayerEvent(PLAYER_EVENT_ON_LOGIN, function(event, player)
  if not state.active then
    return
  end
  applyAura(player)
  player:SendBroadcastMessage(string.format(
    "|cff00ff00%s is running: +%d%% experience.|r", state.name, percent()))
end)

refresh()
CreateLuaEvent(refresh, POLL_SECONDS * 1000, 0)
