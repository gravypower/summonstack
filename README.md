# SummonStack

A complete, self-hosted **AzerothCore** (World of Warcraft — Wrath of the Lich
King 3.3.5a) private server in Docker Compose, with a built-in web portal:

- **Player portal** — server status, invite-only account registration,
  login, password changes.
- **Admin panel** — one-click invite links, account management
  (ban/unban, GM levels, password resets), and a live worldserver console
  over SOAP.

## Stack

| Service              | What it is                                        | Port (host)      |
| -------------------- | ------------------------------------------------- | ---------------- |
| `ac-database`        | MySQL 8.4                                         | 127.0.0.1:3306   |
| `ac-db-import`       | One-shot DB schema import/updates                 | —                |
| `ac-client-data-init`| One-shot download of maps/DBC data (~15 GB)       | —                |
| `ac-authserver`      | Login server                                      | 3724             |
| `ac-worldserver`     | Game server (SOAP API on 7878)                    | 8085, 127.0.0.1:7878 |
| `ac-webapp`          | Next.js player portal + admin panel               | 8080             |

## First-time setup

**1. Configure secrets.** A `.env` was generated with random values — review
it (or copy `.env.example` to `.env` and fill it in yourself).

**2. Start the stack:**

```bash
docker compose up -d
```

The first start downloads the AzerothCore images and ~15 GB of client data
(maps, vmaps, mmaps, DBC), and imports all databases. Depending on your
connection this takes a while. Watch progress with:

```bash
docker compose logs -f
```

The worldserver only starts after the DB import and data download finish.
You're up when `docker compose ps` shows `ac-worldserver` as running and the
homepage at <http://localhost:8080> shows both servers **Online**.

**3. Create your admin account:**

```bash
docker compose exec ac-webapp node scripts/create-admin.mjs myadmin MySecretPass1
```

**4. Wire up the SOAP console.** Put those same credentials in `.env`
(`SOAP_USER=myadmin`, `SOAP_PASS=MySecretPass1`), then reload the webapp:

```bash
docker compose up -d ac-webapp
```

**5. Log in** at <http://localhost:8080/login> with the admin account, open
**Admin**, and create invite links for your players. Each link can be used
once; registration without a link is impossible.

## Letting other people connect

Out of the box the realm address is `127.0.0.1` — only you can play. To let
others connect, point the realm at your LAN IP or public hostname:

```bash
docker compose exec ac-database mysql -uroot -p"$(grep ^DOCKER_DB_ROOT_PASSWORD .env | cut -d= -f2)" -e "UPDATE acore_auth.realmlist SET address='YOUR.LAN.OR.PUBLIC.IP' WHERE id=1;"
```

Also update `SITE_URL` in `.env` so invite links use the right hostname, and
forward/allow TCP **3724** (login), **8085** (world), and **8080** (website).

Players need a 3.3.5a client with `Data/<locale>/realmlist.wtf` set to
`set realmlist YOUR.LAN.OR.PUBLIC.IP` — the homepage shows the exact line.

## Day-to-day operations

```bash
docker compose logs -f ac-worldserver
```

```bash
docker attach ac-worldserver
```

`docker attach` gives you the interactive worldserver console (detach with
`Ctrl-P` then `Ctrl-Q` — **not** `Ctrl-C`, which stops the server). Most
things are easier from the web console at `/admin/console`, which accepts
the same commands (`server info`, `account onlinelist`, `announce …`,
`ban character …`, `kick …`, `help`).

Realm name can be changed the same way as the address
(`UPDATE acore_auth.realmlist SET name='My Realm' WHERE id=1;`) — it shows up
on the website and in the client realm list.

### Backups

Everything that matters lives in the `ac-database` volume:

```bash
docker compose exec ac-database sh -c 'mysqldump -uroot -p"$MYSQL_ROOT_PASSWORD" --databases acore_auth acore_characters summonstack_web' > backup.sql
```

(`acore_world` is re-creatable by `ac-db-import`, but include it too if you
have customized world data.)

### Updating the server

```bash
docker compose pull
docker compose up -d
```

`ac-db-import` re-runs automatically and applies any pending DB migrations.

## How the pieces talk to each other

- The webapp writes **SRP6 salt/verifier pairs** straight into
  `acore_auth.account` — the exact algorithm the 3.3.5a client uses, so the
  same username/password works on the website and in the game.
- Invite links live in the webapp's own `summonstack_web` database; each
  token is claimed atomically so it can never be used twice.
- Admin access = **GM level 3** in `acore_auth.account_access`. The webapp
  checks it live on every admin request, so demoting an account locks them
  out of `/admin` immediately.
- The admin console posts commands to the worldserver's **SOAP API**
  (port 7878, reachable only from inside the compose network and from
  localhost) using the `SOAP_USER`/`SOAP_PASS` account.

## Security notes

- Keep `.env` private — it holds the DB root password, session-signing
  secret, and SOAP credentials. It is `.gitignore`d.
- MySQL (3306) and SOAP (7878) are bound to `127.0.0.1` on the host on
  purpose; don't expose them publicly.
- If you put the site on the public internet, run it behind a reverse proxy
  with HTTPS (Caddy/Traefik/nginx) and set `SITE_URL=https://…` so session
  cookies are marked `Secure`.
