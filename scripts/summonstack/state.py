"""Observed state: what the database and Docker actually contain.

Read-only. The manifest says what should exist; this says what does, and the
difference between the two is what `task realm:check` reports.
"""

from __future__ import annotations

import subprocess
from dataclasses import dataclass

from .env import load_env

DB_CONTAINER = "ac-database"


class StateError(Exception):
    pass


@dataclass
class RealmRow:
    id: int
    name: str
    address: str
    port: int


def _db_password(env: dict[str, str]) -> str:
    return env.get("DOCKER_DB_ROOT_PASSWORD") or "password"


def mysql(sql: str, env: dict[str, str] | None = None, timeout: int = 30) -> str:
    """Run a query as root in the database container, returning tab-separated rows.

    The password goes through MYSQL_PWD rather than argv so it stays out of the
    process list and out of the warning mysql prints for -p.
    """
    env = env if env is not None else load_env()
    result = subprocess.run(
        [
            "docker", "exec",
            "-e", f"MYSQL_PWD={_db_password(env)}",
            DB_CONTAINER,
            "mysql", "-uroot", "-sN", "-e", sql,
        ],
        capture_output=True,
        text=True,
        timeout=timeout,
        check=False,
    )
    if result.returncode != 0:
        raise StateError(result.stderr.strip() or f"mysql exited {result.returncode}")
    return result.stdout


_ESCAPES = {
    "\\": "\\\\",
    "'": "\\'",
    '"': '\\"',
    "\n": "\\n",
    "\r": "\\r",
    "\x00": "\\0",
    "\x1a": "\\Z",
}


def quote(value: str) -> str:
    """A single-quoted SQL literal.

    There is no MySQL driver here — queries go through the mysql client in the
    database container — so values are escaped rather than bound. The manifest
    validator also refuses quotes and backslashes in realm names, which keeps
    the dangerous characters out well before this point.
    """
    return "'" + "".join(_ESCAPES.get(ch, ch) for ch in str(value)) + "'"


def provisioned_databases(env: dict[str, str] | None = None) -> set[str]:
    """Databases carrying the updater's bookkeeping table.

    A database without it has either never been imported or was cloned without
    its history, which is the state that makes a worldserver replay every update
    over an already-migrated schema and die partway through.
    """
    output = mysql(
        "SELECT table_schema FROM information_schema.tables "
        "WHERE table_name = 'updates';",
        env,
    )
    return {line.strip() for line in output.splitlines() if line.strip()}


def realmlist(env: dict[str, str] | None = None) -> list[RealmRow]:
    output = mysql("SELECT id, name, address, port FROM acore_auth.realmlist ORDER BY id;", env)
    rows = []
    for line in output.splitlines():
        if not line.strip():
            continue
        cols = line.split("\t")
        if len(cols) >= 4:
            rows.append(RealmRow(int(cols[0]), cols[1], cols[2], int(cols[3])))
    return rows


def databases(env: dict[str, str] | None = None) -> dict[str, int]:
    """Database name -> table count, for spotting half-built schemas."""
    output = mysql(
        "SELECT table_schema, COUNT(*) FROM information_schema.tables "
        "GROUP BY table_schema;",
        env,
    )
    result = {}
    for line in output.splitlines():
        cols = line.split("\t")
        if len(cols) >= 2:
            result[cols[0]] = int(cols[1])
    return result


def containers() -> dict[str, str]:
    """Container name -> status line, for every container on the host."""
    result = subprocess.run(
        ["docker", "ps", "-a", "--format", "{{.Names}}\t{{.Status}}"],
        capture_output=True,
        text=True,
        check=False,
    )
    if result.returncode != 0:
        raise StateError(result.stderr.strip() or "docker ps failed")
    status = {}
    for line in result.stdout.splitlines():
        name, _, state = line.partition("\t")
        if name:
            status[name] = state
    return status
