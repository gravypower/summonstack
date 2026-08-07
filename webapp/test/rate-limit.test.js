const test = require("node:test");
const assert = require("node:assert/strict");

const { RateLimiter } = require("../.test-build/rate-limit.js");

// A fixed clock: the limiter takes `now` so the window can be crossed without
// waiting a real minute.
const T0 = 1_700_000_000_000;

test("allows up to the limit, then refuses", () => {
  const limiter = new RateLimiter(3, 60_000);
  for (let i = 0; i < 3; i++) limiter.check(1, T0);
  assert.throws(() => limiter.check(1, T0), /Too many purchases/);
});

test("the refusal is a 429, not a 500", () => {
  const limiter = new RateLimiter(1, 60_000);
  limiter.check(1, T0);
  try {
    limiter.check(1, T0);
    assert.fail("expected a throw");
  } catch (err) {
    assert.equal(err.status, 429);
  }
});

test("accounts are limited independently", () => {
  const limiter = new RateLimiter(1, 60_000);
  limiter.check(1, T0);
  limiter.check(2, T0); // must not throw
  assert.throws(() => limiter.check(1, T0));
});

test("the window slides, so hits age out", () => {
  const limiter = new RateLimiter(2, 60_000);
  limiter.check(1, T0);
  limiter.check(1, T0);
  assert.throws(() => limiter.check(1, T0));
  // One window later the earlier hits no longer count.
  limiter.check(1, T0 + 60_001);
});

// The map used to keep one entry per account that had ever bought anything,
// for the life of the process: the hit array emptied but the key stayed.
test("accounts are evicted once all their hits have aged out", () => {
  const limiter = new RateLimiter(5, 60_000);
  for (let account = 1; account <= 500; account++) limiter.check(account, T0);
  assert.equal(limiter.size, 500);

  // A single later call is enough to sweep everyone whose hits expired.
  limiter.check(999, T0 + 60_001);
  assert.equal(limiter.size, 1, "expired accounts should not be retained");
});

test("an account with a live hit is not evicted", () => {
  const limiter = new RateLimiter(5, 60_000);
  limiter.check(1, T0);
  limiter.check(2, T0 + 59_000);
  limiter.check(3, T0 + 60_001);
  // Account 1 has aged out; account 2 has not.
  assert.equal(limiter.size, 2);
});
