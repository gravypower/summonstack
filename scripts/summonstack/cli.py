"""Command line for the realm manifest.

    python3 -m scripts.summonstack list      what the manifest declares, plus live status
    python3 -m scripts.summonstack render    regenerate docker-compose.override.yml
    python3 -m scripts.summonstack check     report drift between manifest and reality
    python3 -m scripts.summonstack add       add a realm to the manifest and re-render
    python3 -m scripts.summonstack remove    drop a realm from the manifest and re-render

Phase 1 scope: the manifest and the compose override only. Creating databases,
writing realmlist rows and pruning containers still live in tasks/realm.yml and
move here in phase 2 — `check` reports the resulting drift in the meantime.
"""

from __future__ import annotations

import argparse
import json
import shlex
import sys

from . import apply as ap, compose, manifest as mf, portal, state
from .env import load_env, resolve_port


def _render_all(manifest: mf.Manifest) -> list[str]:
    """Every derived artifact, regenerated together.

    Kept in one place so adding a realm can never update the compose override
    while leaving the portal's copy behind.
    """
    return [compose.write_override(manifest), portal.write(manifest)]


def _load() -> mf.Manifest:
    try:
        return mf.load()
    except mf.ManifestError as exc:
        print("realms.yml is not valid:", file=sys.stderr)
        for problem in exc.problems:
            print(f"  - {problem}", file=sys.stderr)
        raise SystemExit(1)


def _is_ready(port: int) -> bool:
    import socket
    try:
        with socket.create_connection(("127.0.0.1", port), timeout=0.4):
            return True
    except (OSError, socket.timeout):
        return False


def cmd_list(args: argparse.Namespace) -> int:
    manifest = _load()
    env = load_env()
    try:
        status = state.containers()
    except state.StateError:
        status = {}
    try:
        table_counts = state.databases(env)
    except state.StateError:
        table_counts = {}
    try:
        importers = state.active_importers()
    except state.StateError:
        importers = {}

    print(f"{'ID':<4} {'NAME':<26} {'TYPE':<11} {'GAME':<6} {'SOAP':<6} {'SERVICE':<18} STATUS")
    print("─" * 92)
    for realm in sorted(manifest.realms, key=lambda r: r.id):
        game_port = realm.resolved_game_port(env)
        live = status.get(realm.service)
        if live and live.startswith("Up"):
            if _is_ready(game_port):
                live_status = f"Ready ({live})"
            else:
                live_status = f"Initializing ({live})"
        elif live:
            live_status = live
        elif importers:
            world_tables = table_counts.get(realm.world_db, 0)
            live_status = f"importing DB ({realm.world_db}: {world_tables} tables)"
        elif realm.world_db not in table_counts or table_counts[realm.world_db] < 20:
            live_status = f"missing DB ({realm.world_db})"
        elif realm.chars_db not in table_counts or table_counts[realm.chars_db] < 10:
            live_status = f"missing DB ({realm.chars_db})"
        else:
            live_status = "stopped"

        if not realm.enabled:
            live_status = f"disabled ({live_status})"
        print(
            f"{realm.id:<4} {realm.name[:26]:<26} {realm.type:<11} "
            f"{game_port:<6} {realm.resolved_soap_port(env):<6} "
            f"{realm.service:<18} {live_status}"
        )
    if not manifest.realms:
        print("(no realms declared)")

    if importers:
        print("\n── Active Operations ──")
        for name, info in importers.items():
            print(f"  [Importer] {name}: {info['status']}")
            if info['last_log']:
                print(f"             {info['last_log']}")
    return 0


def cmd_render(args: argparse.Namespace) -> int:
    manifest = _load()
    for line in _render_all(manifest):
        print(line)
    return 0


def cmd_check(args: argparse.Namespace) -> int:
    """Compare the manifest against docker-compose.yml, realmlist and Docker."""
    manifest = _load()
    env = load_env()
    findings: list[str] = []

    # 1. Hand-declared realms must actually be declared, on the ports claimed.
    services = compose.compose_services()
    for realm in manifest.realms:
        if realm.managed != "compose":
            continue
        service = services.get(realm.service)
        if service is None:
            findings.append(
                f"realm {realm.id}: managed as 'compose' but {realm.service} is not "
                f"in docker-compose.yml"
            )
            continue
        resolved_declared = set()
        for spec in compose.published_ports(service):
            try:
                resolved_declared.add(resolve_port(spec, env))
            except ValueError:
                pass
        for kind, port in (
            ("game", realm.resolved_game_port(env)),
            ("soap", realm.resolved_soap_port(env)),
        ):
            if resolved_declared and port not in resolved_declared:
                findings.append(
                    f"realm {realm.id}: manifest {kind}_port {port} is not published by "
                    f"{realm.service} (declares {sorted(resolved_declared)})"
                )

    # 2. The override on disk must match what the manifest renders.
    rendered = compose.render(manifest)
    try:
        with open(compose.OVERRIDE_PATH, "r", encoding="utf-8") as handle:
            on_disk = handle.read()
    except FileNotFoundError:
        on_disk = None
    if rendered != on_disk:
        findings.append(
            f"{compose.OVERRIDE_PATH} is stale — run: task realm:render"
        )

    # 2b. The portal reads its own copy, which must not lag behind either.
    try:
        with open(portal.PORTAL_PATH, "r", encoding="utf-8") as handle:
            portal_on_disk = json.load(handle)
    except (FileNotFoundError, json.JSONDecodeError):
        portal_on_disk = None
    if portal_on_disk != portal.build(manifest):
        findings.append(
            f"{portal.PORTAL_PATH} is stale — the portal will use the wrong "
            f"service or database names. Run: task realm:render"
        )

    # 3. realmlist must hold exactly the enabled realms, with matching values.
    try:
        rows = {row.id: row for row in state.realmlist(env)}
    except state.StateError as exc:
        findings.append(f"could not read realmlist ({exc}) — is ac-database running?")
        rows = None

    if rows is not None:
        for realm in manifest.enabled_realms():
            row = rows.get(realm.id)
            if row is None:
                findings.append(f"realm {realm.id} ({realm.name}) is missing from realmlist")
                continue
            port = realm.resolved_game_port(env)
            if row.port != port:
                findings.append(
                    f"realm {realm.id}: realmlist advertises port {row.port}, "
                    f"manifest publishes {port}"
                )
            if row.name != realm.name:
                findings.append(
                    f"realm {realm.id}: realmlist name {row.name!r} != manifest {realm.name!r}"
                )
            expected_address = manifest.address_for(realm)
            if row.address != expected_address:
                findings.append(
                    f"realm {realm.id}: realmlist address {row.address} != "
                    f"manifest {expected_address}"
                )
        declared_ids = {r.id for r in manifest.enabled_realms()}
        for row in rows.values():
            if row.id not in declared_ids:
                findings.append(
                    f"realmlist has realm {row.id} ({row.name}) with no enabled entry "
                    f"in realms.yml"
                )

    # 4. Containers that no realm claims, and realms with no container.
    try:
        running = state.containers()
    except state.StateError:
        running = {}
    claimed = {r.service for r in manifest.realms}
    for name in running:
        if (name.startswith("ac-realm-") or name.startswith("ac-pb-realm-")) and name not in claimed:
            findings.append(f"container {name} belongs to no realm in realms.yml")

    # 5. Databases that look half-built.
    try:
        table_counts = state.databases(env)
    except state.StateError:
        table_counts = {}
    for realm in manifest.enabled_realms():
        for kind, name in (("world", realm.world_db), ("chars", realm.chars_db)):
            if name not in table_counts:
                findings.append(f"realm {realm.id}: {kind} database {name} does not exist")
            elif table_counts[name] < 20:
                findings.append(
                    f"realm {realm.id}: {kind} database {name} has only "
                    f"{table_counts[name]} tables — looks half-built"
                )

    # 6. Databases left behind by realms that no longer exist. The reconcile
    # never drops a database on its own, so these are reported rather than
    # removed — dropping one is always a deliberate act.
    referenced = {"acore_auth"}
    for realm in manifest.realms:
        referenced.add(realm.world_db)
        referenced.add(realm.chars_db)
    for name in sorted(table_counts):
        if name.startswith(("acore_characters", "acore_world")) and name not in referenced:
            findings.append(
                f"database {name} ({table_counts[name]} tables) is referenced by no "
                f"realm in realms.yml — drop it by hand if it is not wanted"
            )

    if findings:
        print(f"{len(findings)} problem(s):")
        for finding in findings:
            print(f"  - {finding}")
        return 1
    print("manifest, compose override, realmlist, containers and databases all agree.")
    return 0


def _emit(realm: mf.Realm, manifest: mf.Manifest, print_env: bool, note: str) -> None:
    """Report a realm either for a human or for `eval` in tasks/realm.yml.

    With --print-env, stdout carries nothing but shell-quoted assignments, so a
    caller can eval it without also swallowing progress messages.
    """
    env = load_env()
    fields = {
        "REALM_ID": realm.id,
        "REALM_NAME": realm.name,
        "REALM_ADDR": manifest.address_for(realm),
        "REALM_PORT": realm.resolved_game_port(env),
        "REALM_SOAP_PORT": realm.resolved_soap_port(env),
        "REALM_WORLD_DB": realm.world_db,
        "REALM_CHARS_DB": realm.chars_db,
        "REALM_SERVICE": realm.service,
        "REALM_TYPE": realm.type,
        "REALM_PROFILE": realm.profile or "",
        "REALM_MANAGED": realm.managed,
    }
    if print_env:
        if note:
            print(note, file=sys.stderr)
        for key, value in fields.items():
            print(f"{key}={shlex.quote(str(value))}")
    else:
        print(note)
        for key, value in fields.items():
            print(f"  {key[6:].lower():<10} {value}")


def _reconcile(manifest: mf.Manifest, args: argparse.Namespace, stream=sys.stdout) -> int:
    """Run (or preview) a reconcile, reporting each step."""
    dry_run = getattr(args, "dry_run", False)
    try:
        actions = ap.apply(
            manifest,
            dry_run=dry_run,
            wait=getattr(args, "wait", 0),
            prune=not getattr(args, "no_prune", False),
            start=not getattr(args, "no_start", False),
            provision_dbs=not getattr(args, "no_provision", False),
        )
    except ap.ApplyError as exc:
        print(f"reconcile failed: {exc}", file=sys.stderr)
        return 1

    if not actions:
        print("nothing to do — reality already matches realms.yml", file=stream)
        return 0
    verb = "would" if dry_run else "did"
    print(f"{len(actions)} action(s) the reconcile {verb} take:", file=stream)
    for action in actions:
        print(f"  [{action.kind}] {action.description}", file=stream)
    return 0


def cmd_provision(args: argparse.Namespace) -> int:
    """Re-run the importer for one realm's databases.

    apply() only provisions a database that is missing its updater bookkeeping,
    which is the right default but leaves no way to repair one that exists and
    is wrong. This is that way.
    """
    manifest = _load()
    realm = mf.find(manifest, args.realm)
    if realm is None:
        print(f"no realm matching {args.realm!r} in {mf.MANIFEST_PATH}", file=sys.stderr)
        return 1
    print(f"Importing databases for realm {realm.id} ({realm.world_db}, {realm.chars_db})...")
    try:
        ap.provision(realm)
    except ap.ApplyError as exc:
        print(f"provision failed: {exc}", file=sys.stderr)
        return 1
    print("Import complete.")
    return 0


def cmd_databases(args: argparse.Namespace) -> int:
    """Every database still referenced by a realm, one per line.

    Callers about to drop a database check against this first. A realm added
    with --share-dbs points at acore_characters itself, so "the removed realm's
    character database" is not by itself safe to drop.
    """
    manifest = _load()
    names = set()
    for realm in manifest.realms:
        names.add(realm.world_db)
        names.add(realm.chars_db)
    for name in sorted(names):
        print(name)
    return 0


def cmd_apply(args: argparse.Namespace) -> int:
    return _reconcile(_load(), args)


def cmd_resolve(args: argparse.Namespace) -> int:
    """Look a realm up by id, alias, service or name."""
    manifest = _load()
    realm = mf.find(manifest, args.realm)
    if realm is None:
        print(f"no realm matching {args.realm!r} in {mf.MANIFEST_PATH}", file=sys.stderr)
        return 1
    # A lookup for eval gets no banner; a human asking gets one.
    note = "" if args.print_env else f"Realm {realm.id} ({realm.name})"
    _emit(realm, manifest, args.print_env, note)
    return 0


def cmd_add(args: argparse.Namespace) -> int:
    manifest = _load()
    realm = mf.allocate(
        manifest,
        realm_type=args.type,
        name=args.name,
        realm_id=args.id,
        game_port=args.port,
        soap_port=args.soap_port,
        address=args.addr,
        share_databases=args.share_dbs,
    )
    if getattr(args, "dry_run", False):
        _emit(realm, manifest, False, f"[dry-run] Would add realm {realm.id} to {mf.MANIFEST_PATH}:")
        return 0
    manifest.realms.append(realm)
    mf.save(manifest)
    stream = sys.stderr if args.print_env else sys.stdout
    if _reconcile(manifest, args, stream=stream) != 0:
        return 1
    _emit(realm, manifest, args.print_env, f"Added realm {realm.id} to {mf.MANIFEST_PATH}")
    return 0


def cmd_remove(args: argparse.Namespace) -> int:
    manifest = _load()
    realm = manifest.by_id(args.id)
    if realm is None:
        print(f"realm {args.id} is not in {mf.MANIFEST_PATH}", file=sys.stderr)
        return 1
    if realm.managed == "compose" and not args.force:
        print(
            f"realm {args.id} ({realm.service}) is declared in docker-compose.yml, not "
            f"generated. Remove it there, or pass --force to drop it from the manifest "
            f"only.",
            file=sys.stderr,
        )
        return 1
    manifest.realms.remove(realm)
    mf.save(manifest)
    stream = sys.stderr if args.print_env else sys.stdout
    if _reconcile(manifest, args, stream=stream) != 0:
        return 1
    _emit(realm, manifest, args.print_env, f"Removed realm {realm.id} from {mf.MANIFEST_PATH}")
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="summonstack", description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)

    sub.add_parser("list", help="show declared realms and live status").set_defaults(func=cmd_list)
    sub.add_parser("render", help="regenerate docker-compose.override.yml").set_defaults(func=cmd_render)
    sub.add_parser("check", help="report drift between manifest and reality").set_defaults(func=cmd_check)

    sub.add_parser(
        "databases", help="list databases still referenced by a realm"
    ).set_defaults(func=cmd_databases)

    prov_p = sub.add_parser("provision", help="re-run the importer for one realm")
    prov_p.add_argument("realm", nargs="?", default="")
    prov_p.set_defaults(func=cmd_provision)

    for name, help_text, dry in (
        ("apply", "make reality match realms.yml", False),
        ("plan", "show what apply would change, without changing it", True),
    ):
        p = sub.add_parser(name, help=help_text)
        p.add_argument("--no-prune", action="store_true",
                       help="leave leftover containers and realmlist rows alone")
        p.add_argument("--no-start", action="store_true", help="do not start realms")
        p.add_argument("--no-provision", action="store_true",
                       help="do not create missing databases")
        p.add_argument("--wait", type=int, default=0, metavar="SECONDS",
                       help="wait this long for the database before reconciling")
        p.set_defaults(func=cmd_apply, dry_run=dry)

    res_p = sub.add_parser("resolve", help="look up a realm by id, alias, service or name")
    res_p.add_argument("realm", nargs="?", default="")
    res_p.add_argument("--print-env", action="store_true")
    res_p.set_defaults(func=cmd_resolve)

    add_p = sub.add_parser("add", help="add a realm to the manifest")
    add_p.add_argument("--type", choices=mf.TYPES, default="normal")
    add_p.add_argument("--name", default="")
    add_p.add_argument("--id", type=int, default=None)
    add_p.add_argument("--port", type=int, default=None)
    add_p.add_argument("--soap-port", type=int, default=None)
    add_p.add_argument("--addr", default="")
    add_p.add_argument(
        "--share-dbs",
        action="store_true",
        help="point the realm at the existing databases instead of its own",
    )
    add_p.add_argument(
        "--dry-run",
        action="store_true",
        help="show what realm allocation would do without saving or reconciling",
    )
    add_p.add_argument(
        "--print-env",
        action="store_true",
        help="print shell assignments on stdout for eval, progress on stderr",
    )
    add_p.set_defaults(func=cmd_add)

    rem_p = sub.add_parser("remove", help="remove a realm from the manifest")
    rem_p.add_argument("--id", type=int, required=True)
    rem_p.add_argument("--force", action="store_true")
    rem_p.add_argument("--print-env", action="store_true")
    rem_p.set_defaults(func=cmd_remove)

    from . import ops
    sub.add_parser("doctor", help="run stack diagnostic checks").set_defaults(func=lambda args: ops.doctor())
    sub.add_parser("fix-perms", help="make config dirs writable by container user").set_defaults(func=lambda args: ops.fix_perms() or 0)
    sub.add_parser("setup", help="create .env with random session secret").set_defaults(func=lambda args: ops.setup_env())

    sc_p = sub.add_parser("soap-check", help="verify worldserver SOAP credentials")
    sc_p.add_argument("--port", type=int, default=None)
    sc_p.set_defaults(func=lambda args: ops.soap_check(args.port))

    ss_p = sub.add_parser("soap-set", help="set SOAP_USER and SOAP_PASS in .env")
    ss_p.add_argument("--user", required=True)
    ss_p.add_argument("--pass", dest="passw", required=True)
    ss_p.set_defaults(func=lambda args: ops.soap_set(args.user, args.passw) or 0)

    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    return args.func(args)
