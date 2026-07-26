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
| `ac-client-data-init`| One-shot download of maps/DBC data (~3 GB)         | —                |
| `ac-authserver`      | Login server                                      | 3724             |
| `ac-worldserver`     | Game server (SOAP API on 7878)                    | 8085, 127.0.0.1:7878 |
| `ac-webapp`          | Next.js player portal + admin panel               | 8080             |

## Task runner

Common operations are wrapped in a [Taskfile](https://taskfile.dev). Install
Task, then run `task` to see everything available:

| Command | What it does |
| ------- | ------------ |
| `task up` / `task down` | Start / stop the stack |
| `task logs -- ac-worldserver` | Follow one service's logs |
| `task doctor` | Check for stale images, a missing `.env`, and container-name clashes |
| `task admin USER=x PASS=y` | Create or promote a GM-level-3 account (add `SOAP=1` to wire the console too) |
| `task soap USER=x PASS=y` | Point the admin console at an account and verify it end to end |
| `task db -- acore_world` | MySQL shell (defaults to `acore_auth`) |
| `task db:import` | Re-run the schema importer, failing loudly if it errors |
| `task client:check` | Verify the download server without transferring gigabytes |
| `task reset` | Rebuild all game DBs from scratch, keeping the 3 GB client data |
| `task reset:hard` | Delete everything, volumes included |

Both reset tasks prompt before doing anything and refuse to run outside a
terminal, so they cannot fire from a script by accident.

`task doctor` is worth running first whenever the stack misbehaves. The most
common failure is a **stale cached image**: `:master` tags already present
locally are not re-pulled, so an old `ac-db-import` can hand a months-old
schema to a current `ac-worldserver`, which then crash-loops on missing
tables. `task pull && task db:import` fixes it.

## First-time setup

**1. Configure secrets.** A `.env` was generated with random values — review
it (or copy `.env.example` to `.env` and fill it in yourself).

**2. Start the stack:**

```bash
docker compose up -d
```

The first start downloads the AzerothCore images and ~3 GB of client data
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

**4. Wire up the SOAP console.** Either let Task do it — which writes the
credentials, reloads the webapp, and confirms the worldserver accepts them:

```bash
task soap USER=myadmin PASS=MySecretPass1
```

or put the same credentials in `.env` (`SOAP_USER`, `SOAP_PASS`) by hand and
reload:

```bash
docker compose up -d ac-webapp
```

Steps 3 and 4 collapse into one with `task admin USER=myadmin PASS=… SOAP=1`.

**5. Log in** at <http://localhost:8080/login> with the admin account, open
**Admin**, and create invite links for your players. Each link can be used
once; registration without a link is impossible.

## Letting other people connect

Out of the box the realm address is `127.0.0.1` — only you can play. To let
others connect, point the realm at your LAN IP or public hostname:

```bash
docker compose exec ac-database mysql -uroot -p"$(grep ^DOCKER_DB_ROOT_PASSWORD .env | cut -d= -f2)" -e "UPDATE acore_auth.realmlist SET address='YOUR.LAN.OR.PUBLIC.IP' WHERE id=1;"
```

Also update `SITE_URL` and `DOWNLOAD_URL` in `.env` so invite links and the
client download use the right hostname, and forward/allow TCP **3724**
(login), **8085** (world), **8080** (website), and **8081** (downloads).

Players need a 3.3.5a client with `Data/<locale>/realmlist.wtf` set to
`set realmlist YOUR.LAN.OR.PUBLIC.IP` — the homepage shows the exact line.

## Serving the game client

`ac-downloads` is a small nginx container that hands out the client zip so an
~18 GB transfer never goes through the Node app. Point `CLIENT_ZIP_PATH` at
the file on the host (default `./ChromieCraft_3.3.5a.zip`) and it is published
at `/files/client.zip`, which the homepage links to.

The URL is fixed while `CLIENT_ZIP_NAME` controls the filename the browser
saves, so replacing the client later does not break links players already
have. Downloads are **range/resume capable** — verified past the 17 GB offset,
so an interrupted transfer picks up where it left off.

Access requires a portal login: nginx calls `/api/download/authorize` on the
webapp via `auth_request` and redirects anyone without a session to
`SITE_URL/login`. `DOWNLOAD_URL` must therefore share a hostname with
`SITE_URL`, otherwise the login cookie is not sent with the download request.
(Ports do not matter — cookies are not port-scoped.)

Anything else dropped in `downloads/files/` is published at `/files/<name>`
under the same login requirement — handy for patches or addon packs.
`downloads/files/test.txt` is a tiny fixture for checking the server without
moving gigabytes:

```bash
curl -i -b "ss_session=<your cookie>" http://localhost:8081/files/test.txt
```

Note that the client zip is Blizzard's copyrighted software; how widely you
expose it is your call.

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
- `ac-downloads` holds no credentials and never touches the DB — it asks the
  webapp whether the requester is logged in and serves bytes off disk.
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
