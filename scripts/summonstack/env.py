"""Reading .env and expanding the ${VAR:-default} syntax compose uses.

The manifest stores ports exactly as docker-compose.yml writes them, so that a
port lives in .env once rather than being copied into a second file that then
drifts.
"""

from __future__ import annotations

import os
import re

# Deliberately only the two forms compose files in this repo use. ${VAR} and
# ${VAR:-default}; anything else is left alone rather than half-supported.
_VAR_RE = re.compile(r"\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}")


def load_env(path: str = ".env") -> dict[str, str]:
    """Parse .env the way compose does: KEY=VALUE, # comments, no expansion."""
    env: dict[str, str] = {}
    if not os.path.exists(path):
        return env
    with open(path, "r", encoding="utf-8") as handle:
        for raw in handle:
            line = raw.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, _, value = line.partition("=")
            env[key.strip()] = value.strip()
    return env


def expand(value: str, env: dict[str, str]) -> str:
    """Substitute ${VAR} / ${VAR:-default} from env.

    An empty value in .env counts as unset, matching compose's :- operator —
    PLAYERBOTS_MODE= is empty in this repo and must fall through to the default.
    """

    def replace(match: re.Match[str]) -> str:
        name, default = match.group(1), match.group(2)
        current = env.get(name) or os.environ.get(name)
        if current:
            return current
        return default or ""

    return _VAR_RE.sub(replace, value)


def resolve_port(value: object, env: dict[str, str]) -> int:
    """Resolve a manifest port field to the integer compose would publish."""
    text = expand(str(value), env).strip()
    try:
        return int(text)
    except ValueError as exc:
        raise ValueError(f"{value!r} does not resolve to a port number") from exc
