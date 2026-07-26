// Creates (or promotes) a GM-level-3 admin account directly in the auth DB.
//
// Usage (inside the running stack):
//   docker compose exec ac-webapp node scripts/create-admin.mjs <username> <password>
import { createHash, randomBytes } from "node:crypto";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const mysql = require("mysql2/promise");

const N = BigInt(
  "0x894B645E89E1535BBDAD5B8B290650530801B18EBFBF5E8FAB3C82872A3E9BB7"
);
const g = 7n;

function sha1(...buffers) {
  const hash = createHash("sha1");
  for (const buf of buffers) hash.update(buf);
  return hash.digest();
}

function fromLE(buf) {
  let result = 0n;
  for (let i = buf.length - 1; i >= 0; i--) result = (result << 8n) | BigInt(buf[i]);
  return result;
}

function toLE(value, length) {
  const buf = Buffer.alloc(length);
  for (let i = 0; i < length; i++) {
    buf[i] = Number(value & 0xffn);
    value >>= 8n;
  }
  return buf;
}

function modPow(base, exp, mod) {
  let result = 1n;
  base %= mod;
  while (exp > 0n) {
    if (exp & 1n) result = (result * base) % mod;
    base = (base * base) % mod;
    exp >>= 1n;
  }
  return result;
}

const [username, password] = process.argv.slice(2);
if (!username || !password) {
  console.error("Usage: node scripts/create-admin.mjs <username> <password>");
  process.exit(1);
}
if (!/^[A-Za-z0-9]{3,16}$/.test(username)) {
  console.error("Username must be 3-16 letters or numbers.");
  process.exit(1);
}
if (password.length < 8 || password.length > 16) {
  console.error("Password must be 8-16 characters (the game client caps at 16).");
  process.exit(1);
}

const AUTH_DB = process.env.AUTH_DB || "acore_auth";
const conn = await mysql.createConnection({
  host: process.env.DB_HOST || "127.0.0.1",
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER || "root",
  password: process.env.DB_PASS || "",
});

const salt = randomBytes(32);
const h1 = sha1(Buffer.from(`${username.toUpperCase()}:${password.toUpperCase()}`, "utf8"));
const verifier = toLE(modPow(g, fromLE(sha1(salt, h1)), N), 32);

const [existing] = await conn.query(
  `SELECT id FROM \`${AUTH_DB}\`.account WHERE username = ?`,
  [username.toUpperCase()]
);

let accountId;
if (existing.length > 0) {
  accountId = existing[0].id;
  await conn.query(
    `UPDATE \`${AUTH_DB}\`.account SET salt = ?, verifier = ?, session_key = NULL WHERE id = ?`,
    [salt, verifier, accountId]
  );
  console.log(`Account ${username.toUpperCase()} already existed — password updated.`);
} else {
  const [result] = await conn.query(
    `INSERT INTO \`${AUTH_DB}\`.account (username, salt, verifier, joindate, expansion)
     VALUES (?, ?, ?, NOW(), 2)`,
    [username.toUpperCase(), salt, verifier]
  );
  accountId = result.insertId;
  console.log(`Account ${username.toUpperCase()} created (id ${accountId}).`);
}

await conn.query(
  `INSERT INTO \`${AUTH_DB}\`.account_access (id, gmlevel, RealmID, comment)
   VALUES (?, 3, -1, 'created by create-admin script')
   ON DUPLICATE KEY UPDATE gmlevel = 3`,
  [accountId]
);
console.log(`GM level 3 granted on all realms.`);
console.log(``);
console.log(`To use this account for the live admin console, either run:`);
console.log(`  task soap USER=${username} PASS=<the password>`);
console.log(`or do it by hand:`);
console.log(`  1. Set SOAP_USER=${username} and SOAP_PASS=<the password> in .env`);
console.log(`  2. Run: docker compose up -d ac-webapp   (to reload the webapp env)`);
console.log(``);
console.log(`Then log in at the website and open /admin.`);

await conn.end();
