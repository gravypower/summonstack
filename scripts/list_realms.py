#!/usr/bin/env python3
import os

pw = os.popen("grep -E '^DOCKER_DB_ROOT_PASSWORD=' .env 2>/dev/null | cut -d= -f2-").read().strip() or "password"
cmd = f"docker exec ac-database mysql -uroot -p'{pw}' -sN -e 'SELECT id, name, address, port FROM acore_auth.realmlist ORDER BY id;' 2>/dev/null"
db_output = os.popen(cmd).read().strip()

docker_output = os.popen("docker ps -a --format '{{.Names}}\t{{.Status}}'").read().strip()
container_status = {}
for line in docker_output.split('\n'):
    if line.strip():
        parts = line.split('\t', 1)
        if len(parts) == 2:
            container_status[parts[0]] = parts[1]

print(f"{'ID':<4} {'NAME':<28} {'ADDRESS':<16} {'PORT':<6} {'STATUS'}")
print("─" * 75)

def get_container_name(r_id, container_status):
    if f"ac-pb-realm-{r_id}" in container_status:
        return f"ac-pb-realm-{r_id}"
    if f"ac-realm-{r_id}" in container_status:
        return f"ac-realm-{r_id}"
    if r_id == "1" and "ac-worldserver" in container_status:
        return "ac-worldserver"
    if r_id == "2" and "ac-pb-worldserver" in container_status:
        return "ac-pb-worldserver"
    return f"ac-realm-{r_id}"

if db_output:
    for line in db_output.split('\n'):
        if not line.strip():
            continue
        cols = line.split('\t')
        if len(cols) >= 4:
            r_id, r_name, r_addr, r_port = cols[0], cols[1], cols[2], cols[3]
            c_name = get_container_name(r_id, container_status)
            status = container_status.get(c_name, "Stopped / Not Created")
            print(f"{r_id:<4} {r_name:<28} {r_addr:<16} {r_port:<6} {status}")
else:
    print("No realms found in database.")
