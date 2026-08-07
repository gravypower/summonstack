import { createHmac, timingSafeEqual } from "node:crypto";
import { cookies } from "next/headers";

export const SESSION_COOKIE = "ss_session";
const SESSION_TTL_SECONDS = 60 * 60 * 24 * 7; // 7 days

export interface Session {
  accountId: number;
  username: string;
  exp: number;
}

/**
 * Values that have shipped as defaults or examples. A secret everyone can read
 * off GitHub is no secret: the cookie carries the account id and nothing else,
 * and requireAdmin() reads gmlevel live for whatever id the token claims — so
 * anyone able to sign a token can mint an admin session and, through
 * /api/admin/soap, run worldserver console commands.
 */
const PLACEHOLDER_SECRETS = new Set([
  "please-change-me",
  "change-me-session-secret",
]);

const MIN_SECRET_LENGTH = 16;

/**
 * Throws rather than falling back, so a misconfigured deploy fails loudly at
 * the first login instead of running with forgeable cookies. Anonymous
 * browsing is unaffected: parseSessionToken() returns before signing when
 * there is no cookie to check.
 */
function secret(): string {
  const value = process.env.SESSION_SECRET ?? "";
  if (
    !value ||
    PLACEHOLDER_SECRETS.has(value) ||
    value.length < MIN_SECRET_LENGTH
  ) {
    throw new Error(
      "SESSION_SECRET is unset, still the example value, or shorter than " +
        `${MIN_SECRET_LENGTH} characters. Set it to a long random string in ` +
        ".env (openssl rand -base64 32) and restart ac-webapp."
    );
  }
  return value;
}

function sign(data: string): string {
  return createHmac("sha256", secret()).update(data).digest("base64url");
}

export function createSessionToken(accountId: number, username: string): string {
  const payload: Session = {
    accountId,
    username,
    exp: Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS,
  };
  const body = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  return `${body}.${sign(body)}`;
}

export function parseSessionToken(token: string | undefined): Session | null {
  if (!token) return null;
  const dot = token.lastIndexOf(".");
  if (dot < 0) return null;
  const body = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expected = sign(body);
  const sigBuf = Buffer.from(sig);
  const expBuf = Buffer.from(expected);
  if (sigBuf.length !== expBuf.length || !timingSafeEqual(sigBuf, expBuf)) {
    return null;
  }
  try {
    const payload = JSON.parse(
      Buffer.from(body, "base64url").toString("utf8")
    ) as Session;
    if (typeof payload.accountId !== "number" || typeof payload.username !== "string") {
      return null;
    }
    if (payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch {
    return null;
  }
}

export async function getSession(): Promise<Session | null> {
  const store = await cookies();
  return parseSessionToken(store.get(SESSION_COOKIE)?.value);
}

export function sessionCookieOptions() {
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: (process.env.SITE_URL || "").startsWith("https://"),
    path: "/",
    maxAge: SESSION_TTL_SECONDS,
  };
}
