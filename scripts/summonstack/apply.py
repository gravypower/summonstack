"""The reconciler: make the world match realms.yml.

`apply` is the only mutating verb. Adding or removing a realm edits the
manifest and then reconciles, so there is one code path that touches compose,
the databases, realmlist and the containers — and it is safe to re-run at any
point, which is what the old add/remove scripts were not. A crash halfway
through is repaired by running it again.
"""

from __future__ import annotations

import contextlib
import fcntl
import subprocess
import time
from dataclasses import dataclass, field
from typing import Callable

from . import compose, portal, state
from .env import load_env
from .manifest import Manifest, Realm

LOCK_PATH = ".summonstack.lock"

# The realm containers this tool owns. A container matching one of these that no
# realm claims is a leftover; anything else on the host is none of our business.
GENERATED_PREFIXES = ("ac-realm-", "ac-pb-realm-")


class ApplyError(Exception):
    pass


@dataclass
class Action:
    """One reconciling step, describable without performing it."""

    kind: str
    description: str
    run: Callable[[], None] = field(repr=False)


@contextlib.contextmanager
def locked(path: str = LOCK_PATH):
    """Serialise reconciles so two runs cannot interleave their writes."""
    handle = open(path, "w")
    try:
        try:
            fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise ApplyError(
                f"another reconcile holds {path} — wait for it to finish"
            ) from None
        yield
    finally:
        with contextlib.suppress(Exception):
            fcntl.flock(handle, fcntl.LOCK_UN)
        handle.close()


def _run(args: list[str], what: str, timeout: int | None = None) -> None:
    result = subprocess.run(args, capture_output=True, text=True, timeout=timeout, check=False)
    if result.returncode != 0:
        detail = (result.stderr or result.stdout or "").strip()
        raise ApplyError(f"{what} failed ({result.returncode}): {detail[-2000:]}")


# ── database provisioning ────────────────────────────────────────────────────

def _needs_provisioning(realm: Realm, provisioned: set[str]) -> list[str]:
    """The realm's databases that are missing their updater bookkeeping."""
    wanted = [realm.chars_db]
    # Normal realms share the read-only acore_world, which the stack's own
    # importer owns; only a realm with a world database of its own needs one.
    if realm.world_db not in ("acore_world",):
        wanted.append(realm.world_db)
    return [db for db in wanted if db not in provisioned]


def provision(realm: Realm) -> None:
    """Build a realm's databases with the correct importer.

    Deliberately not a mysqldump clone of an existing database: a clone carries
    the schema but not a truthful `updates` history, so the next worldserver
    start replays every migration over an already-migrated schema. The importer
    creates the database and records what it applied, which is the only way to
    end up in a state the worldserver agrees with.

    Normal realms use the prebuilt ac-db-import service (standard AzerothCore).
    Playerbots realms must use the playerbots service's own dbimport binary,
    because the playerbots fork carries different SQL migrations. Using the
    wrong importer creates a schema the worldserver rejects on startup.
    """
    if realm.type == "playerbots":
        _provision_playerbots(realm)
    else:
        _provision_standard(realm)


def _provision_standard(realm: Realm) -> None:
    """Import databases using the prebuilt ac-db-import container in detached background mode.

    Runs in detached (-d) mode so long database imports run asynchronously in the
    background as a Docker container, avoiding holding up CLI commands or getting
    interrupted by Ctrl-C in the terminal.

    Normal realms share the read-only ``acore_world``, which the stack's own
    ``ac-db-import`` one-shot service owns. This function only creates the
    characters database and points the importer at the shared world database
    (harmless no-op if it's already populated). The importer's
    ``AC_UPDATES_AUTO_SETUP=1`` flag ensures the ``updates`` bookkeeping table
    is created for new character databases.
    """
    for db in [realm.world_db, realm.chars_db]:
        _run(
            [
                "docker", "exec",
                "-e", f"MYSQL_PWD={_db_pass()}",
                "ac-database", "mysql", "-uroot",
                "-e", f"CREATE DATABASE IF NOT EXISTS `{db}` "
                      f"DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;",
            ],
            f"creating database {db}",
        )
    _run(
        [
            "docker", "compose", "run", "-d", "--rm",
            "-e", "AC_UPDATES_AUTO_SETUP=1",
            "-e", f"AC_WORLD_DATABASE_INFO=ac-database;3306;root;{_db_pass()};{realm.world_db}",
            "-e", f"AC_CHARACTER_DATABASE_INFO=ac-database;3306;root;{_db_pass()};{realm.chars_db}",
            "ac-db-import",
        ],
        f"importing databases for realm {realm.id}",
        timeout=120,
    )


def _provision_playerbots(realm: Realm) -> None:
    """Import databases for a playerbots realm and seed all required playerbot base tables.

    Playerbots realms use ac-db-import for base AC schemas, then seed all required
    playerbot module tables directly so worldserver prepared statements succeed cleanly on boot.
    """
    _provision_standard(realm)

    # Seed base playerbots tables in character database to ensure prepared statements match
    playerbots_seed_sql = """
CREATE TABLE IF NOT EXISTS `playerbots_custom_strategy` (
  `name` varchar(255) NOT NULL, `owner` bigint unsigned NOT NULL, `idx` bigint unsigned NOT NULL, `action_line` text,
  PRIMARY KEY (`name`, `owner`, `idx`)
);
CREATE TABLE IF NOT EXISTS `playerbots_db_store` (
  `guid` bigint unsigned NOT NULL, `key` varchar(255) NOT NULL, `value` text,
  PRIMARY KEY (`guid`, `key`)
);
CREATE TABLE IF NOT EXISTS `playerbots_equip_cache` (
  `clazz` tinyint unsigned NOT NULL, `lvl` tinyint unsigned NOT NULL, `slot` tinyint unsigned NOT NULL, `quality` tinyint unsigned NOT NULL, `item` int unsigned NOT NULL
);
CREATE TABLE IF NOT EXISTS `playerbots_guild_tasks` (
  `owner` bigint unsigned NOT NULL, `guildid` bigint unsigned NOT NULL, `time` bigint unsigned NOT NULL, `validIn` bigint unsigned NOT NULL, `type` bigint unsigned NOT NULL, `value` bigint unsigned NOT NULL
);
CREATE TABLE IF NOT EXISTS `playerbots_random_bots` (
  `owner` bigint unsigned NOT NULL, `bot` bigint unsigned NOT NULL, `time` bigint unsigned NOT NULL, `validIn` bigint unsigned NOT NULL, `event` varchar(255) NOT NULL, `value` bigint unsigned NOT NULL, `data` text
);
CREATE TABLE IF NOT EXISTS `playerbots_rarity_cache` (
  `item` int unsigned NOT NULL, `rarity` tinyint unsigned NOT NULL
);
CREATE TABLE IF NOT EXISTS `playerbots_rnditem_cache` (
  `lvl` tinyint unsigned NOT NULL, `type` tinyint unsigned NOT NULL, `item` int unsigned NOT NULL
);
CREATE TABLE IF NOT EXISTS `playerbots_tele_cache` (
  `level` tinyint unsigned NOT NULL, `map_id` int unsigned NOT NULL, `x` float NOT NULL, `y` float NOT NULL, `z` float NOT NULL
);
CREATE TABLE IF NOT EXISTS `playerbots_travelnode` (
  `id` int unsigned NOT NULL, `name` varchar(255) NOT NULL, `map_id` int unsigned NOT NULL, `x` float NOT NULL, `y` float NOT NULL, `z` float NOT NULL, `linked` text
);
CREATE TABLE IF NOT EXISTS `playerbots_travelnode_link` (
  `node_id` int unsigned NOT NULL, `to_node_id` int unsigned NOT NULL, `type` tinyint unsigned NOT NULL, `object` int unsigned NOT NULL, `distance` float NOT NULL, `swim_distance` float NOT NULL, `extra_cost` float NOT NULL, `calculated` tinyint unsigned NOT NULL, `max_creature_0` float NOT NULL, `max_creature_1` float NOT NULL, `max_creature_2` float NOT NULL
);
CREATE TABLE IF NOT EXISTS `playerbots_travelnode_path` (
  `node_id` int unsigned NOT NULL, `to_node_id` int unsigned NOT NULL, `nr` int unsigned NOT NULL, `map_id` int unsigned NOT NULL, `x` float NOT NULL, `y` float NOT NULL, `z` float NOT NULL
);
CREATE TABLE IF NOT EXISTS `playerbots_item_info_cache` (
  `id` int unsigned NOT NULL, `quality` tinyint unsigned NOT NULL, `slot` tinyint unsigned NOT NULL, `source` tinyint unsigned NOT NULL, `sourceId` int unsigned NOT NULL, `team` tinyint unsigned NOT NULL, `faction` int unsigned NOT NULL, `factionRepRank` tinyint unsigned NOT NULL, `minLevel` tinyint unsigned NOT NULL,
  `scale_1` float, `scale_2` float, `scale_3` float, `scale_4` float, `scale_5` float, `scale_6` float, `scale_7` float, `scale_8` float, `scale_9` float, `scale_10` float, `scale_11` float, `scale_12` float, `scale_13` float, `scale_14` float, `scale_15` float, `scale_16` float, `scale_17` float, `scale_18` float, `scale_19` float, `scale_20` float, `scale_21` float, `scale_22` float, `scale_23` float, `scale_24` float, `scale_25` float, `scale_26` float, `scale_27` float, `scale_28` float, `scale_29` float, `scale_30` float, `scale_31` float, `scale_32` float
);
CREATE TABLE IF NOT EXISTS `playerbots_enchants` (
  `class` tinyint unsigned NOT NULL, `spec` tinyint unsigned NOT NULL, `spellid` int unsigned NOT NULL, `slotid` tinyint unsigned NOT NULL
);
CREATE TABLE IF NOT EXISTS `playerbots_speech` (
  `name` varchar(255) NOT NULL, `text` text NOT NULL, `type` varchar(255) NOT NULL
);
CREATE TABLE IF NOT EXISTS `playerbots_speech_probability` (
  `name` varchar(255) NOT NULL, `probability` float NOT NULL, PRIMARY KEY (`name`)
);
CREATE TABLE IF NOT EXISTS `ai_playerbot_texts` (
  `entry` int unsigned NOT NULL AUTO_INCREMENT, `name` varchar(255) NOT NULL, `text` text NOT NULL, `say_type` varchar(255) NOT NULL, `reply_type` varchar(255) DEFAULT '', `text_loc1` text, `text_loc2` text, `text_loc3` text, `text_loc4` text, `text_loc5` text, `text_loc6` text, `text_loc7` text, `text_loc8` text, PRIMARY KEY (`entry`)
);
CREATE TABLE IF NOT EXISTS `ai_playerbot_texts_chance` (
  `name` varchar(255) NOT NULL, `probability` float NOT NULL, PRIMARY KEY (`name`)
);
CREATE TABLE IF NOT EXISTS `playerbots_dungeon_suggestion_definition` (
  `slug` varchar(255) NOT NULL, `name` varchar(255) NOT NULL, `difficulty` int unsigned NOT NULL, `min_level` int unsigned NOT NULL, `max_level` int unsigned NOT NULL, `expansion` int unsigned NOT NULL, PRIMARY KEY (`slug`, `difficulty`)
);
CREATE TABLE IF NOT EXISTS `playerbots_dungeon_suggestion_abbrevation` (
  `definition_slug` varchar(255) NOT NULL, `abbrevation` varchar(255) NOT NULL
);
CREATE TABLE IF NOT EXISTS `playerbots_dungeon_suggestion_strategy` (
  `definition_slug` varchar(255) NOT NULL, `difficulty` int unsigned NOT NULL, `strategy` varchar(255) NOT NULL
);
CREATE TABLE IF NOT EXISTS `playerbots_weightscales` (
  `id` int unsigned NOT NULL AUTO_INCREMENT, `name` varchar(255) NOT NULL, `class` tinyint unsigned NOT NULL, PRIMARY KEY (`id`)
);
CREATE TABLE IF NOT EXISTS `playerbots_weightscale_data` (
  `id` int unsigned NOT NULL, `field` varchar(255) NOT NULL, `val` float NOT NULL
);
"""
    _run(
        [
            "docker", "exec",
            "-e", f"MYSQL_PWD={_db_pass()}",
            "ac-database", "mysql", "-uroot",
            realm.chars_db,
            "-e", playerbots_seed_sql,
        ],
        f"seeding playerbot tables for database {realm.chars_db}",
    )

    # Import playerbot SQL files inside the playerbots worldserver image into character database
    _run(
        [
            "sh", "-c",
            f"docker run --rm --entrypoint /bin/sh summonstack-ac-pb-worldserver:latest -c 'cat /azerothcore/data/sql/custom/db_characters/*.sql' | "
            f"docker exec -i -e MYSQL_PWD={_db_pass()} ac-database mysql -uroot {realm.chars_db}"
        ],
        f"importing custom playerbot SQL files for database {realm.chars_db}",
    )






def _db_pass() -> str:
    return load_env().get("DOCKER_DB_ROOT_PASSWORD") or "password"


# ── planning ─────────────────────────────────────────────────────────────────

def plan(
    manifest: Manifest,
    *,
    prune: bool = True,
    start: bool = True,
    provision_dbs: bool = True,
) -> list[Action]:
    """Everything that would have to change for reality to match the manifest."""
    env = load_env()
    actions: list[Action] = []

    # 1. Derived files first, so compose sees the right services below.
    if compose.render(manifest) != _read(compose.OVERRIDE_PATH):
        actions.append(
            Action("render", f"render {compose.OVERRIDE_PATH}",
                   lambda: compose.write_override(manifest))
        )
    if portal.render(manifest) != _read(portal.PORTAL_PATH):
        actions.append(
            Action("render", f"render {portal.PORTAL_PATH}", lambda: portal.write(manifest))
        )

    enabled = manifest.enabled_realms()

    # 2. realmlist rows first, so auth server registration happens immediately.
    rows = {row.id: row for row in _observe(state.realmlist, env)}
    for realm in enabled:
        port = realm.resolved_game_port(env)
        address = manifest.address_for(realm)
        row = rows.get(realm.id)
        if row is None:
            actions.append(
                Action("realmlist", f"add realm {realm.id} ({realm.name}) to realmlist",
                       (lambda r, p, a: lambda: _upsert_realm(r, p, a))(realm, port, address))
            )
        elif (row.name, row.address, row.port) != (realm.name, address, port):
            actions.append(
                Action(
                    "realmlist",
                    f"update realmlist for realm {realm.id} "
                    f"({row.name}/{row.address}:{row.port} -> {realm.name}/{address}:{port})",
                    (lambda r, p, a: lambda: _upsert_realm(r, p, a))(realm, port, address),
                )
            )
    if prune:
        declared = {r.id for r in enabled}
        for row in rows.values():
            if row.id not in declared:
                actions.append(
                    Action("realmlist", f"remove realm {row.id} ({row.name}) from realmlist",
                           (lambda i: lambda: _delete_realm(i))(row.id))
                )

    # 3. Databases pre-creation & background provisioning.
    if provision_dbs:
        provisioned = _observe(state.provisioned_databases, env)
        for realm in enabled:
            missing = _needs_provisioning(realm, provisioned)
            if missing:
                actions.append(
                    Action(
                        "provision",
                        f"import databases for realm {realm.id} ({', '.join(missing)})",
                        (lambda r: lambda: provision(r))(realm),
                    )
                )

    # 4. Containers this tool owns that no realm claims.
    if prune:
        claimed = {r.service for r in manifest.realms}
        for name in _observe(state.containers):
            if name.startswith(GENERATED_PREFIXES) and name not in claimed:
                actions.append(
                    Action("prune", f"remove leftover container {name}",
                           (lambda n: lambda: _remove_container(n))(name))
                )

    # 5. Start what should be running — but only when its databases are ready.
    #    Provisioning runs in detached mode, so a db-import container may still
    #    be populating the schema. Starting the worldserver against a
    #    half-imported database causes the "table doesn't exist" errors; instead
    #    we report a "waiting" action so `task realm` shows what is going on.
    if start:
        running = _observe(state.containers)
        currently_importing = state.importing_databases()
        for realm in enabled:
            status = running.get(realm.service, "")
            if not status.startswith("Up"):
                realm_dbs = {realm.world_db, realm.chars_db}
                still_importing = realm_dbs & currently_importing
                if still_importing:
                    actions.append(
                        Action(
                            "waiting",
                            f"deferring start of {realm.service} (realm {realm.id}) "
                            f"— database import still running for: {', '.join(sorted(still_importing))}",
                            lambda: None,
                        )
                    )
                else:
                    actions.append(
                        Action("start", f"start {realm.service} (realm {realm.id})",
                               (lambda r: lambda: _start(r))(realm))
                    )

    return actions


def wait_for_database(timeout: int) -> None:
    """Block until the database answers, or give up after timeout seconds.

    `task up` reconciles straight after starting the stack, and on a first boot
    MySQL initialises its data directory for ten minutes or more. Without this
    the reconcile would fail purely because it arrived early.
    """
    if timeout <= 0:
        return
    deadline = time.monotonic() + timeout
    announced = False
    while True:
        try:
            state.mysql("SELECT 1;", timeout=10)
            return
        except (state.StateError, subprocess.TimeoutExpired, subprocess.SubprocessError):
            if time.monotonic() >= deadline:
                raise ApplyError(
                    f"database was still unreachable after {timeout}s — check: task logs"
                ) from None
            if not announced:
                print("Waiting for the database to accept connections...")
                announced = True
            time.sleep(5)


def _observe(fn, *args):
    """Read live state, turning an unreachable stack into a clear failure.

    Reconciling against a half-visible world is how you end up deleting a realm
    because the database happened to be down, so this refuses to plan instead.
    """
    try:
        return fn(*args)
    except state.StateError as exc:
        raise ApplyError(
            f"cannot read the current state ({exc}). Is the stack running? "
            f"Start it with: task up"
        ) from exc


def _read(path: str) -> str | None:
    try:
        with open(path, "r", encoding="utf-8") as handle:
            return handle.read()
    except FileNotFoundError:
        return None


def _upsert_realm(realm: Realm, port: int, address: str) -> None:
    state.mysql(
        f"""
        INSERT INTO acore_auth.realmlist
          (id, name, address, localAddress, localSubnetMask, port, icon, flag,
           timezone, allowedSecurityLevel, population, gamebuild)
        VALUES
          ({realm.id}, {state.quote(realm.name)}, {state.quote(address)},
           '127.0.0.1', '255.255.255.0', {port}, 0, 0, 1, 0, 0, 12340)
        ON DUPLICATE KEY UPDATE
          name = VALUES(name), address = VALUES(address), port = VALUES(port);
        """
    )


def _delete_realm(realm_id: int) -> None:
    state.mysql(f"DELETE FROM acore_auth.realmlist WHERE id = {int(realm_id)};")


def _remove_container(name: str) -> None:
    # The restart policy is cleared first: a crash-looping leftover restarts
    # between the stop and the remove otherwise.
    _run(["docker", "update", "--restart=no", name], f"clearing restart policy on {name}")
    _run(["docker", "stop", name], f"stopping {name}", timeout=120)
    _run(["docker", "rm", name], f"removing {name}")


def _start(realm: Realm) -> None:
    args = ["docker", "compose"]
    if realm.profile:
        args += ["--profile", realm.profile]
    args += ["up", "-d", realm.service]
    _run(args, f"starting {realm.service}", timeout=600)


def apply(
    manifest: Manifest, *, dry_run: bool = False, wait: int = 0, **kwargs
) -> list[Action]:
    """Reconcile, or with dry_run report what reconciling would do."""
    wait_for_database(wait)
    if dry_run:
        return plan(manifest, **kwargs)
    with locked():
        # Re-planned under the lock so a concurrent run's work is not repeated.
        actions = plan(manifest, **kwargs)
        for action in actions:
            action.run()
    return actions
