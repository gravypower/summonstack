const test = require("node:test");
const assert = require("node:assert/strict");

const db = require("../.test-build/db.js");
const { passwordFingerprint } = require("../.test-build/session.js");
const { makePool, contains } = require("./helpers/stub-db.js");

const OLD_SALT = Buffer.alloc(32, 1);
const NEW_SALT = Buffer.alloc(32, 2);

/** A session cookie's payload, as requireSession() would have unsealed it. */
function sessionFor(salt) {
  return {
    accountId: 42,
    username: "PLAYER",
    pv: passwordFingerprint(salt),
    exp: Math.floor(Date.now() / 1000) + 3600,
  };
}

function withAccount({ salt, banned = 0, missing = false }) {
  const pool = makePool([
    [contains("FROM", "account a"), () => [missing ? [] : [{ salt, banned }]]],
  ]);
  db.getPool = () => pool;
  return require("../.test-build/auth.js");
}

test("a session matching the current password is accepted", async () => {
  const auth = withAccount({ salt: OLD_SALT });
  await assert.doesNotReject(() => auth.assertSessionLive(sessionFor(OLD_SALT)));
});

// The salt is regenerated on every password change, so a cookie stamped before
// one no longer matches. This is what makes an admin password reset actually
// lock someone out instead of leaving them signed in for up to seven days.
test("a session predating a password change is rejected", async () => {
  const auth = withAccount({ salt: NEW_SALT });
  await assert.rejects(
    () => auth.assertSessionLive(sessionFor(OLD_SALT)),
    (err) => {
      assert.equal(err.status, 401);
      assert.match(err.message, /password changed/i);
      return true;
    }
  );
});

test("a banned account's session is rejected even with the right password", async () => {
  const auth = withAccount({ salt: OLD_SALT, banned: 1 });
  await assert.rejects(
    () => auth.assertSessionLive(sessionFor(OLD_SALT)),
    (err) => {
      assert.equal(err.status, 403);
      assert.match(err.message, /banned/i);
      return true;
    }
  );
});

test("a deleted account's session is rejected", async () => {
  const auth = withAccount({ salt: OLD_SALT, missing: true });
  await assert.rejects(
    () => auth.assertSessionLive(sessionFor(OLD_SALT)),
    (err) => {
      assert.equal(err.status, 401);
      return true;
    }
  );
});

test("the ban and password checks cost one query, not two", async () => {
  const pool = makePool([
    [contains("FROM", "account a"), () => [[{ salt: OLD_SALT, banned: 0 }]]],
  ]);
  db.getPool = () => pool;
  const auth = require("../.test-build/auth.js");
  await auth.assertSessionLive(sessionFor(OLD_SALT));
  assert.equal(pool.log.length, 1, `issued: ${pool.log.map((q) => q.sql).join(" | ")}`);
});

// An expired ban must not keep locking the account out.
test("the ban check only counts active, unexpired bans", async () => {
  const pool = makePool([
    [contains("FROM", "account a"), () => [[{ salt: OLD_SALT, banned: 0 }]]],
  ]);
  db.getPool = () => pool;
  const auth = require("../.test-build/auth.js");
  await auth.assertSessionLive(sessionFor(OLD_SALT));
  const sql = pool.log[0].sql;
  assert.match(sql, /b\.active = 1/);
  assert.match(sql, /unbandate = b\.bandate OR b\.unbandate > UNIX_TIMESTAMP\(\)/);
});
