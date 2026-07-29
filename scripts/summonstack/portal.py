"""Exporting the manifest for the web portal.

The portal used to derive a realm's container name and databases from its id,
guessing `ac-realm${id}-worldserver` while the generator produced
`ac-realm-${id}` — so it could not reach any realm it had not been special-cased
for. It now reads this file instead of guessing.

JSON rather than the YAML manifest itself so the portal needs no YAML parser,
and camelCase keys so it needs no mapping layer either.
"""

from __future__ import annotations

import json
import os

from .manifest import Manifest

PORTAL_DIR = os.path.join("webapp", "generated")
PORTAL_PATH = os.path.join(PORTAL_DIR, "realms.json")

# Ports *inside* the container, which is how the portal reaches a realm over
# ac-network. Deliberately not the manifest's game_port/soap_port: those are
# published on the host for players and admins, and are different numbers.
INTERNAL_WORLD_PORT = 8085
INTERNAL_SOAP_PORT = 7878


def build(manifest: Manifest) -> dict:
    return {
        "version": 1,
        "generatedBy": "task realm:render",
        "realms": [
            {
                "id": realm.id,
                "name": realm.name,
                "type": realm.type,
                "enabled": realm.enabled,
                "service": realm.service,
                "worldDb": realm.world_db,
                "charsDb": realm.chars_db,
                # The compose service name doubles as the network alias, so it
                # is the host to dial for both the TCP probe and SOAP.
                "worldHost": realm.service,
                "worldPort": INTERNAL_WORLD_PORT,
                "soapUrl": f"http://{realm.service}:{INTERNAL_SOAP_PORT}",
            }
            for realm in sorted(manifest.realms, key=lambda r: r.id)
        ],
    }


def render(manifest: Manifest) -> str:
    """The exact file contents, so callers can compare without writing."""
    return json.dumps(build(manifest), indent=2) + "\n"


def write(manifest: Manifest, path: str = PORTAL_PATH) -> str:
    """Write the portal manifest, returning a one-line description."""
    content = render(manifest)
    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)

    existing = None
    if os.path.exists(path):
        with open(path, "r", encoding="utf-8") as handle:
            existing = handle.read()
    if existing == content:
        return f"{path} already up to date"

    with open(path, "w", encoding="utf-8") as handle:
        handle.write(content)
    return f"{'updated' if existing is not None else 'created'} {path}"
