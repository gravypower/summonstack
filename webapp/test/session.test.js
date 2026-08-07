const test = require("node:test");
const assert = require("node:assert/strict");
const { createHmac } = require("node:crypto");

const session = require("../.test-build/session.js");

const GOOD_SECRET = "a-genuinely-long-random-secret";

function withSecret(value, fn) {
  const before = process.env.SESSION_SECRET;
  process.env.SESSION_SECRET = value;
  try {
    return fn();
  } finally {
    if (before === undefined) delete process.env.SESSION_SECRET;
    else process.env.SESSION_SECRET = before;
  }
}

// The cookie carries an account id and nothing else, and requireAdmin() reads
// gmlevel live for whatever id it claims — so anyone who can sign a token can
// mint an admin session. These four values must never produce one.
test("refuses to sign with a secret an attacker could know", () => {
  for (const bad of [
    ["", "unset or empty"],
    ["please-change-me", "the old docker-compose default"],
    ["change-me-session-secret", "the old .env.example value"],
    ["short", "under 16 characters"],
  ]) {
    const [value, why] = bad;
    withSecret(value, () => {
      assert.throws(
        () => session.createSessionToken(1, "ADMIN"),
        /SESSION_SECRET/,
        `expected ${why} to be refused`
      );
    });
  }
});

test("a real secret round-trips a session", () => {
  withSecret(GOOD_SECRET, () => {
    const parsed = session.parseSessionToken(
      session.createSessionToken(42, "PLAYER")
    );
    assert.equal(parsed.accountId, 42);
    assert.equal(parsed.username, "PLAYER");
    assert.ok(parsed.exp > Math.floor(Date.now() / 1000));
  });
});

test("rejects a tampered signature", () => {
  withSecret(GOOD_SECRET, () => {
    const token = session.createSessionToken(42, "PLAYER");
    assert.equal(session.parseSessionToken(token.slice(0, -1) + "x"), null);
  });
});

test("rejects a token signed with a different secret", () => {
  const token = withSecret(GOOD_SECRET, () =>
    session.createSessionToken(1, "ADMIN")
  );
  withSecret("a-completely-different-long-secret", () => {
    assert.equal(session.parseSessionToken(token), null);
  });
});

test("rejects an expired token", () => {
  withSecret(GOOD_SECRET, () => {
    const body = Buffer.from(
      JSON.stringify({ accountId: 1, username: "A", exp: 1 })
    ).toString("base64url");
    const sig = createHmac("sha256", GOOD_SECRET).update(body).digest("base64url");
    assert.equal(session.parseSessionToken(`${body}.${sig}`), null);
  });
});

// Anonymous browsing must not trip the secret check, or an unconfigured deploy
// would 500 on every page instead of only on login.
test("no cookie returns null before the secret is ever needed", () => {
  withSecret("", () => {
    assert.equal(session.parseSessionToken(undefined), null);
    assert.equal(session.parseSessionToken(""), null);
  });
});

test("cookie is httpOnly, and secure only when the site is https", () => {
  const before = process.env.SITE_URL;
  try {
    process.env.SITE_URL = "https://wow.example.com";
    assert.equal(session.sessionCookieOptions().secure, true);
    process.env.SITE_URL = "http://192.168.1.10:8080";
    const options = session.sessionCookieOptions();
    assert.equal(options.secure, false);
    assert.equal(options.httpOnly, true);
    assert.equal(options.sameSite, "lax");
  } finally {
    if (before === undefined) delete process.env.SITE_URL;
    else process.env.SITE_URL = before;
  }
});
