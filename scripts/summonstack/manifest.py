"""The realm manifest: what realms exist, and everything that defines them.

realms.yml is the single source of truth. The compose override, the realmlist
rows and the portal's per-realm config are all derived from it — nothing else
gets to invent a port, a database name or a container name.
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from typing import Any

import yaml

from .env import load_env, resolve_port

MANIFEST_PATH = "realms.yml"

TYPES = ("normal", "playerbots")
# "compose" realms are declared in docker-compose.yml by hand (realms 1 and 2,
# which carry the profiles and import dependencies that bootstrap the stack).
# "generated" realms are rendered into docker-compose.override.yml.
MANAGED = ("compose", "generated")

HEADER = """\
# SummonStack realm manifest — the single source of truth for what realms exist.
#
# Everything downstream is derived from this file:
#   docker-compose.override.yml   generated  (task realm:render)
#   acore_auth.realmlist          written by task realm:add / realm:remove
#   the portal's per-realm config still guesses from the id — phase 3 moves it here
#
# Ports may use the ${VAR:-default} syntax, so a value lives in .env once
# instead of being copied here and drifting.
#
#   managed: compose    declared by hand in docker-compose.yml
#   managed: generated  rendered into docker-compose.override.yml
#   enabled: false      declared but not meant to be running or in realmlist
#
# NOTE: `task realm:add` and `task realm:remove` rewrite this file. The header
# survives; comments you add further down do not.
"""


class ManifestError(Exception):
    """Raised with every problem found, not just the first."""

    def __init__(self, problems: list[str]):
        self.problems = problems
        super().__init__("\n".join(problems))


@dataclass
class Realm:
    id: int
    name: str
    type: str = "normal"
    service: str = ""
    managed: str = "generated"
    enabled: bool = True
    address: str | None = None
    game_port: Any = 8085
    soap_port: Any = 7878
    world_db: str = "acore_world"
    chars_db: str = "acore_characters"
    # Compose profile gating the service, for hand-declared realms only.
    profile: str | None = None
    # Extra AC_* environment overrides merged into the generated service.
    settings: dict[str, str] = field(default_factory=dict)

    def resolved_game_port(self, env: dict[str, str]) -> int:
        return resolve_port(self.game_port, env)

    def resolved_soap_port(self, env: dict[str, str]) -> int:
        return resolve_port(self.soap_port, env)

    def to_dict(self) -> dict[str, Any]:
        data: dict[str, Any] = {
            "id": self.id,
            "name": self.name,
            "type": self.type,
            "service": self.service,
            "managed": self.managed,
        }
        if not self.enabled:
            data["enabled"] = False
        if self.address:
            data["address"] = self.address
        data["game_port"] = self.game_port
        data["soap_port"] = self.soap_port
        data["world_db"] = self.world_db
        data["chars_db"] = self.chars_db
        if self.profile:
            data["profile"] = self.profile
        if self.settings:
            data["settings"] = dict(self.settings)
        return data


@dataclass
class Manifest:
    version: int = 1
    defaults: dict[str, Any] = field(default_factory=dict)
    realms: list[Realm] = field(default_factory=list)

    def by_id(self, realm_id: int) -> Realm | None:
        return next((r for r in self.realms if r.id == realm_id), None)

    def enabled_realms(self) -> list[Realm]:
        return [r for r in self.realms if r.enabled]

    def generated_realms(self) -> list[Realm]:
        return [r for r in self.realms if r.managed == "generated"]

    def address_for(self, realm: Realm) -> str:
        return realm.address or str(self.defaults.get("address") or "127.0.0.1")


def find(manifest: "Manifest", token: str) -> "Realm | None":
    """Resolve the tokens people actually type to a realm.

    An id, a service name, a realm name, or one of the aliases the old task
    runner hard-coded into `case` statements. Every consumer looks the answer up
    here instead of re-deriving container names from the id.
    """
    key = (token or "").strip()
    if not key or key in ("main", "standard", "default"):
        return manifest.by_id(1) or (manifest.realms[0] if manifest.realms else None)
    if key.isdigit():
        return manifest.by_id(int(key))
    if key in ("pb", "playerbots", "bots"):
        return next((r for r in manifest.realms if r.type == "playerbots"), None)
    lowered = key.lower()
    return next(
        (r for r in manifest.realms if r.service.lower() == lowered or r.name.lower() == lowered),
        None,
    )


def default_service(realm_id: int, realm_type: str) -> str:
    prefix = "ac-pb-realm" if realm_type == "playerbots" else "ac-realm"
    return f"{prefix}-{realm_id}"


def default_databases(realm_id: int, realm_type: str, shared: bool = False) -> tuple[str, str]:
    """(world_db, chars_db) for a new realm.

    Playerbot realms need their own world database because the module writes to
    it; normal realms share the read-only acore_world. `shared` is the old
    CREATE_DB=0 behaviour — point the realm at the existing databases instead of
    provisioning it a character database of its own.
    """
    if realm_type == "playerbots":
        if shared:
            return "acore_world_pb", "acore_characters_pb"
        return f"acore_world_pb_{realm_id}", f"acore_characters_pb_{realm_id}"
    if shared:
        return "acore_world", "acore_characters"
    return "acore_world", f"acore_characters_{realm_id}"


def load(path: str = MANIFEST_PATH) -> Manifest:
    if not os.path.exists(path):
        raise ManifestError([f"{path} not found — run: task realm:init"])
    with open(path, "r", encoding="utf-8") as handle:
        raw = yaml.safe_load(handle) or {}
    if not isinstance(raw, dict):
        raise ManifestError([f"{path} must be a YAML mapping"])

    realms = []
    for index, entry in enumerate(raw.get("realms") or []):
        if not isinstance(entry, dict):
            raise ManifestError([f"realms[{index}] must be a mapping"])
        unknown = set(entry) - set(Realm.__dataclass_fields__)
        if unknown:
            raise ManifestError(
                [f"realms[{index}] has unknown key(s): {', '.join(sorted(unknown))}"]
            )
        realms.append(Realm(**entry))

    manifest = Manifest(
        version=int(raw.get("version", 1)),
        defaults=raw.get("defaults") or {},
        realms=realms,
    )
    validate(manifest)
    return manifest


def save(manifest: Manifest, path: str = MANIFEST_PATH) -> None:
    validate(manifest)
    body = yaml.safe_dump(
        {
            "version": manifest.version,
            "defaults": manifest.defaults,
            "realms": [r.to_dict() for r in sorted(manifest.realms, key=lambda r: r.id)],
        },
        sort_keys=False,
        default_flow_style=False,
        width=100,
    )
    with open(path, "w", encoding="utf-8") as handle:
        handle.write(HEADER + "\n" + body)


def validate(manifest: Manifest) -> None:
    """Every structural rule, reported together rather than one per run."""
    problems: list[str] = []
    env = load_env()

    seen_ids: dict[int, int] = {}
    seen_names: dict[str, int] = {}
    seen_services: dict[str, int] = {}
    # Game and SOAP ports share one host namespace, so they are checked together.
    seen_ports: dict[int, str] = {}

    for realm in manifest.realms:
        label = f"realm {realm.id}"

        if not isinstance(realm.id, int) or realm.id < 1:
            problems.append(f"{label}: id must be a positive integer")
        if not str(realm.name).strip():
            problems.append(f"{label}: name is required")
        elif any(ch in str(realm.name) for ch in "'\"\\`"):
            # The name reaches SQL and shell on its way into realmlist. Refusing
            # quotes at the source is what keeps every consumer safe, rather
            # than each one having to remember to escape.
            problems.append(f"{label}: name must not contain quotes or backslashes")
        elif len(str(realm.name)) > 32:
            # realmlist.name is varchar(32); a longer name is silently truncated
            # and then never matches what the manifest claims.
            problems.append(f"{label}: name must be 32 characters or fewer")
        if realm.type not in TYPES:
            problems.append(f"{label}: type must be one of {', '.join(TYPES)}")
        if realm.managed not in MANAGED:
            problems.append(f"{label}: managed must be one of {', '.join(MANAGED)}")
        if not realm.service.strip():
            problems.append(f"{label}: service is required")
        if not realm.world_db.strip() or not realm.chars_db.strip():
            problems.append(f"{label}: world_db and chars_db are required")
        if realm.type == "playerbots" and realm.world_db == "acore_world":
            problems.append(
                f"{label}: a playerbots realm needs its own world_db — the module "
                f"writes to it and would corrupt the shared acore_world"
            )

        if realm.id in seen_ids:
            problems.append(f"{label}: duplicate id (also realms[{seen_ids[realm.id]}])")
        seen_ids[realm.id] = realm.id

        if realm.name in seen_names:
            problems.append(f"{label}: duplicate name {realm.name!r}")
        seen_names[realm.name] = realm.id

        if realm.service in seen_services:
            problems.append(f"{label}: duplicate service {realm.service!r}")
        seen_services[realm.service] = realm.id

        for kind, value in (("game", realm.game_port), ("soap", realm.soap_port)):
            try:
                port = resolve_port(value, env)
            except ValueError as exc:
                problems.append(f"{label}: {kind}_port {exc}")
                continue
            if not 1 <= port <= 65535:
                problems.append(f"{label}: {kind}_port {port} out of range")
            owner = seen_ports.get(port)
            if owner:
                problems.append(f"{label}: {kind}_port {port} already used by {owner}")
            seen_ports[port] = f"realm {realm.id} {kind}_port"

    if problems:
        raise ManifestError(problems)


def allocate(
    manifest: Manifest,
    realm_type: str,
    name: str | None = None,
    realm_id: int | None = None,
    game_port: int | None = None,
    soap_port: int | None = None,
    address: str | None = None,
    share_databases: bool = False,
) -> Realm:
    """Build a new realm, resolving id/name/ports against the manifest.

    Resolution happens here and only here. The old two-stage flow resolved a
    port to write into realmlist and then resolved it again when writing the
    compose service, so the advertised port could differ from the published one.
    """
    env = load_env()
    taken_ids = {r.id for r in manifest.realms}
    taken_names = {r.name for r in manifest.realms}
    taken_ports: set[int] = set()
    for realm in manifest.realms:
        taken_ports.add(realm.resolved_game_port(env))
        taken_ports.add(realm.resolved_soap_port(env))

    resolved_id = realm_id if realm_id and realm_id not in taken_ids else None
    if resolved_id is None:
        resolved_id = max(taken_ids, default=0) + 1
        while resolved_id in taken_ids:
            resolved_id += 1

    base = (name or "").strip() or (
        f"Playerbots Realm {resolved_id}"
        if realm_type == "playerbots"
        else f"Realm {resolved_id}"
    )
    resolved_name = base
    suffix = 2
    while resolved_name in taken_names:
        resolved_name = f"{base} ({suffix})"
        suffix += 1

    def pick(preferred: int | None, fallback: int) -> int:
        candidate = preferred or fallback
        while candidate in taken_ports:
            candidate += 1
        taken_ports.add(candidate)
        return candidate

    resolved_game = pick(game_port, 8085 + resolved_id - 1)
    resolved_soap = pick(soap_port, 7878 + resolved_id - 1)
    world_db, chars_db = default_databases(resolved_id, realm_type, share_databases)

    return Realm(
        id=resolved_id,
        name=resolved_name,
        type=realm_type,
        service=default_service(resolved_id, realm_type),
        managed="generated",
        address=address.strip() if address and address.strip() else None,
        game_port=resolved_game,
        soap_port=resolved_soap,
        world_db=world_db,
        chars_db=chars_db,
    )
