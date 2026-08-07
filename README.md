# SummonStack

A complete, self-hosted **AzerothCore** (World of Warcraft — Wrath of the Lich
King 3.3.5a) private server in Docker Compose, with a built-in web portal:

- **Player portal** — server status, invite-only account registration,
  login, password changes.
- **Admin panel** — one-click invite links, account management
  (ban/unban, GM levels, password resets), and a live worldserver console
  over SOAP.
- **Shop backend** — a points currency with an append-only ledger, level and
  profession boosts, experience locks, and 60/70/80 starter packs delivered
  by in-game mail over SOAP. See [Shop](#shop) below.
- **Summon rewards** — a realm-wide summon counter, and shop points for
  summoning other players. See [Summon rewards](#summon-rewards) below.

## Stack

| Service              | What it is                                        | Port (host)      |
| -------------------- | ------------------------------------------------- | ---------------- |
| `ac-database`        | MySQL 8.4                                         | 127.0.0.1:3306   |
| `ac-db-import`       | One-shot DB schema import/updates                 | —                |
| `ac-client-data-init`| One-shot download of maps/DBC data (~3 GB)         | —                |
| `ac-authserver`      | Login server (shared by both realms)              | 3724             |
| `ac-worldserver`     | Game server, realm 1 (SOAP on 7878)               | 8085, 127.0.0.1:7878 |
| `ac-webapp`          | Next.js player portal + admin panel               | 8080             |
| `ac-pb-db-import`    | *(playerbots)* One-shot DB import                 | —                |
| `ac-pb-worldserver`  | *(playerbots)* Game server, realm 2               | 8086, 127.0.0.1:7879 |

The two `ac-pb-*` services are **optional** and only start when `PLAYERBOTS_MODE=1`
is set in `.env` (or via `task playerbots:up`). See [Playerbots Mode](#playerbots-mode).

## Task runner

Common operations are wrapped in a [Taskfile](https://taskfile.dev). Install
Task, then run `task` to see everything available:

| Command | What it does |
| ------- | ------------ |
| `task up` / `task down` | Start / stop the stack |
| `task logs -- ac-worldserver` | Follow one service's logs |
| `task doctor` | Check for stale images, a missing `.env`, and container-name clashes |
| `task admin USER=x PASS=y` | Create or promote a GM-level-3 account, wiring the admin console on first setup |
| `task soap USER=x PASS=y` | Repoint the admin console at an account and verify it end to end |
| `task shop:seed` | Load/refresh the shop catalog and starter packs |
| `task shop:grant USER=x AMOUNT=500` | Grant shop points to an account |
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

## Playerbots Mode

Playerbots mode runs a **second AzerothCore realm** alongside the standard one,
built from the [`mod-playerbots/azerothcore-wotlk`](https://github.com/mod-playerbots/azerothcore-wotlk)
fork with the [mod-playerbots](https://github.com/mod-playerbots/mod-playerbots)
module compiled in. NPC bots populate the world automatically and players can
summon personal bots to fill group roles.

Both realms share `ac-database` (MySQL) and `ac-authserver` — players see
two entries in the WoW client realm list and pick whichever they want.

### Architecture

```
WoW client → ac-authserver (port 3724, acore_auth DB)
                  ├─→ Realm 1: ac-worldserver     (port 8085, acore_world DB)     [standard]
                  └─→ Realm 2: ac-pb-worldserver  (port 8086, acore_world_pb DB)  [playerbots]
```

### Setup

> **Note**: Because no prebuilt Docker image exists for the playerbots fork,
> the first build compiles ~600 K lines of C++. Expect **30–60 minutes**.
> Docker layer-caches the result — subsequent starts are instant.

```bash
# 1. Build once (clone + compile from source)
task playerbots:build

# 2. Enable in .env
echo 'PLAYERBOTS_MODE=1' >> .env

# 3. Start (or just run task up if the stack is already running)
task playerbots:up

# 4. Create an admin account on the playerbots realm
task playerbots:world
# Inside the console:
# AC> account create myuser mypassword
# AC> account set gmlevel myuser 3 -1
# Detach: Ctrl-P then Ctrl-Q
```

### Playerbots tasks

| Command | What it does |
| ------- | ------------ |
| `task playerbots:build` | Compile worldserver from source (first-time only) |
| `task playerbots:up` | Start playerbots services |
| `task playerbots:down` | Stop playerbots services (keeps data) |
| `task playerbots:world` | Attach to the playerbots worldserver console |
| `task playerbots:logs` | Follow playerbots worldserver logs |
| `task playerbots:status` | Show container status |
| `task playerbots:db:import` | Re-run the DB importer (safe to re-run) |

### Configuration

Bot settings live in [`playerbots/playerbots.conf`](./playerbots/playerbots.conf).
Edit the file on the host and restart the container to apply:

```bash
task restart -- ac-pb-worldserver
```

Key settings (all under `[worldserver]` in the conf):

| Setting | Default | What it does |
| ------- | ------- | ------------ |
| `AiPlayerbot.enabled` | `1` | Master switch |
| `AiPlayerbot.RandomBotAutologin` | `0` | Auto-populate world with bots |
| `AiPlayerbot.minRandomBots` / `maxRandomBots` | `10` / `200` | Random bot count |
| `AiPlayerbot.AllowPlayerBots` | `1` | Let players summon bots |
| `AiPlayerbot.maxAddedBots` | `3` | Max bots per player |

Full reference: <https://github.com/mod-playerbots/mod-playerbots/wiki/Playerbot-Configuration>

## Shop

The webapp ships a points shop at `/shop` (in the nav once logged in): a
points currency stored in `summonstack_web` with an append-only ledger,
API routes under `/api/shop/*`, and an admin grant route.

- **Products** — 60/70/80 level boosts, profession boost (maxes learned
  primary + secondary professions to 450; the character must be logged out),
  the experience lock and its unlock, 60/70/80 starter packs (pre-raid gear
  for the character's class/spec), and 60/70/80 raid consumable packs
  (flasks, elixirs, potions, weapon oils, protection potions, buff food).
  Gear and consumables arrive by in-game mail.
- **Experience lock** — freezes a character at its current level: kill,
  quest and exploration XP all stop counting, which is what twinks want for a
  BG bracket. It is a row in `summonstack_web.shop_xp_locks`, read by
  `worldserver/lua_scripts/xp.lua` every 5 seconds and on each login, so it
  applies without a restart and survives one. **Remove Experience Lock**
  lifts it. A level boost is refused on a locked character — it sets the
  level outright and would walk straight past the lock — so unlock first.
  Locks are per character, not per account. To sell a bracket lock instead
  (bought early, biting on arrival), add a product row with
  `payload = {"action":"lock","level":19}`; no code change needed.
- **Gear coverage** — all three starter packs cover 9 classes × 17 specs,
  including tank and healer sets. A few slots are intentionally empty where
  no suitable item exists at that bracket; the `note` field on each entry
  names the item so lists are reviewable without a database lookup.
- **Load the catalog** with `task shop:seed`. Pack contents live in
  `webapp/data/packs/*.json` — edit those and re-run the seed, which
  validates every item id against `acore_world.item_template`, aborts on
  unknown ids, and warns when a `count` exceeds the item's stack size.
- **Give players points** in the admin panel under **Shop points**
  (`/admin/shop`): grant or deduct by account name with a reason, and see
  every balance plus the full ledger. `task shop:grant USER=name AMOUNT=500`
  does the same from the terminal.
- **How players receive purchases** — level and profession boosts apply to
  the character directly, experience locks take hold within a few seconds;
  item packs arrive as in-game **mail** from the
  worldserver. Mail holds 12 attachments, so a full gear pack is split
  across two or three letters. Tell players to check a mailbox; mail expires
  after 30 days if never collected.
- **Prices** are seeded once and then owned by the DB — edit
  `summonstack_web.shop_products` to tune them; reseeds won't overwrite.
- **Stuck orders**: deliveries that fail cleanly refund automatically. A
  SOAP timeout leaves the order in `delivering` (the goods may or may not
  have arrived) — check `summonstack_web.shop_transactions` and the game's
  mail log before refunding by hand.

## Summon rewards

The realm keeps a running count of every summon, shown on the front page, and
pays the summoner shop points for it. **Admin → Summons** (`/admin/summons`)
owns the rate and the anti-farm rules, and lists recent summons with what each
one paid.

- **What counts as a summon.** A player casts a warlock Ritual of Summoning
  (spell 7720, from the Summoning Portal gameobject) or clicks a meeting stone
  (23598) at another player, *and that player actually arrives*. The core sends
  a summon as an offer with two minutes to accept, and the accepted teleport
  lands the target on the caster's position at cast time — so
  `worldserver/lua_scripts/summons.lua` parks each cast and only counts it once
  the target turns up within 30 yards of that spot. A ritual spammed at someone
  who never clicks Accept earns nothing, and neither does a cast at someone
  already standing next to you.
- **Who gets paid.** The summoner, 5 points by default, up to 100 points a day.
  Summoning an alt on your own account never pays — that one is not tunable.
  Beyond that, the same two accounts only pay each other once every 30 minutes.
  All three numbers are editable in the panel.
- **Worth more to summon.** Under **Worth more to summon** you can put a
  multiplier on an account: summoning any of *its* characters pays the summoner
  that much (2× by default, anything from 0 to 10). Useful for the player
  everyone struggles to reach, or a launch-week bonus. The multiplier is on the
  *summoned* account, so it does nothing for that account's own summons, and
  `0` makes summoning them worth nothing — the way to shut one farm down
  without turning rewards off for the realm. Whoever is currently worth extra
  is listed on the front page and in the shop, so players know who to look for,
  and the multiplier that applied is frozen onto the summon row and named in
  the ledger note.
- **Where the money moves.** The Lua script only appends rows to
  `summonstack_web.summon_events`; the portal turns each row into points, keyed
  on the row id, so one summon can never pay twice. Every payout is a `summon`
  row in the shop ledger, visible under **Shop points** alongside purchases.
- **The payout is lazy.** Nothing in this stack schedules jobs, so the sweep
  runs when the front page, the shop or the admin page is loaded. A fresh summon
  therefore shows up in a balance within seconds of anyone touching the portal,
  not the instant it happens — the in-game line says the points land "on the
  portal" for that reason. The realm counter itself is live either way.
- **Players are told**: the summoner gets a line in chat with the realm summon
  number and what it is worth — including any bounty on the person they
  summoned — and every 50th summon is announced server-wide (`announceEvery`,
  0 to stay quiet).
- **Turning payouts off keeps the counter.** Those summons are recorded as
  unpaid and are never paid retroactively when you turn rewards back on.
- **Same mounting rules as the XP script** — see the notes below, including the
  `seen_at` heartbeat the panel warns about. If the worldserver is not reading,
  no summon is counted at all.

## XP events

**Admin → XP event** (`/admin/event`) runs a server-wide experience boost —
the 3.3.5a equivalent of Joyous Journeys — with no restart and nobody
disconnected. Set a multiplier, optionally an end time, and start it.

- **How it works.** The panel writes one row to `summonstack_web.xp_event`.
  `worldserver/lua_scripts/xp.lua` polls that row every 15 seconds and
  multiplies XP in the worldserver's `OnGiveXP` hook, which covers kill,
  quest and exploration XP alike. Rested and heirloom bonuses stack on top as
  usual.
- **One script owns the XP hook.** `xp.lua` also applies the shop's
  experience locks, deliberately in the same file: two scripts registering
  `OnGiveXP` would both run and the engine keeps whichever returned last, so
  a running event could hand XP back to a locked character. A lock wins,
  otherwise the multiplier applies.
- **Players are told**: a server-wide announcement on start and end, a line
  in chat on login while it runs, and a buff icon for as long as it lasts.
- **About the buff icon.** Joyous Journeys itself is a Classic-2019 spell
  and does not exist in 3.3.5a, so the icon is spell 12655
  ("Enlightenment"), which has no combat effect. It is decoration only — the
  XP comes from the script — so any spell id works, and `0` runs the event
  with no icon. Avoid 57353/71354: those are the heirloom XP auras and would
  add a real bonus on top of the multiplier.
- **The script is mounted, not baked in.** `worldserver/lua_scripts` is bind
  mounted into `ac-worldserver`, and `worldserver/mod_ale.conf` turns the
  image's bundled Lua engine on — it ships only a `.conf.dist`, so without
  that file nothing runs. Both arrive with `docker compose up -d`; until a
  checkout has done that, the toggle saves but the game ignores it, and the
  panel says so rather than pretending the event is live.
- **Editing the script needs no restart.** The engine watches the directory
  and reloads within a second or two of a save, including through the bind
  mount. `.reload ale` in the admin console forces it. A broken script logs
  `[ALE]: Error loading ...` with a line number to `task logs -- ac-worldserver`
  and leaves the other scripts running.
- **Replacing the directory does need a restart.** A bind mount follows the
  inode, not the path, so anything that recreates `worldserver/lua_scripts`
  itself — deleting it, a branch switch that removes and restores it —
  detaches the running container from the real directory. Scripts then stop
  silently: no error, no reload, and `docker compose exec ac-worldserver ls
  /azerothcore/lua_scripts` comes back empty while the host directory is
  full. `docker compose up -d --force-recreate ac-worldserver` reattaches it.
  The `seen_at` heartbeat on `summonstack_web.xp_event` is the tell — if the
  XP event panel says the worldserver is not reading, this is why.

## API collection

`bruno/` is a [Bruno](https://usebruno.com) collection covering every portal
route — auth, account, shop, and admin. Open that directory in Bruno, pick the
**Local** environment, fill in the two secret password variables, and run
`Auth / Login` first: the session cookie is picked up automatically from there.

The `Smoke` folder logs in and then only reads, so it works as a post-deploy
check with the CLI:

```bash
cd bruno && bru run Smoke --env Local
```

Destructive admin actions (bans, GM levels, password resets) live in a separate
`Danger Zone` folder so a stray full-collection run cannot fire them. See
[bruno/README.md](bruno/README.md).

## Tests

The portal has a unit suite, run with Node's built-in test runner:

```bash
cd webapp && npm test          # compiles src/lib, then runs test/
cd webapp && npm run typecheck
```

It needs no database and no running stack. The database is stubbed, which is
the point: the things worth pinning down here are the ones a live server would
happily get wrong without complaining — which realm a delivery command is
addressed to, which character database a write lands in, which realm's
settings priced a payout, and whether a refused summon really records nothing.

The suite also covers `worldserver/lua_scripts/`. Those scripts are parsed as
Lua 5.1 and their hooks are driven under a Lua VM with the Eluna API stubbed
(`webapp/test/helpers/`), because a mistake there otherwise surfaces only when
a realm starts.

CI runs the same commands, plus `next build`, `docker compose config` and a
byte-compile of `scripts/` — see `.github/workflows/ci.yml`.

## First-time setup

**1. Configure secrets.** A `.env` was generated with random values — review
it (or copy `.env.sample` to `.env` and fill it in yourself).

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

**4. Wire up the SOAP console.** `task admin` already did this if the console
had never been configured — it writes the credentials, reloads the webapp, and
confirms the worldserver accepts them. To point the console at a *different*
account later, which is not automatic so that creating a second admin cannot
quietly take the console over:

```bash
task soap USER=someoneelse PASS=TheirPassword1
```

By hand instead: set `SOAP_USER`/`SOAP_PASS` in `.env` and reload with
`docker compose up -d ac-webapp`.

**5. Log in** at <http://localhost:8080/login> with the admin account, open
**Admin**, and create invite links for your players. Each link can be used
once; registration without a link is impossible.

## Letting other people connect

Out of the box the realm address is `127.0.0.1` — only you can play. The admin
panel's **Realm** tab (`/admin/realm`) shows the current address, flags it while
it is still local-only, and spells out the steps below. To let others connect,
point the realm at your LAN IP or public hostname:

```bash
docker compose exec ac-database mysql -uroot -p"$(grep ^DOCKER_DB_ROOT_PASSWORD .env | cut -d= -f2)" -e "UPDATE acore_auth.realmlist SET address='YOUR.LAN.OR.PUBLIC.IP' WHERE id=1;"
```

Also set `PUBLIC_HOST` in `.env` to the hostname players type in the browser
(a domain or a LAN/public IP) and restart with `docker compose up -d` — invite
links and the client-download button are built from it, so while it is
`localhost` they only work on this machine. Forward/allow TCP **3724**
(login), **8085** (world), **8080** (website), and **8081** (downloads).

Behind a reverse proxy, or on non-default ports, set `SITE_URL` and
`DOWNLOAD_URL` explicitly instead; either one overrides the `PUBLIC_HOST`
default.

Players need a 3.3.5a client with `Data/<locale>/realmlist.wtf` set to
`set realmlist YOUR.LAN.OR.PUBLIC.IP` — the homepage shows the exact line.

## Network exposure: ZeroTier & Cloudflare Tunnels

If you do not want to open/forward ports on your router, SummonStack includes built-in optional services for **ZeroTier** (virtual LAN overlay) and **Cloudflare Tunnels** (secure edge proxy).

### Exposing via ZeroTier (Game Client + Web Portal)

ZeroTier creates a private virtual network (LAN over WAN). All game server ports (`3724`, `8085`) and web portal ports (`8080`, `8081`) become reachable over your ZeroTier IP to anyone on the network without port forwarding.

1. **Join a network:**
   ```bash
   task zerotier:join NETWORK=8056c2e297xxxxxx
   ```
2. **Authorize the node:** In your [ZeroTier Central](https://my.zerotier.com) dashboard, check the box to authorize the node.
3. **Check status & IP:**
   ```bash
   task zerotier:status
   ```
4. **Update Realm & PUBLIC_HOST:** Set `PUBLIC_HOST=<your-zerotier-ip>` in `.env` and update the realm address in `/admin/realm` (or run MySQL UPDATE on `acore_auth.realmlist`). Players joined to your ZeroTier network set their `realmlist.wtf` to `<your-zerotier-ip>`.

### Exposing via Cloudflare Tunnel (Web Portal + Downloads)

Cloudflare Tunnels securely expose the web portal (`ac-webapp`) and client downloads (`ac-downloads`) through Cloudflare's edge network with automatic HTTPS.

1. **Create a tunnel** in [Cloudflare Zero Trust](https://one.dash.cloudflare.com) under *Networks -> Tunnels*.
2. **Add ingress rules in Cloudflare:**
   - `https://wow.yourdomain.com` -> `http://ac-webapp:3000`
   - `https://dl.yourdomain.com` -> `http://ac-downloads:80`
3. **Start the tunnel:**
   ```bash
   task cloudflare:token TOKEN=eyJh...
   ```
4. **Check tunnel status:**
   ```bash
   task cloudflare:status
   ```
5. Set `SITE_URL=https://wow.yourdomain.com` and `DOWNLOAD_URL=https://dl.yourdomain.com` in `.env` and restart with `task up`.

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
(Ports do not matter — cookies are not port-scoped.) Leaving both unset and
setting only `PUBLIC_HOST` keeps them in step automatically.

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
- The two Lua scripts in `worldserver/lua_scripts` talk to the webapp through
  the database only, in both directions: `xp.lua` reads the XP event and the
  shop's experience locks, and `summons.lua` reads its reward settings and
  appends the summons it counts. Neither calls the portal, and the portal never
  calls the worldserver except over SOAP for shop deliveries.

## Security notes

- `SESSION_SECRET` is **required** — the stack refuses to start without it,
  and the portal refuses to sign a cookie with a value shorter than 16
  characters or with either of the old example values. The cookie carries an
  account id and admin rights are read live for whatever it claims, so a
  guessable signing key is an admin takeover. Generate one with
  `openssl rand -base64 32`.
- Keep `.env` private — it holds the DB root password, session-signing
  secret, and SOAP credentials. It is `.gitignore`d.
- MySQL (3306) and SOAP (7878) are bound to `127.0.0.1` on the host on
  purpose; don't expose them publicly.
- If you put the site on the public internet, run it behind a reverse proxy
  with HTTPS (Caddy/Traefik/nginx) and set `SITE_URL=https://…` so session
  cookies are marked `Secure`.
- Sessions are revocable. Every authenticated request re-checks the account,
  so banning someone or resetting their password ends their portal session
  immediately rather than whenever the seven-day cookie expires. Changing your
  own password keeps you signed in and drops your other sessions.
- The portal defaults to a production build. `task dev` switches it to hot
  reload — convenient locally, but `next dev` serves stack traces in its error
  overlay, so it is not what a host people can reach should run.

## Portal mode: dev or prod

The portal container runs one of two ways, chosen by `WEBAPP_MODE` in `.env`:

| Mode | What runs | Use it for |
|------|-----------|------------|
| `prod` (default) | the built image, `node server.js` | anything others can reach |
| `dev` | `next dev` with `webapp/src` bind-mounted | working on the portal |

Switch with one command — it edits `.env` and recreates just the portal:

```bash
task dev      # hot reload
task prod     # production build
task mode     # which one is active right now
```

The mode lives in `.env` rather than in a flag because **every** task reads it:
`task up`, `task logs`, `task restart`, `task rebuild` all act on the mode you
are in. Passing `-f docker-compose.dev.yml` to `up` alone would have left the
next command quietly recreating the container in the other mode.

Under the hood the Taskfile turns `WEBAPP_MODE` into `COMPOSE_FILE`. That also
disables compose's automatic loading of `docker-compose.override.yml`, so the
generated realm file is listed explicitly — if you run `docker compose`
directly rather than through `task`, pass the same list:

```bash
COMPOSE_FILE=docker-compose.yml:docker-compose.override.yml:docker-compose.dev.yml \
  docker compose ps
```
