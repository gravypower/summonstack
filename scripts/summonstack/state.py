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


def active_importers() -> dict[str, dict[str, str]]:
    """Detect running database importer containers and their current progress."""
    res = subprocess.run(
        ["docker", "ps", "--filter", "name=db-import", "--format", "{{.Names}}\t{{.Status}}"],
        capture_output=True,
        text=True,
        check=False,
    )
    importers = {}
    if res.returncode == 0:
        for line in res.stdout.splitlines():
            parts = line.split("\t")
            if len(parts) >= 2:
                name, status_str = parts[0], parts[1]
                log_res = subprocess.run(
                    ["docker", "logs", "--tail", "10", name],
                    capture_output=True,
                    text=True,
                    check=False,
                )
                logs = (log_res.stdout or log_res.stderr or "").strip().splitlines()
                last_line = ""
                for l in reversed(logs):
                    if "Applying" in l:
                        last_line = l.strip()
                        break
                if not last_line and logs:
                    last_line = logs[-1].strip()
                importers[name] = {"status": status_str, "last_log": last_line}
    return importers


def importing_databases() -> set[str]:
    """Database names actively being populated by a running db-import container.

    Inspects the AC_*_DATABASE_INFO environment variables of every running
    container whose name contains 'db-import'. The info string is the
    AzerothCore semicolon-delimited format: ``host;port;user;pass;database``.

    Returns the set of database names (e.g. ``{"acore_characters_1"}``).
    """
    res = subprocess.run(
        [
            "docker", "ps", "-q",
            "--filter", "name=db-import",
        ],
        capture_output=True,
        text=True,
        check=False,
    )
    if res.returncode != 0 or not res.stdout.strip():
        return set()

    ids = res.stdout.strip().splitlines()
    dbs: set[str] = set()
    for cid in ids:
        inspect = subprocess.run(
            [
                "docker", "inspect",
                "--format",
                '{{range .Config.Env}}{{println .}}{{end}}',
                cid.strip(),
            ],
            capture_output=True,
            text=True,
            check=False,
        )
        if inspect.returncode != 0:
            continue
        for env_line in inspect.stdout.splitlines():
            # AC_WORLD_DATABASE_INFO=host;port;user;pass;dbname
            # AC_CHARACTER_DATABASE_INFO=host;port;user;pass;dbname
            for prefix in ("AC_WORLD_DATABASE_INFO=", "AC_CHARACTER_DATABASE_INFO="):
                if env_line.startswith(prefix):
                    info = env_line[len(prefix):]
                    parts = info.split(";")
                    if len(parts) >= 5:
                        dbs.add(parts[4])
    return dbs
