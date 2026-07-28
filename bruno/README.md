# SummonStack API collection (Bruno)

A [Bruno](https://usebruno.com) collection covering every route the portal
exposes: auth, account, the shop, and the admin panel.

## Setup

1. Open Bruno → **Open Collection** → pick this `bruno/` directory.
2. Select the **Local** environment (top right).
3. Fill in the two secret variables (Environment settings → Secret):
   - `adminPass` — password for the GM-level-3 account in `adminUser`
   - `playerPass` — password for the ordinary account in `playerUser`

   Secrets are **not** written to disk by Bruno, which is why the passwords are
   declared as secret vars rather than plain ones — nothing here is safe to
   commit otherwise.
4. Run **Auth / Login (admin)**. Bruno's cookie jar keeps the `ss_session`
   cookie, so every request after that is authenticated. Log in as the player
   instead when you want to check that a route correctly refuses a non-admin.

## Layout

| Folder | What's in it |
| ------ | ------------ |
| `Smoke` | Login plus read-only checks, ordered and safe to run headless |
| `Public` | Server status and summon stats — the routes needing no session |
| `Auth` | Login, logout, invite-token check, registration |
| `Account` | Profile, password change, download authorization |
| `Shop` | Catalog, balance, purchase, purchase history |
| `Admin` | Invites, account search, SOAP console, shop points, XP event, summon rewards |
| `Danger Zone` | Bans, GM levels, password resets, invite revocation |

**`Danger Zone` is deliberately separate.** `bru run` executes every request in
whatever folder you point it at, so keeping bans and password resets out of the
main folders means a stray full-collection run can't lock you out of your own
admin account.

## Running headless

```bash
npm install -g @usebruno/cli
```

The `Smoke` folder logs in first and then only reads, so it works as a
post-deploy check:

```bash
cd bruno && bru run Smoke --env Local
```

Each `bru run` is a fresh cookie jar, which is why `Smoke` carries its own login
step rather than relying on one from another folder.

## Request chaining

Some requests publish variables for later ones, so you rarely have to paste ids
by hand:

- `Shop / My balance and characters` → sets `characterGuid` from your first
  character, used by `Shop / Purchase a pack`.
- `Admin / List accounts` → sets `targetAccountId`, used by the `Danger Zone`
  requests.
- `Admin / Create invite` → sets `inviteToken` and `inviteId`, used by
  `Auth / Check invite token` and `Danger Zone / Revoke invite`.

## Notes

- **Purchases need a character.** `Shop / Purchase a pack` returns 404 until the
  logged-in account has a character on the realm, so its test only asserts the
  route answers without a server error.
- **Summon routes double as a write.** `Public / Summon stats` and
  `Admin / Get summon rewards` run the payout sweep that turns recorded summons
  into shop points — nothing else schedules it. Both are idempotent.
- **The SOAP console needs a running worldserver** and `SOAP_USER`/`SOAP_PASS`
  configured in `.env`; otherwise it returns a readable error rather than
  failing outright.
