import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

// SRP6 parameters used by the WoW 3.3.5a auth protocol (AzerothCore).
const N = BigInt(
  "0x894B645E89E1535BBDAD5B8B290650530801B18EBFBF5E8FAB3C82872A3E9BB7"
);
const g = 7n;

function sha1(...buffers: Buffer[]): Buffer {
  const hash = createHash("sha1");
  for (const buf of buffers) hash.update(buf);
  return hash.digest();
}

/** Interpret a buffer as a little-endian unsigned integer. */
function fromLE(buf: Buffer): bigint {
  let result = 0n;
  for (let i = buf.length - 1; i >= 0; i--) {
    result = (result << 8n) | BigInt(buf[i]);
  }
  return result;
}

/** Serialize a bigint as a little-endian buffer of `length` bytes. */
function toLE(value: bigint, length: number): Buffer {
  const buf = Buffer.alloc(length);
  for (let i = 0; i < length; i++) {
    buf[i] = Number(value & 0xffn);
    value >>= 8n;
  }
  return buf;
}

function modPow(base: bigint, exp: bigint, mod: bigint): bigint {
  let result = 1n;
  base %= mod;
  while (exp > 0n) {
    if (exp & 1n) result = (result * base) % mod;
    base = (base * base) % mod;
    exp >>= 1n;
  }
  return result;
}

/**
 * Compute the SRP6 verifier the same way AzerothCore does:
 *   h1 = SHA1(UPPER(user) ":" UPPER(pass))
 *   x  = SHA1(salt || h1) as little-endian integer
 *   v  = g^x mod N, serialized little-endian, 32 bytes
 */
export function computeVerifier(
  username: string,
  password: string,
  salt: Buffer
): Buffer {
  const h1 = sha1(
    Buffer.from(`${username.toUpperCase()}:${password.toUpperCase()}`, "utf8")
  );
  const x = fromLE(sha1(salt, h1));
  return toLE(modPow(g, x, N), 32);
}

/** Fresh salt + verifier for a new account or password change. */
export function makeRegistrationData(username: string, password: string) {
  const salt = randomBytes(32);
  const verifier = computeVerifier(username, password, salt);
  return { salt, verifier };
}

/** Check a password against the stored salt/verifier pair. */
export function verifyPassword(
  username: string,
  password: string,
  salt: Buffer,
  verifier: Buffer
): boolean {
  if (salt.length !== 32 || verifier.length !== 32) return false;
  const computed = computeVerifier(username, password, salt);
  return timingSafeEqual(computed, verifier);
}
