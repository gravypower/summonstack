#!/usr/bin/env python3
import sys
import os
import argparse
import socket

OVERRIDE_FILE = "docker-compose.override.yml"

def is_port_in_use(port):
    port = int(port)
    docker_ports = os.popen("docker ps --format '{{.Ports}}'").read()
    if f":{port}->" in docker_ports or f":{port}/" in docker_ports:
        return True
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            s.settimeout(0.5)
            if s.connect_ex(('127.0.0.1', port)) == 0:
                return True
    except Exception:
        pass
    return False

def get_normal_block(id_val, port, soap_port, chars_db):
    return f"""  ac-realm-{id_val}:
    container_name: ac-realm-{id_val}
    image: acore/ac-wotlk-worldserver:${{DOCKER_IMAGE_TAG:-master}}
    networks:
      - ac-network
    stdin_open: true
    tty: true
    restart: unless-stopped
    environment:
      AC_DATA_DIR: "/azerothcore/env/dist/data"
      AC_LOGS_DIR: "/azerothcore/env/dist/logs"
      AC_LOGIN_DATABASE_INFO: "ac-database;3306;root;${{DOCKER_DB_ROOT_PASSWORD:-password}};acore_auth"
      AC_WORLD_DATABASE_INFO: "ac-database;3306;root;${{DOCKER_DB_ROOT_PASSWORD:-password}};acore_world"
      AC_CHARACTER_DATABASE_INFO: "ac-database;3306;root;${{DOCKER_DB_ROOT_PASSWORD:-password}};{chars_db}"
      AC_REALM_ID: "{id_val}"
      AC_SOAP_ENABLED: "1"
      AC_SOAP_IP: "0.0.0.0"
    ports:
      - "{port}:8085"
      - "127.0.0.1:{soap_port}:7878"
    volumes:
      - ac-client-data:/azerothcore/env/dist/data/:ro
      - ./worldserver/mod_ale.conf:/azerothcore/env/dist/etc/modules/mod_ale.conf:ro
      - ./worldserver/lua_scripts:/azerothcore/lua_scripts:ro
    depends_on:
      ac-database:
        condition: service_healthy
      ac-client-data-init:
        condition: service_completed_successfully
"""

def get_playerbot_block(id_val, port, soap_port, world_db, chars_db):
    return f"""  ac-pb-realm-{id_val}:
    container_name: ac-pb-realm-{id_val}
    build:
      context: ./playerbots
      target: worldserver
    networks:
      - ac-network
    stdin_open: true
    tty: true
    restart: unless-stopped
    environment:
      AC_DATA_DIR: "/azerothcore/env/dist/data"
      AC_LOGS_DIR: "/azerothcore/env/dist/logs"
      AC_TEMP_DIR: "/azerothcore/env/dist/temp"
      AC_LOGIN_DATABASE_INFO: "ac-database;3306;root;${{DOCKER_DB_ROOT_PASSWORD:-password}};acore_auth"
      AC_WORLD_DATABASE_INFO: "ac-database;3306;root;${{DOCKER_DB_ROOT_PASSWORD:-password}};{world_db}"
      AC_CHARACTER_DATABASE_INFO: "ac-database;3306;root;${{DOCKER_DB_ROOT_PASSWORD:-password}};{chars_db}"
      AC_REALM_ID: "{id_val}"
      AC_SOAP_ENABLED: "1"
      AC_SOAP_IP: "0.0.0.0"
      AC_AI_PLAYERBOT_ENABLED: "1"
      AC_AI_PLAYERBOT_ALLOW_PLAYER_BOTS: "1"
      AC_AI_PLAYERBOT_RANDOM_BOT_AUTOLOGIN: "0"
      AC_AI_PLAYERBOT_MIN_RANDOM_BOTS: "10"
      AC_AI_PLAYERBOT_MAX_RANDOM_BOTS: "200"
    ports:
      - "{port}:8085"
      - "127.0.0.1:{soap_port}:7878"
    volumes:
      - ac-client-data:/azerothcore/env/dist/data:ro
      - ./playerbots/playerbots.conf:/azerothcore/env/dist/etc/mod_playerbots.conf:ro
    depends_on:
      ac-database:
        condition: service_healthy
      ac-client-data-init:
        condition: service_completed_successfully
"""

def add_realm(args):
    if is_port_in_use(args.port):
        print(f"Error: Game Port {args.port} is already in use by another service/container!", file=sys.stderr)
        print("Please specify an available port (e.g. PORT=8087) or omit PORT to auto-assign.", file=sys.stderr)
        sys.exit(1)

    if is_port_in_use(args.soap_port):
        print(f"Error: SOAP Port {args.soap_port} is already in use by another service/container!", file=sys.stderr)
        print("Please specify an available port or omit ID to auto-assign ports.", file=sys.stderr)
        sys.exit(1)

    content = ""
    if os.path.exists(OVERRIDE_FILE):
        with open(OVERRIDE_FILE, "r") as f:
            content = f.read()

    if "services:" not in content:
        content = "services:\n" + content

    if args.type == "playerbots":
        service_name = f"ac-pb-realm-{args.id}"
        block = get_playerbot_block(args.id, args.port, args.soap_port, args.world_db, args.chars_db)
    else:
        service_name = f"ac-realm-{args.id}"
        block = get_normal_block(args.id, args.port, args.soap_port, args.chars_db)

    if service_name not in content:
        content = content.rstrip() + "\n\n" + block
        with open(OVERRIDE_FILE, "w") as f:
            f.write(content)
        print(f"Added service {service_name} to {OVERRIDE_FILE}")

def remove_realm(args):
    if not os.path.exists(OVERRIDE_FILE):
        return

    with open(OVERRIDE_FILE, "r") as f:
        lines = f.readlines()

    targets = [f"ac-realm-{args.id}:", f"ac-pb-realm-{args.id}:"]
    new_lines = []
    skipping = False

    for line in lines:
        stripped = line.strip()
        if any(stripped.startswith(t) for t in targets):
            skipping = True
            continue
        elif skipping and line.startswith("  ") and not line.startswith("    "):
            skipping = False

        if not skipping:
            new_lines.append(line)

    non_empty = [l for l in new_lines if l.strip() and l.strip() != "services:"]
    if not non_empty:
        os.remove(OVERRIDE_FILE)
        print(f"Removed empty {OVERRIDE_FILE}")
    else:
        with open(OVERRIDE_FILE, "w") as f:
            f.writelines(new_lines)
        print(f"Cleaned service for realm {args.id} from {OVERRIDE_FILE}")

def main():
    parser = argparse.ArgumentParser(description="Manage realm services in docker-compose.override.yml")
    subparsers = parser.add_subparsers(dest="cmd", required=True)

    add_p = subparsers.add_parser("add")
    add_p.add_argument("--id", required=True)
    add_p.add_argument("--port", required=True)
    add_p.add_argument("--soap-port", required=True)
    add_p.add_argument("--type", choices=["normal", "playerbots"], default="normal")
    add_p.add_argument("--world-db", default="acore_world")
    add_p.add_argument("--chars-db", default="acore_characters")

    rem_p = subparsers.add_parser("remove")
    rem_p.add_argument("--id", required=True)

    args = parser.parse_args()
    if args.cmd == "add":
        add_realm(args)
    elif args.cmd == "remove":
        remove_realm(args)

if __name__ == "__main__":
    main()
