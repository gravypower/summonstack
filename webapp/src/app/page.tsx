import Link from "next/link";
import { getServerStatus } from "@/lib/status";
import { getSession } from "@/lib/session";
import {
  awardPendingSummons,
  formatMultiplier,
  getSummonRewards,
  getSummonStats,
  listSummonBonuses,
} from "@/lib/summons";
import CopyButton from "./copy-button";

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
  // Nothing schedules the summon payout, so portal traffic is what settles it.
  await awardPendingSummons().catch(() => {});
  const summons = await getSummonStats(5).catch(() => null);
  const summonRewards = await getSummonRewards().catch(() => null);
  // Bounties worth showing: a multiplier above normal on someone who actually
  // has characters to summon.
  const bounties = (await listSummonBonuses().catch(() => [])).filter(
    (b) => b.multiplierPct > 100 && b.characters.length > 0
  );
  const realmlist = status.realmAddress
    ? `set realmlist ${status.realmAddress}`
    : "set realmlist 127.0.0.1";

  const isZeroTierEnabled = Boolean(status.zerotierNetworkId);

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
        <div className="card stat">
          <div className="label">Summons</div>
          <div className="value">{summons ? summons.total : "—"}</div>
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

      {summons && summonRewards && (
        <div className="card">
          <h2>Summons</h2>
          <p className="muted">
            {summons.total === 0
              ? "Nobody has been summoned here yet — a warlock ritual or a meeting stone starts the count."
              : `${summons.total} summon${summons.total === 1 ? "" : "s"} on the realm, ` +
                `${summons.last24h} in the last day.`}
            {summonRewards.enabled && summonRewards.pointsPerSummon > 0 && (
              <>
                {" "}
                Summoning another player earns you{" "}
                <strong>{summonRewards.pointsPerSummon} shop points</strong>
                {summonRewards.dailyPointCap > 0
                  ? ` (up to ${summonRewards.dailyPointCap} a day)`
                  : ""}
                , spendable in the <Link href="/shop">shop</Link>.
              </>
            )}
          </p>

          {summonRewards.enabled && bounties.length > 0 && (
            <p>
              <strong>Worth extra right now:</strong>{" "}
              {bounties.map((b, i) => (
                <span key={b.accountId}>
                  {i > 0 && "; "}
                  <span className="mono">{b.characters.join(", ")}</span> at{" "}
                  <span className="pill green">
                    {formatMultiplier(b.multiplierPct)}
                  </span>
                </span>
              ))}
            </p>
          )}

          {summons.top.length > 0 && (
            <div className="table-wrap">
              <table className="data">
                <thead>
                  <tr>
                    <th>Summoner</th>
                    <th>Summons</th>
                    <th>Points earned</th>
                  </tr>
                </thead>
                <tbody>
                  {summons.top.map((leader) => (
                    <tr key={leader.guid}>
                      <td className="mono">{leader.name}</td>
                      <td>{leader.summons}</td>
                      <td>
                        <span className="pill gold">{leader.points}</span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      <div className="card">
        <h2>How to Join & Play</h2>
        <p className="muted">
          Follow these simple steps to join the realm and enter the world of Azeroth.
        </p>

        <div className="join-steps">
          {/* Step 1 */}
          <div className="join-step-card">
            <div className="step-number">1</div>
            <div className="step-content">
              <h3>Create your Account</h3>
              <p className="muted" style={{ margin: 0 }}>
                Registration is invite-only. Request an invite link from a server administrator.
                Your website credentials double as your game login.
              </p>
            </div>
          </div>

          {/* Step 2 */}
          <div className="join-step-card">
            <div className="step-number">2</div>
            <div className="step-content">
              <h3>Get the Game Client</h3>
              <p className="muted" style={{ margin: 0 }}>
                Download and extract the Wrath of the Lich King (3.3.5a) client provided above, or use any standard 3.3.5a installation.
              </p>
            </div>
          </div>

          {/* ZeroTier Section (Conditional) */}
          {isZeroTierEnabled && (
            <div className="join-step-card zerotier-card">
              <div className="step-number" style={{ background: "var(--accent-soft)" }}>⚡</div>
              <div className="step-content">
                <div className="zerotier-badge">ZeroTier Virtual LAN Enabled</div>
                <h3>Connect via ZeroTier Network</h3>
                <p className="muted">
                  This server uses a private ZeroTier VPN overlay to connect players securely without opening public router ports.
                </p>
                <ol style={{ margin: "0.5rem 0 0", paddingLeft: "1.2rem" }}>
                  <li>
                    Download and install the{" "}
                    <a href="https://www.zerotier.com/download/" target="_blank" rel="noreferrer">
                      ZeroTier One Client
                    </a>.
                  </li>
                  <li>
                    Join the realm network ID:
                    <div className="code-copy-bar">
                      <code className="mono">{status.zerotierNetworkId}</code>
                      <CopyButton text={status.zerotierNetworkId!} label="Copy ID" />
                    </div>
                  </li>
                  <li>
                    Ask the server admin to authorize your ZeroTier node address if required.
                  </li>
                </ol>
              </div>
            </div>
          )}

          {/* Realmlist Step */}
          <div className="join-step-card">
            <div className="step-number">{isZeroTierEnabled ? "4" : "3"}</div>
            <div className="step-content">
              <h3>Set your Realmlist</h3>
              <p className="muted">
                Open <code className="mono">Data/enUS/realmlist.wtf</code> (or your client locale folder) in a text editor and replace its contents with:
              </p>
              <div className="code-copy-bar">
                <code className="mono">{realmlist}</code>
                <CopyButton text={realmlist} label="Copy Realmlist" />
              </div>
            </div>
          </div>

          {/* Launch Step */}
          <div className="join-step-card">
            <div className="step-number">{isZeroTierEnabled ? "5" : "4"}</div>
            <div className="step-content">
              <h3>Launch & Play</h3>
              <p className="muted" style={{ margin: 0 }}>
                Launch <code className="mono">Wow.exe</code> and log in using your account username and password. Welcome to the realm!
              </p>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
