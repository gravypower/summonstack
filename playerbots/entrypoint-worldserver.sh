#!/bin/bash
# entrypoint-worldserver.sh
# Generates worldserver.conf from environment variables and starts the server.
set -e

ETC_DIR="/azerothcore/env/dist/etc"
CONF_DIST="${ETC_DIR}/worldserver.conf.dist"
CONF="${ETC_DIR}/worldserver.conf"

mkdir -p "$ETC_DIR" /usr/local/etc /usr/local/etc/modules

# Try to use the installed .conf.dist; if absent we generate a minimal config.
if [ -f "$CONF_DIST" ]; then
  cp "$CONF_DIST" "$CONF"
else
  echo "[entrypoint] worldserver.conf.dist not found — writing minimal config."
  found=$(find /azerothcore/env/dist -name 'worldserver.conf.dist' 2>/dev/null | head -1)
  if [ -n "$found" ]; then
    echo "[entrypoint] Found conf.dist at: $found"
    cp "$found" "$CONF"
  else
    cat > "$CONF" << 'CONFEOF'
[worldserver]

LoginDatabaseInfo     = "127.0.0.1;3306;root;password;acore_auth"
WorldDatabaseInfo     = "127.0.0.1;3306;root;password;acore_world"
CharacterDatabaseInfo = "127.0.0.1;3306;root;password;acore_characters"

DataDir  = "/azerothcore/env/dist/data"
LogsDir  = "/azerothcore/env/dist/logs"
TempDir  = "/azerothcore/env/dist/temp"

SourceDirectory = "/azerothcore"
MySQLExecutable = "/usr/bin/mysql"

RealmID = 2

SOAP.Enabled = 0
SOAP.IP      = "127.0.0.1"

Updates.AutoSetup       = 1
Updates.EnableDatabases = 6

Appender.Console = 1,4,0
Appender.Server = 2,4,0,"Server.log","w"
Logger.root = 4,Console Server
Logger.server = 4,Console Server
Logger.module = 4,Console Server
CONFEOF
  fi
fi

# Helper: replace (or append) a quoted string setting.
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

# Helper: replace (or append) an unquoted numeric/keyword setting.
_set() {
  local key="$1" val="$2"
  [ -n "$val" ] || return 0
  if grep -q "^${key}[[:space:]]*=" "$CONF"; then
    sed -i "s|^${key}[[:space:]]*=.*|${key} = ${val}|" "$CONF"
  else
    echo "${key} = ${val}" >> "$CONF"
  fi
}

# Database connections
_set_str "LoginDatabaseInfo"      "${AC_LOGIN_DATABASE_INFO}"
_set_str "WorldDatabaseInfo"      "${AC_WORLD_DATABASE_INFO}"
_set_str "CharacterDatabaseInfo"  "${AC_CHARACTER_DATABASE_INFO}"
_set_str "PlayerbotsDatabaseInfo" "${AC_PLAYERBOTS_DATABASE_INFO:-${AC_CHARACTER_DATABASE_INFO}}"

# Paths
_set_str "DataDir"         "${AC_DATA_DIR:-/azerothcore/env/dist/data}"
_set_str "LogsDir"         "${AC_LOGS_DIR:-/azerothcore/env/dist/logs}"
_set_str "TempDir"         "${AC_TEMP_DIR:-/azerothcore/env/dist/temp}"
_set_str "SourceDirectory" "/azerothcore"
_set_str "MySQLExecutable" "${AC_MYSQL_EXECUTABLE:-/usr/bin/mysql}"

# Realm & Network
_set "RealmID"          "${AC_REALM_ID:-2}"
_set "WorldServerPort"  "${AC_WORLD_SERVER_PORT:-8085}"
_set_str "BindIP"       "${AC_BIND_IP:-0.0.0.0}"

# SOAP API
_set "SOAP.Enabled" "${AC_SOAP_ENABLED:-0}"
_set_str "SOAP.IP"  "${AC_SOAP_IP:-0.0.0.0}"

# Auto-import disabled since base playerbots tables and updates are initialized directly.
_set "Updates.AutoSetup"       "${AC_UPDATES_AUTO_SETUP:-0}"
_set "Updates.EnableDatabases" "${AC_UPDATES_ENABLE_DBS:-0}"


# Copy to default expected path /usr/local/etc/worldserver.conf as well
cp "$CONF" /usr/local/etc/worldserver.conf

# Copy playerbots module config if present
if [ -f "/azerothcore/env/dist/etc/mod_playerbots.conf" ]; then
  mkdir -p /usr/local/etc/modules /azerothcore/env/dist/etc/modules
  cp "/azerothcore/env/dist/etc/mod_playerbots.conf" /usr/local/etc/modules/playerbots.conf 2>/dev/null || true
  cp "/azerothcore/env/dist/etc/mod_playerbots.conf" /azerothcore/env/dist/etc/modules/playerbots.conf 2>/dev/null || true
fi

# Ensure runtime directories exist.
mkdir -p "${AC_LOGS_DIR:-/azerothcore/env/dist/logs}"
mkdir -p "${AC_TEMP_DIR:-/azerothcore/env/dist/temp}"

echo "[entrypoint] Starting worldserver (RealmID=${AC_REALM_ID:-2})"
exec /azerothcore/env/dist/bin/worldserver -c "$CONF" "$@"
