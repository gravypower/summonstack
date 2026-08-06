"""Rendering docker-compose.override.yml from the manifest.

The whole file is rendered every time. The previous generator appended service
blocks as text and deleted them by matching line indentation, which is how a
service could survive a removal or a file end up half-valid.
"""

from __future__ import annotations

import os
from typing import Any

import yaml

from .manifest import Manifest, Realm
from . import hardware

OVERRIDE_PATH = "docker-compose.override.yml"
COMPOSE_PATH = "docker-compose.yml"

DB_PASS = "${DOCKER_DB_ROOT_PASSWORD:-password}"

HEADER = """\
# GENERATED FILE — DO NOT EDIT.
#
# Rendered from realms.yml by `task realm:render`. Every edit here is lost the
# next time a realm is added, removed or re-rendered; change realms.yml instead.
"""

PLAYERBOT_DEFAULTS = {
    "AC_AI_PLAYERBOT_ENABLED": "1",
    "AC_AI_PLAYERBOT_ALLOW_PLAYER_BOTS": "1",
    "AC_AI_PLAYERBOT_RANDOM_BOT_AUTOLOGIN": "1",
    "AC_AI_PLAYERBOT_RANDOM_BOT_AUTO_CREATE": "1",
    "AC_AI_PLAYERBOT_RANDOM_BOT_ACCOUNT_COUNT": "250",
    "AC_AI_PLAYERBOT_BOT_AUTOLOGIN": "1",
    "AC_AI_PLAYERBOT_MIN_RANDOM_BOTS": "100",
    "AC_AI_PLAYERBOT_MAX_RANDOM_BOTS": "200",
    "AC_AI_PLAYERBOT_AUTO_DO_QUESTS": "1",
    "AC_AI_PLAYERBOT_SYNC_QUEST_WITH_PLAYER": "1",
    "AC_AI_PLAYERBOT_RANDOM_BOT_RPG_CHANCE": "0.20",
    "AC_AI_PLAYERBOT_AUTO_PICK_REWARD": "1",
    "AC_AI_PLAYERBOT_DISABLED_WITHOUT_REAL_PLAYER": "0",
    "AC_QUESTS_IGNORE_AUTO_ACCEPT": "1",
    "AC_PRELOAD_ALL_NON_INSTANCED_MAP_GRIDS": "0",
    "AC_SET_ALL_CREATURES_WITH_WAYPOINT_MOVEMENT_ACTIVE": "0",
    "AC_DONT_CACHE_RANDOM_MOVEMENT_PATHS": "0",
    "AC_MAP_UPDATE_INTERVAL": "50",
    "AC_MIN_WORLD_UPDATE_TIME": "1",
    "AC_PLAYER_LIMIT": "100",
    "AC_LEAVE_GROUP_ON_LOGOUT_ENABLED": "1",
}


def _db_info(database: str) -> str:
    return f"ac-database;3306;root;{DB_PASS};{database}"


def service_for(realm: Realm, generated_count: int) -> dict[str, Any]:
    """The compose service for one generated realm."""
    budget = hardware.thread_budget(hardware.available_cores(), generated_count, realm.type == "playerbots")
    
    game_port = realm.game_port
    environment: dict[str, str] = {
        "AC_DATA_DIR": "/azerothcore/env/dist/data",
        "AC_LOGS_DIR": "/azerothcore/env/dist/logs",
        "AC_LOGIN_DATABASE_INFO": _db_info("acore_auth"),
        "AC_WORLD_DATABASE_INFO": _db_info(realm.world_db),
        "AC_CHARACTER_DATABASE_INFO": _db_info(realm.chars_db),
        "AC_REALM_ID": str(realm.id),
        "AC_BIND_IP": "0.0.0.0",
        "AC_WORLD_SERVER_PORT": "8085",
        "AC_SOAP_ENABLED": "1",
        "AC_SOAP_IP": "0.0.0.0",
    }

    service: dict[str, Any] = {
        "container_name": realm.service,
        "networks": ["ac-network"],
        "stdin_open": True,
        "tty": True,
        "restart": "unless-stopped",
    }

    if realm.type == "playerbots":
        service["image"] = "summonstack-ac-pb-worldserver:latest"
        environment["AC_TEMP_DIR"] = "/azerothcore/env/dist/temp"
        environment["AC_PLAYERBOTS_DATABASE_INFO"] = _db_info(realm.chars_db)
        environment.update(PLAYERBOT_DEFAULTS)
        volumes = [
            "ac-client-data:/azerothcore/env/dist/data:ro",
            "./playerbots/playerbots.conf:/azerothcore/env/dist/etc/mod_playerbots.conf:ro",
            "./playerbots/entrypoint-worldserver.sh:/entrypoint.sh:ro",
            "./playerbots/entrypoint-worldserver.sh:/entrypoint-worldserver.sh:ro",
            "./worldserver/modules:/usr/local/etc/modules",
            "./worldserver/lua_scripts:/azerothcore/lua_scripts:ro",
        ]
    else:
        service["image"] = "acore/ac-wotlk-worldserver:${DOCKER_IMAGE_TAG:-master}"
        volumes = [
            "ac-client-data:/azerothcore/env/dist/data/:ro",
            # Directory, read-write, on purpose: see the note in
            # docker-compose.yml. A single-file mount here makes Docker create
            # the parent as root and the entrypoint dies copying its defaults.
            "./worldserver/modules:/azerothcore/env/dist/etc/modules",
            "./worldserver/lua_scripts:/azerothcore/lua_scripts:ro",
        ]

    # Apply computed thread budget
    environment["AC_MAP_UPDATE_THREADS"] = str(budget["map_threads"])
    environment["AC_NETWORK_THREADS"] = str(budget["network_threads"])
    environment["AC_THREAD_POOL"] = str(hardware.available_cores())
    if realm.type == "playerbots":
        environment["AC_PLAYERBOTS_DATABASE_WORKER_THREADS"] = str(budget["db_worker"])
        environment["AC_PLAYERBOTS_DATABASE_SYNCH_THREADS"] = str(budget["db_synch"])

    # Manifest settings win, so a realm can override a playerbot default or computed thread budget.
    environment.update({k: str(v) for k, v in realm.settings.items()})

    service["environment"] = environment
    service["ports"] = [
        f"{realm.game_port}:8085",
        f"127.0.0.1:{realm.soap_port}:7878",
    ]
    service["volumes"] = volumes
    service["depends_on"] = {
        "ac-database": {"condition": "service_healthy"},
        "ac-client-data-init": {"condition": "service_completed_successfully"},
    }
    if realm.profile:
        service["profiles"] = [realm.profile]
    return service


def render(manifest: Manifest) -> str | None:
    """The override file contents, or None when no generated realms exist."""
    generated = [r for r in manifest.generated_realms() if r.enabled]
    if not generated:
        return None
    services = {realm.service: service_for(realm, len(generated)) for realm in sorted(generated, key=lambda r: r.id)}
    body = yaml.safe_dump({"services": services}, sort_keys=False, default_flow_style=False, width=120)
    return HEADER + "\n" + body


def write_override(manifest: Manifest, path: str = OVERRIDE_PATH) -> str:
    """Render to disk. Returns a one-line description of what changed."""
    content = render(manifest)
    existing = None
    if os.path.exists(path):
        with open(path, "r", encoding="utf-8") as handle:
            existing = handle.read()

    if content is None:
        if existing is not None:
            os.remove(path)
            return f"removed {path} (no generated realms)"
        return f"{path} not needed (no generated realms)"

    if existing == content:
        return f"{path} already up to date"

    with open(path, "w", encoding="utf-8") as handle:
        handle.write(content)
    count = len([r for r in manifest.generated_realms() if r.enabled])
    verb = "updated" if existing is not None else "created"
    return f"{verb} {path} ({count} generated realm{'s' if count != 1 else ''})"


MYSQL_CNF_PATH = "database/summonstack.cnf"

MYSQL_CNF_TEMPLATE = """\
# SummonStack — MySQL tuning for game server workloads.
#
# GENERATED FILE — regenerated by `task realm:render`.
# Edit scripts/summonstack/hardware.py to change the tuning logic,
# or override individual values in a separate my.cnf loaded after this one.
#
# This file is mounted read-only into ac-database at
# /etc/mysql/conf.d/summonstack.cnf

[mysqld]
# ── Buffer Pool ──
# Auto-calculated as ~10%% of system RAM (clamped 256MB–8GB).
# Detected: {memory_gb:.1f} GB total RAM → {buffer_pool_mb} MB buffer pool.
innodb_buffer_pool_size = {buffer_pool_mb}M
innodb_buffer_pool_instances = {buffer_pool_instances}

# ── Durability (relaxed for game servers) ──
# Risk: lose up to 1 second of data on a hard power loss.
innodb_flush_log_at_trx_commit = 2
sync_binlog = 0

# ── Redo Log ──
innodb_redo_log_capacity = 512M

# ── I/O Capacity ──
innodb_io_capacity = 2000
innodb_io_capacity_max = 4000

# ── Lock Contention ──
transaction_isolation = READ-COMMITTED
innodb_autoinc_lock_mode = 2

# ── Thread Handling ──
max_connections = 300
"""


def write_mysql_config(path: str = MYSQL_CNF_PATH) -> str:
    """Generate a tuned MySQL config based on detected system resources."""
    mem_gb = hardware.available_memory_gb()
    pool_mb = hardware.mysql_buffer_pool_mb(mem_gb)
    # MySQL docs recommend 1 instance per GB of buffer pool, max 16
    pool_instances = max(1, min(pool_mb // 1024, 16))

    content = MYSQL_CNF_TEMPLATE.format(
        memory_gb=mem_gb,
        buffer_pool_mb=pool_mb,
        buffer_pool_instances=pool_instances,
    )

    existing = None
    if os.path.exists(path):
        with open(path, "r", encoding="utf-8") as handle:
            existing = handle.read()

    if existing == content:
        return f"{path} already up to date"

    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as handle:
        handle.write(content)

    verb = "updated" if existing is not None else "created"
    return f"{verb} {path} (buffer_pool={pool_mb}MB for {mem_gb:.1f}GB RAM)"


def compose_services(path: str = COMPOSE_PATH) -> dict[str, Any]:
    """Services declared by hand in docker-compose.yml.

    Parsed as plain YAML rather than via `docker compose config` so that the
    check works with the daemon down; ${VAR} values stay unexpanded and are
    resolved through the same helper the manifest uses.
    """
    if not os.path.exists(path):
        return {}
    with open(path, "r", encoding="utf-8") as handle:
        raw = yaml.safe_load(handle) or {}
    return raw.get("services") or {}


def published_ports(service: dict[str, Any]) -> list[str]:
    """Host-side port specs of a compose service, as written."""
    result = []
    for entry in service.get("ports") or []:
        if isinstance(entry, dict):
            host = entry.get("published")
            if host is not None:
                result.append(str(host))
            continue
        parts = str(entry).split(":")
        if len(parts) >= 2:
            result.append(parts[-2])
    return result
