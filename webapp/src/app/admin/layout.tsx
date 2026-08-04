import Link from "next/link";
import { redirect } from "next/navigation";
import { getSession } from "@/lib/session";
import { getGmLevel } from "@/lib/auth";

export const dynamic = "force-dynamic";

export default async function AdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await getSession();
  if (!session) redirect("/login");
  const gmLevel = await getGmLevel(session.accountId);
  if (gmLevel < 3) redirect("/");

  return (
    <>
      <div className="row" style={{ marginBottom: "1.5rem" }}>
        <h1 style={{ margin: 0, marginRight: "1rem" }}>Admin</h1>
        <nav className="nav">
          <Link href="/admin">Invites</Link>
          <Link href="/admin/accounts">Accounts</Link>
          <Link href="/admin/shop">Shop points</Link>
          <Link href="/admin/event">XP event</Link>
          <Link href="/admin/summons">Summons</Link>
          <Link href="/admin/playerbots">Playerbots</Link>
          <Link href="/admin/realm">Realm</Link>
          <Link href="/admin/console">Console</Link>
        </nav>
      </div>
      {children}
    </>
  );
}
