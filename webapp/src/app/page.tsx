import Link from "next/link";
import { getServerStatus } from "@/lib/status";
import { getSession } from "@/lib/session";

export const dynamic = "force-dynamic";

// Display only — update alongside the file mounted into ac-downloads.
const CLIENT_SIZE = "~16.5 GB";

function downloadUrl(): string {
  const base = (process.env.DOWNLOAD_URL || "http://localhost:8081").replace(
    /\/$/,
    ""
  );
  return `${base}/files/client.zip`;
}

function formatUptime(seconds: number): string {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return `${d}d ${h}h ${m}m`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

export default async function HomePage() {
  const status = await getServerStatus();
  const session = await getSession();
  const realmlist = status.realmAddress
    ? `set realmlist ${status.realmAddress}`
    : "set realmlist 127.0.0.1";

  return (
    <>
      <h1>{status.realmName ?? "SummonStack"}</h1>
      <p className="muted">
        A private World of Warcraft — Wrath of the Lich King (3.3.5a) realm.
        Registration is invite-only: ask an admin for an invite link.
      </p>

      <div className="grid">
        <div className="card stat">
          <div className="label">Login Server</div>
          <div className={`value ${status.authOnline ? "status-up" : "status-down"}`}>
            {status.authOnline ? "Online" : "Offline"}
          </div>
        </div>
        <div className="card stat">
          <div className="label">World Server</div>
          <div className={`value ${status.worldOnline ? "status-up" : "status-down"}`}>
            {status.worldOnline ? "Online" : "Offline"}
          </div>
        </div>
        <div className="card stat">
          <div className="label">Players Online</div>
          <div className="value">
            {status.playersOnline !== null ? status.playersOnline : "—"}
          </div>
        </div>
        <div className="card stat">
          <div className="label">Uptime</div>
          <div className="value">
            {status.uptimeSeconds !== null ? formatUptime(status.uptimeSeconds) : "—"}
          </div>
        </div>
      </div>

      <div className="card">
        <h2>Game client</h2>
        {session ? (
          <>
            <p className="muted">
              The full 3.3.5a client, ready to play — no patching needed. The
              download resumes if it gets interrupted, so you can pause and
              come back to it.
            </p>
            <p>
              <a className="btn" href={downloadUrl()}>
                Download client ({CLIENT_SIZE})
              </a>
            </p>
          </>
        ) : (
          <p className="muted">
            <Link href="/login">Log in</Link> to download the game client. If
            you do not have an account yet, ask an admin for an invite link.
          </p>
        )}
      </div>

      <div className="card">
        <h2>How to connect</h2>
        <ol>
          <li>
            Download and unzip the 3.3.5a client above (or use your own WotLK
            client).
          </li>
          <li>
            Open <code className="mono">Data/enUS/realmlist.wtf</code> (or your
            locale folder) in the client directory and replace its contents
            with: <code className="mono">{realmlist}</code>
          </li>
          <li>
            Log in with the account you created through your invite link. Your
            web login and game login are the same.
          </li>
        </ol>
      </div>
    </>
  );
}
