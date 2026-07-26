import type { Metadata } from "next";
import Link from "next/link";
import "./globals.css";
import { getSession } from "@/lib/session";
import { getGmLevel } from "@/lib/auth";
import LogoutButton from "./logout-button";

export const metadata: Metadata = {
  title: "SummonStack — WotLK Private Server",
  description: "AzerothCore private server portal",
};

export const dynamic = "force-dynamic";

export default async function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await getSession();
  let isAdmin = false;
  if (session) {
    try {
      isAdmin = (await getGmLevel(session.accountId)) >= 3;
    } catch {
      // DB may not be up yet; render nav without admin link.
    }
  }

  return (
    <html lang="en">
      <body>
        <header className="site-header">
          <div className="inner">
            <Link href="/" className="brand">
              ⚔ SummonStack
            </Link>
            <nav className="nav" style={{ flex: 1 }}>
              <Link href="/">Home</Link>
              {session && <Link href="/account">My Account</Link>}
              {isAdmin && <Link href="/admin">Admin</Link>}
              <span className="spacer" />
              {session ? (
                <>
                  <span className="muted">{session.username}</span>
                  <LogoutButton />
                </>
              ) : (
                <Link href="/login">Log in</Link>
              )}
            </nav>
          </div>
        </header>
        <main className="container">{children}</main>
      </body>
    </html>
  );
}
