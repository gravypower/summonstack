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
    """Build a realm's databases with the AzerothCore importer.

    Deliberately not a mysqldump clone of an existing database: a clone carries
    the schema but not a truthful `updates` history, so the next worldserver
    start replays every migration over an already-migrated schema. The importer
    creates the database and records what it applied, which is the only way to
    end up in a state the worldserver agrees with.
    """
    _run(
        [
            "docker", "compose", "run", "--rm",
            "-e", "AC_UPDATES_AUTO_SETUP=1",
            "-e", f"AC_WORLD_DATABASE_INFO=ac-database;3306;root;{_db_pass()};{realm.world_db}",
            "-e", f"AC_CHARACTER_DATABASE_INFO=ac-database;3306;root;{_db_pass()};{realm.chars_db}",
            "ac-db-import",
        ],
        f"importing databases for realm {realm.id}",
        timeout=1800,
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

    # 2. Databases, before anything tries to start against them.
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

    # 3. realmlist rows.
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

    # 4. Containers this tool owns that no realm claims.
    if prune:
        claimed = {r.service for r in manifest.realms}
        for name in _observe(state.containers):
            if name.startswith(GENERATED_PREFIXES) and name not in claimed:
                actions.append(
                    Action("prune", f"remove leftover container {name}",
                           (lambda n: lambda: _remove_container(n))(name))
                )

    # 5. Start what should be running.
    if start:
        running = _observe(state.containers)
        for realm in enabled:
            status = running.get(realm.service, "")
            if not status.startswith("Up"):
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
