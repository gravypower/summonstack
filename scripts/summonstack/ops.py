"""Operational helpers for summonstack task runner.

Handles doctor checks, setup, permission fixes, SOAP queries, and stack operations.
"""

from __future__ import annotations

import os
import re
import shutil
import subprocess
import sys
import secrets
import urllib.request
import urllib.error
import base64

from .env import load_env
from . import manifest as mf, compose, portal, apply as ap


def fix_perms() -> None:
    """Ensure bind-mounted config directories are writable by container user (uid 1000)."""
    for d in ["worldserver/modules"]:
        os.makedirs(d, exist_ok=True)
        try:
            st = os.stat(d)
            if st.st_uid != 1000:
                res = subprocess.run(["chown", "-R", "1000:1000", d], capture_output=True)
                if res.returncode == 0:
                    print(f"  chowned {d} to uid 1000")
        except Exception:
            pass


def setup_env() -> int:
    """Initialize .env with safe defaults if missing."""
    if os.path.exists(".env"):
        print(".env already exists.")
        return 0

    if os.path.exists(".env.sample"):
        shutil.copy(".env.sample", ".env")
    else:
        with open(".env", "w", encoding="utf-8") as f:
            f.write("DOCKER_DB_ROOT_PASSWORD=password\nSESSION_SECRET=\n")

    secret = secrets.token_urlsafe(36)
    with open(".env", "r", encoding="utf-8") as f:
        content = f.read()

    content = re.sub(r"^SESSION_SECRET=.*$", f"SESSION_SECRET={secret}", content, flags=re.MULTILINE)
    with open(".env", "w", encoding="utf-8") as f:
        f.write(content)
    os.chmod(".env", 0o600)
    print("Wrote .env with a random SESSION_SECRET.")
    print("DOCKER_DB_ROOT_PASSWORD left as default to match existing MySQL volume if present.")
    return 0


VALID_WEBAPP_MODES = ("prod", "dev")


def webapp_mode(mode: str | None = None) -> int:
    """Show or set WEBAPP_MODE in .env.

    The mode decides whether the portal container runs the production build or
    a hot-reload dev server. It lives in .env rather than in a task argument so
    every `docker compose` invocation agrees on it — the Taskfile turns it into
    COMPOSE_FILE, and a mode passed to one command only would have left the
    next command recreating the container in the other mode.
    """
    if not os.path.exists(".env"):
        print("No .env yet. Run: task setup", file=sys.stderr)
        return 1

    with open(".env", "r", encoding="utf-8") as f:
        content = f.read()

    current = "prod"
    found = re.search(r"^WEBAPP_MODE=(.*)$", content, re.MULTILINE)
    if found:
        current = found.group(1).strip().strip('"') or "prod"

    if mode is None:
        print(current)
        if current == "dev":
            print(
                "  portal runs `next dev`: hot reload, unminified, and the dev\n"
                "  error overlay shows stack traces. Fine locally, not on a\n"
                "  public host. Switch with: task prod",
                file=sys.stderr,
            )
        return 0

    if mode not in VALID_WEBAPP_MODES:
        print(f"Mode must be one of: {', '.join(VALID_WEBAPP_MODES)}", file=sys.stderr)
        return 1

    if found:
        content = re.sub(r"^WEBAPP_MODE=.*$", f"WEBAPP_MODE={mode}", content, flags=re.MULTILINE)
    else:
        content = content.rstrip() + f"\n\n# prod = production build; dev = hot reload (see README)\nWEBAPP_MODE={mode}\n"

    with open(".env", "w", encoding="utf-8") as f:
        f.write(content)
    print(f"WEBAPP_MODE={mode}")
    if current != mode:
        print("Run `task up` to rebuild the portal in that mode.")
    return 0


def doctor() -> int:
    """Run full diagnostic checks across environment, active operations, databases, images, permissions, and containers."""
    env = load_env()

    from . import hardware
    total_cores = hardware.available_cores()
    mem_gb = hardware.available_memory_gb()
    buffer_pool_mb = hardware.mysql_buffer_pool_mb(mem_gb)

    print("── system resources ──")
    print(f"  CPU:  {total_cores} cores")
    print(f"  RAM:  {mem_gb:.1f} GB ({buffer_pool_mb / 1024:.1f} GB → MySQL buffer pool)")

    print("\n── container resources ──")
    print(f"  {'SERVICE':<18} {'STATUS':<8} {'CPU (cores)':<14} {'RAM':<11} {'LOAD'}")
    
    ps_res = subprocess.run(
        ["docker", "ps", "-a", "--filter", "name=^/?ac-", "--format", "{{.Names}}\t{{.State}}"],
        capture_output=True, text=True, check=False,
    )
    
    total_cores_used = 0.0
    
    if ps_res.returncode == 0 and ps_res.stdout.strip():
        containers = {}
        for line in ps_res.stdout.strip().splitlines():
            parts = line.split("\t")
            if len(parts) == 2:
                containers[parts[0]] = parts[1]
                
        stats_res = subprocess.run(
            ["docker", "stats", "--no-stream", "--format", "{{.Name}}\t{{.CPUPerc}}\t{{.MemUsage}}"] + list(containers.keys()),
            capture_output=True, text=True, check=False,
        )
        
        stats = {}
        if stats_res.returncode == 0:
            for line in stats_res.stdout.strip().splitlines():
                parts = line.split("\t")
                if len(parts) >= 3:
                    stats[parts[0]] = {"cpu": parts[1], "mem": parts[2].split(" / ")[0]}
                    
        for name, state in containers.items():
            is_up = state == "running"
            status = "● up" if is_up else "○ down"
            
            if is_up and name in stats:
                cpu_str = stats[name]["cpu"].replace("%", "")
                try:
                    cpu_perc = float(cpu_str)
                    cores_used = cpu_perc / 100.0
                    total_cores_used += cores_used
                    cpu_display = f"{cores_used:.1f} / {total_cores}"
                    
                    load_pct = min(100, int((cores_used / total_cores) * 100))
                    blocks = int(load_pct / 10)
                    bar = "█" * blocks + "░" * (10 - blocks)
                    load_display = f"{bar} {load_pct:>2}%"
                except ValueError:
                    cpu_display = "err"
                    load_display = "err"
                
                mem_display = stats[name]["mem"]
            else:
                cpu_display = "—"
                mem_display = "—"
                load_display = ""
                
            print(f"  {name:<18} {status:<8} {cpu_display:<14} {mem_display:<11} {load_display}")
            
    else:
        print("  no summonstack containers found")
        
    headroom_cores = max(0.0, total_cores - total_cores_used)
    headroom_pct = int((headroom_cores / total_cores) * 100) if total_cores > 0 else 0
    print(f"\n  Headroom: {headroom_cores:.1f} cores idle ({headroom_pct}%)")

    print("\n── thread allocation ──")
    try:
        manifest = mf.load()
        overrides = compose.compose_services()
        if os.path.exists(compose.OVERRIDE_PATH):
            overrides.update(compose.compose_services(compose.OVERRIDE_PATH))
        
        has_realms = False
        for realm in manifest.realms:
            service_name = realm.service
            if service_name in overrides:
                has_realms = True
                svc_env = overrides[service_name].get("environment", {})
                
                map_t = svc_env.get("AC_MAP_UPDATE_THREADS", "?")
                net_t = svc_env.get("AC_NETWORK_THREADS", "?")
                pool_t = svc_env.get("AC_THREAD_POOL", "?")
                db_t = svc_env.get("AC_PLAYERBOTS_DATABASE_WORKER_THREADS", "N/A")
                
                print(f"  {service_name} ({realm.type}):")
                if realm.type == "playerbots":
                    print(f"    Map: {map_t} threads | Network: {net_t} threads | DB Worker: {db_t} threads | ThreadPool: {pool_t}")
                else:
                    print(f"    Map: {map_t} threads | Network: {net_t} threads | ThreadPool: {pool_t}")
                    
        if not has_realms:
            print("  no realms defined in manifest/override")
    except Exception as e:
        print(f"  could not read thread allocation: {e}")


    print("\n── database congestion ──")
    try:
        db_pass = env.get("DOCKER_DB_ROOT_PASSWORD", "password")
        res = subprocess.run(
            ["docker", "exec", "ac-database", "mysql", "-u", "root", f"-p{db_pass}", "-e", "SHOW PROCESSLIST;"],
            capture_output=True,
            text=True,
            check=False,
        )
        if res.returncode == 0:
            lines = res.stdout.splitlines()
            # MySQL might output a warning on the first line about password on CLI
            if lines and lines[0].startswith("mysql: [Warning]"):
                lines = lines[1:]
            if lines:
                headers = lines[0]
                active = []
                for line in lines[1:]:
                    # Skip idle connections, background threads, and this exact query
                    if "Sleep" in line or "Daemon" in line or "Binlog" in line or "SHOW PROCESSLIST" in line:
                        continue
                    active.append(line)
                if active:
                    print("  Active queries (potential congestion):")
                    print(f"  {headers}")
                    for line in active:
                        print(f"  {line}")
                else:
                    print("  none (all connections idle)")
            else:
                print("  no output from processlist")
        else:
            print("  could not connect to mysql to check congestion (is ac-database running?)")
    except Exception as e:
        print(f"  error checking database: {e}")

    print("\n── active operations ──")
    try:
        from . import state
        importers = state.active_importers()
        if importers:
            for name, info in importers.items():
                print(f"  [DB Importer] {name}: {info['status']}")
                if info['last_log']:
                    print(f"                {info['last_log']}")
        else:
            print("  no active database imports or background tasks")
    except Exception as e:
        print(f"  error querying active ops: {e}")

    print("── database inventory ──")
    try:
        tbl_counts = state.databases(env)
        if tbl_counts:
            for db_name, count in sorted(tbl_counts.items()):
                if db_name.startswith("acore_"):
                    print(f"  {db_name:<30} {count} tables")
        else:
            print("  could not query databases (is ac-database running?)")
    except Exception as e:
        print(f"  database query error: {e}")

    print("── .env ──")
    if os.path.exists(".env"):
        print("  present")
        # Must stay in step with secret() in webapp/src/lib/session.ts, which
        # refuses to sign with any of these rather than issuing forgeable
        # cookies. Reported here too so `task doctor` explains the failure
        # before compose does.
        session_secret = env.get("SESSION_SECRET", "")
        if not session_secret:
            print("  WARNING: SESSION_SECRET is unset — the stack will refuse to start.")
        elif session_secret in ("please-change-me", "change-me-session-secret"):
            print("  WARNING: SESSION_SECRET is still the example value — sessions are forgeable.")
        elif len(session_secret) < 16:
            print("  WARNING: SESSION_SECRET is shorter than 16 characters — sessions are guessable.")
    else:
        print("  MISSING — the stack is running on compose defaults. Run: task setup")

    print("── image ages ──")
    images = [
        "acore/ac-wotlk-db-import:master",
        "acore/ac-wotlk-worldserver:master",
        "acore/ac-wotlk-authserver:master",
        "acore/ac-wotlk-client-data:master",
    ]
    for img in images:
        res = subprocess.run(
            ["docker", "inspect", img, "--format", "{{.Created}}"],
            capture_output=True,
            text=True,
            check=False,
        )
        created = res.stdout.strip().split("T")[0] if res.returncode == 0 and res.stdout.strip() else "not pulled"
        print(f"  {img:<40} {created}")

    print("── config dir permissions ──")
    for d in ["worldserver/modules"]:
        if not os.path.exists(d):
            print(f"  {d} MISSING — run: task fix-perms")
        else:
            st = os.stat(d)
            if st.st_uid != 1000:
                print(f"  {d} is not writable by uid 1000 — run: task fix-perms")
            else:
                print("  ok")

    print("── realm drift & health ──")
    try:
        from .cli import cmd_check
        class DummyArgs:
            pass
        cmd_check(DummyArgs())
    except Exception as e:
        print(f"  realm check error: {e}")

    print("── container name clashes ──")
    res = subprocess.run(
        ["docker", "ps", "-a", "--filter", "name=^/ac-", "--format", "{{.Names}}\t{{.Label \"com.docker.compose.project\"}}"],
        capture_output=True,
        text=True,
        check=False,
    )
    clashes = []
    if res.returncode == 0:
        for line in res.stdout.splitlines():
            parts = line.split("\t")
            if len(parts) >= 2 and parts[1] and parts[1] != "summonstack":
                clashes.append(f"  {parts[0]} belongs to project: {parts[1]}")
    if clashes:
        for c in clashes:
            print(c)
    else:
        print("  none")
    return 0


def soap_set(user: str, passw: str) -> None:
    """Set SOAP_USER and SOAP_PASS in .env."""
    if not os.path.exists(".env"):
        print("No .env found. Run: task setup", file=sys.stderr)
        sys.exit(1)

    with open(".env", "r", encoding="utf-8") as f:
        content = f.read()

    def set_key(k: str, v: str, text: str) -> str:
        if re.search(rf"^{k}=", text, re.MULTILINE):
            return re.sub(rf"^{k}=.*$", f"{k}={v}", text, flags=re.MULTILINE)
        return text.rstrip() + f"\n{k}={v}\n"

    content = set_key("SOAP_USER", user, content)
    content = set_key("SOAP_PASS", passw, content)

    with open(".env", "w", encoding="utf-8") as f:
        f.write(content)
    os.chmod(".env", 0o600)
    print("Wrote SOAP_USER/SOAP_PASS to .env (mode 600).")


def soap_check(port: int | None = None) -> int:
    """Query worldserver SOAP API to verify credentials."""
    env = load_env()
    user = env.get("SOAP_USER")
    passw = env.get("SOAP_PASS")
    if not port:
        port_str = env.get("DOCKER_SOAP_EXTERNAL_PORT") or "7878"
        try:
            port = int(port_str)
        except ValueError:
            port = 7878

    if not user or not passw:
        print("SOAP_USER/SOAP_PASS not set in .env. Run: task soap USER=x PASS=y", file=sys.stderr)
        return 1

    body = (
        '<?xml version="1.0" encoding="utf-8"?>\n'
        '<SOAP-ENV:Envelope xmlns:SOAP-ENV="http://schemas.xmlsoap.org/soap/envelope/" xmlns:ns1="urn:AC">\n'
        '  <SOAP-ENV:Body><ns1:executeCommand><command>server info</command></ns1:executeCommand></SOAP-ENV:Body>\n'
        '</SOAP-ENV:Envelope>'
    ).encode("utf-8")

    req = urllib.request.Request(f"http://127.0.0.1:{port}/", data=body, headers={"Content-Type": "text/xml"})
    credentials = f"{user}:{passw}".encode("utf-8")
    req.add_header("Authorization", f"Basic {base64.b64encode(credentials).decode('ascii')}")

    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            content = resp.read().decode("utf-8", errors="replace")
            if "<result>" in content:
                match = re.search(r"<result>(.*?)</result>", content, re.DOTALL)
                res_text = match.group(1).replace("&#xD;", "").strip() if match else content
                print(f"SOAP OK as '{user}' (port {port}). Worldserver replied:")
                for line in res_text.splitlines()[:6]:
                    if line.strip():
                        print(f"  {line.strip()}")
                return 0
            else:
                print(f"No usable reply from worldserver SOAP API on port {port}.", file=sys.stderr)
                return 1
    except urllib.error.HTTPError as e:
        if e.code in (401, 403):
            print(f"SOAP auth REJECTED for '{user}' on port {port} (HTTP {e.code}).", file=sys.stderr)
            print(f"Check the password and ensure account has GM level 3.", file=sys.stderr)
        else:
            print(f"SOAP HTTP error {e.code} on port {port}.", file=sys.stderr)
        return 1
    except Exception as e:
        print(f"Could not reach worldserver SOAP API on 127.0.0.1:{port} ({e}).", file=sys.stderr)
        return 1
