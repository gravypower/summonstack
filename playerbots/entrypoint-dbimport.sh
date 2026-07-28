#!/bin/bash
# entrypoint-dbimport.sh
# Generates a dbimport config from environment variables and runs the importer.
#
# This one-shot container populates acore_world_pb and acore_characters_pb on
# the shared ac-database MySQL server.  It is safe to re-run: dbimport is
# idempotent (applies only pending updates).
#
# Env vars: same AC_* names as the worldserver entrypoint.
set -e

CONF="/azerothcore/env/dist/etc/dbimport.conf"
CONF_DIST="/azerothcore/env/dist/etc/dbimport.conf.dist"

# Use the dist file as a base if present; otherwise generate a minimal config.
if [ -f "$CONF_DIST" ]; then
  cp "$CONF_DIST" "$CONF"
else
  cat > "$CONF" << 'EOF'
LogsDir         = "/azerothcore/env/dist/logs"
SourceDirectory = "/azerothcore"

# Bitmask: 1=auth  2=characters  4=world  (7 = all three)
# Auth DB already exists from the standard ac-db-import, so we update only
# the two playerbots-specific DBs (characters=2, world=4 → 6).
Updates.EnableDatabases = 6
EOF
fi

# Helper: upsert a quoted string setting.
_set_str() {
  local key="$1" val="$2"
  [ -n "$val" ] || return 0
  local escaped; escaped=$(printf '%s' "$val" | sed 's|[\\&]|\\&|g')
  if grep -q "^${key}[[:space:]]*=" "$CONF"; then
    sed -i "s|^${key}[[:space:]]*=.*|${key} = \"${escaped}\"|" "$CONF"
  else
    echo "${key} = \"${escaped}\"" >> "$CONF"
  fi
}

_set_str "LoginDatabaseInfo"     "${AC_LOGIN_DATABASE_INFO}"
_set_str "WorldDatabaseInfo"     "${AC_WORLD_DATABASE_INFO}"
_set_str "CharacterDatabaseInfo" "${AC_CHARACTER_DATABASE_INFO}"
_set_str "LogsDir"               "${AC_LOGS_DIR:-/azerothcore/env/dist/logs}"

mkdir -p "${AC_LOGS_DIR:-/azerothcore/env/dist/logs}"

exec /azerothcore/env/dist/bin/dbimport
