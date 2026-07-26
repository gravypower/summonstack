import { getServerStatus } from "@/lib/status";

export const dynamic = "force-dynamic";

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
        <h2>How to connect</h2>
        <ol>
          <li>Install a World of Warcraft 3.3.5a (WotLK) client.</li>
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
