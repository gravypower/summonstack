"use client";

import { useCallback, useEffect, useState } from "react";
import PlayerAutocomplete from "@/app/components/player-autocomplete";

interface SummonRewards {
  enabled: boolean;
  pointsPerSummon: number;
  dailyPointCap: number;
  pairCooldownMinutes: number;
  announceEvery: number;
  updatedBy: string | null;
  updatedAt: string | null;
  seenAt: string | null;
  worldserverReading: boolean;
}

interface Leader {
  /** Guids restart at 1 per realm, so the pair is what identifies a summoner. */
  realmId: number;
  guid: number;
  name: string;
  summons: number;
  points: number;
}

interface Stats {
  total: number;
  last24h: number;
  pointsAwarded: number;
  pending: number;
  top: Leader[];
}

interface SummonRow {
  id: number;
  summoner_name: string;
  summoner_account_name: string | null;
  target_name: string;
  spell: number;
  award_state: "pending" | "awarded" | "skipped";
  awarded_points: number;
  bonus_pct: number;
  skip_reason: string | null;
  created_at: string;
}

/** A multiplier on summoning this account's characters. */
interface Bonus {
  accountId: number;
  username: string | null;
  multiplierPct: number;
  note: string | null;
  createdBy: string | null;
  createdAt: string | null;
  characters: string[];
}

interface Draft {
  pointsPerSummon: string;
  dailyPointCap: string;
  pairCooldownMinutes: string;
  announceEvery: string;
}

const STATE_PILL: Record<string, string> = {
  awarded: "green",
  pending: "gold",
  skipped: "gray",
};

/** Why a summon paid nothing, in words. */
const SKIP_REASON: Record<string, string> = {
  rewards_off: "rewards were off",
  same_account: "own alt",
  pair_cooldown: "pair cooldown",
  daily_cap: "daily cap reached",
  zero_bounty: "0× on the summoned account",
};

/** 200 → "2×", 150 → "1.5×". */
function multiplier(pct: number): string {
  const times = pct / 100;
  return `${Number.isInteger(times) ? times : times.toFixed(1)}×`;
}

const SPELL_SOURCE: Record<number, string> = {
  7720: "ritual",
  23598: "meeting stone",
};

function draftFrom(rewards: SummonRewards): Draft {
  return {
    pointsPerSummon: String(rewards.pointsPerSummon),
    dailyPointCap: String(rewards.dailyPointCap),
    pairCooldownMinutes: String(rewards.pairCooldownMinutes),
    announceEvery: String(rewards.announceEvery),
  };
}

function timeAgo(iso: string): string {
  const seconds = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (seconds < 60) return `${Math.max(seconds, 0)}s ago`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
  return `${Math.round(seconds / 3600)}h ago`;
}

export default function AdminSummonsPage() {
  const [rewards, setRewards] = useState<SummonRewards | null>(null);
  const [stats, setStats] = useState<Stats | null>(null);
  const [recent, setRecent] = useState<SummonRow[]>([]);
  const [bonuses, setBonuses] = useState<Bonus[]>([]);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  // "Double rewards for" form.
  const [bonusUser, setBonusUser] = useState("");
  const [bonusTimes, setBonusTimes] = useState("2");
  const [bonusNote, setBonusNote] = useState("");
  const [bonusMsg, setBonusMsg] = useState<{ ok: boolean; text: string } | null>(
    null
  );
  const [bonusBusy, setBonusBusy] = useState(false);

  // Each realm has its own rewards row, so the form always edits one realm.
  // Stats, recent summons and bounties stay portal-wide.
  const [realms, setRealms] = useState<{ id: number; name: string }[]>([]);
  const [realmId, setRealmId] = useState(1);

  const load = useCallback(async (reseed: boolean, forRealm: number) => {
    const res = await fetch(`/api/admin/summons?realmId=${forRealm}`);
    if (!res.ok) return;
    const data = await res.json();
    setRewards(data.rewards);
    setRealms(data.realms ?? []);
    setStats(data.stats);
    setRecent(data.recent);
    setBonuses(data.bonuses ?? []);
    // Only reseed the form on first load, after a save, and when the realm
    // changes, so the poll cannot yank a field out from under the admin.
    if (reseed) setDraft(draftFrom(data.rewards));
  }, []);

  useEffect(() => {
    // Switching realms reseeds: the form is now showing a different row.
    load(true, realmId);
    const timer = setInterval(() => load(false, realmId), 10000);
    return () => clearInterval(timer);
  }, [load, realmId]);

  async function save(enabled: boolean) {
    if (!draft) return;
    setBusy(true);
    setMsg(null);
    const res = await fetch("/api/admin/summons", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        realmId,
        enabled,
        pointsPerSummon: Number(draft.pointsPerSummon),
        dailyPointCap: Number(draft.dailyPointCap),
        pairCooldownMinutes: Number(draft.pairCooldownMinutes),
        announceEvery: Number(draft.announceEvery),
      }),
    });
    const data = await res.json().catch(() => ({}));
    setBusy(false);
    if (!res.ok) {
      setMsg({ ok: false, text: data.error ?? "Could not save the settings." });
      return;
    }
    setRewards(data.rewards);
    setDraft(draftFrom(data.rewards));
    setMsg({
      ok: true,
      text: data.rewards.enabled
        ? `Saved — a summon is worth ${data.rewards.pointsPerSummon} points. The game picks this up within 15 seconds.`
        : "Saved. Summons are still counted, but they no longer pay points.",
    });
    load(false, realmId);
  }

  async function addBonus(e: React.FormEvent) {
    e.preventDefault();
    setBonusBusy(true);
    setBonusMsg(null);
    // The form talks in multiples; the DB stores percent.
    const res = await fetch("/api/admin/summons/bonus", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        username: bonusUser,
        multiplierPct: Math.round(Number(bonusTimes) * 100),
        note: bonusNote,
      }),
    });
    const data = await res.json().catch(() => ({}));
    setBonusBusy(false);
    if (!res.ok) {
      setBonusMsg({ ok: false, text: data.error ?? "Could not save that." });
      return;
    }
    setBonuses(data.bonuses);
    setBonusMsg({
      ok: true,
      text: `Summoning ${data.username}'s characters now pays ${multiplier(
        Math.round(Number(bonusTimes) * 100)
      )}.`,
    });
    setBonusUser("");
    setBonusNote("");
  }

  async function removeBonus(accountId: number) {
    const res = await fetch(`/api/admin/summons/bonus?accountId=${accountId}`, {
      method: "DELETE",
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      setBonusMsg({ ok: false, text: data.error ?? "Could not remove that." });
      return;
    }
    setBonuses(data.bonuses);
  }

  if (!rewards || !draft || !stats) {
    return (
      <div className="card">
        <p className="muted">Loading…</p>
      </div>
    );
  }

  return (
    <>
      {msg && <div className={`msg ${msg.ok ? "ok" : "error"}`}>{msg.text}</div>}

      {realms.length > 1 && (
        <div className="card" style={{ marginBottom: "1rem" }}>
          <label>
            Realm
            <select
              value={realmId}
              onChange={(e) => setRealmId(Number(e.target.value))}
            >
              {realms.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name}
                </option>
              ))}
            </select>
          </label>
          <p className="muted" style={{ marginBottom: 0, fontSize: "0.875rem" }}>
            What a summon pays is set per realm. Saving here changes {
              realms.find((r) => r.id === realmId)?.name ?? "this realm"
            } only — the totals and bounties below cover every realm.
          </p>
        </div>
      )}

      {!rewards.worldserverReading && (
        <div className="msg error">
          The worldserver has not read these settings
          {rewards.seenAt ? ` since ${timeAgo(rewards.seenAt)}` : " yet"}. The
          Lua script is mounted from{" "}
          <span className="mono">worldserver/lua_scripts</span>, so it only
          appears after a <span className="mono">docker compose up -d</span>{" "}
          that recreates <span className="mono">ac-worldserver</span>. Until
          then no summon is counted at all.
        </div>
      )}

      <div className="grid">
        <div className="card stat">
          <div className="label">Summons on the realm</div>
          <div className="value">{stats.total}</div>
        </div>
        <div className="card stat">
          <div className="label">Last 24 hours</div>
          <div className="value">{stats.last24h}</div>
        </div>
        <div className="card stat">
          <div className="label">Points paid out</div>
          <div className="value">{stats.pointsAwarded}</div>
        </div>
        <div className="card stat">
          <div className="label">Awaiting payout</div>
          <div className="value">{stats.pending}</div>
        </div>
      </div>

      <form
        className="card"
        onSubmit={(e) => {
          e.preventDefault();
          save(rewards.enabled);
        }}
      >
        <h2>
          Summon rewards{" "}
          {rewards.enabled ? (
            <span className="pill green">paying</span>
          ) : (
            <span className="pill gray">counting only</span>
          )}
        </h2>

        <div className="grid">
          <label className="field">
            <span>Points per summon</span>
            <input
              className="input mono"
              type="number"
              min={0}
              value={draft.pointsPerSummon}
              onChange={(e) =>
                setDraft({ ...draft, pointsPerSummon: e.target.value })
              }
              required
            />
          </label>
          <label className="field">
            <span>Daily cap per account — 0 for no cap</span>
            <input
              className="input mono"
              type="number"
              min={0}
              value={draft.dailyPointCap}
              onChange={(e) =>
                setDraft({ ...draft, dailyPointCap: e.target.value })
              }
              required
            />
          </label>
          <label className="field">
            <span>Same-pair cooldown (minutes) — 0 to always pay</span>
            <input
              className="input mono"
              type="number"
              min={0}
              value={draft.pairCooldownMinutes}
              onChange={(e) =>
                setDraft({ ...draft, pairCooldownMinutes: e.target.value })
              }
              required
            />
          </label>
          <label className="field">
            <span>Announce every Nth summon — 0 for silence</span>
            <input
              className="input mono"
              type="number"
              min={0}
              value={draft.announceEvery}
              onChange={(e) =>
                setDraft({ ...draft, announceEvery: e.target.value })
              }
              required
            />
          </label>
        </div>

        <div className="row">
          {rewards.enabled ? (
            <button
              type="button"
              className="btn danger"
              disabled={busy}
              onClick={() => save(false)}
            >
              {busy ? "Saving…" : "Stop paying points"}
            </button>
          ) : (
            <button
              type="button"
              className="btn"
              disabled={busy}
              onClick={() => save(true)}
            >
              {busy ? "Saving…" : "Start paying points"}
            </button>
          )}
          <button className="btn secondary" disabled={busy}>
            Save settings
          </button>
        </div>

        <p className="muted">
          {rewards.updatedBy
            ? `Last changed by ${rewards.updatedBy}${
                rewards.updatedAt ? ` ${timeAgo(rewards.updatedAt)}` : ""
              }. `
            : ""}
          {rewards.worldserverReading && rewards.seenAt
            ? `Worldserver last read this ${timeAgo(rewards.seenAt)}.`
            : ""}
        </p>
      </form>

      <form className="card" onSubmit={addBonus}>
        <h2>Worth more to summon</h2>
        <p className="muted">
          Put a multiplier on an account: whoever summons one of{" "}
          <em>its</em> characters gets that much. Handy for a player everyone
          struggles to reach, or a launch-week bonus. It does nothing for that
          account&apos;s own summons — and <span className="mono">0</span> makes
          summoning them worth nothing, which shuts down one farm without
          turning rewards off for the realm.
        </p>
        <div className="row" style={{ flexWrap: "wrap", gap: "0.75rem" }}>
          <div style={{ flex: 1, minWidth: "180px", maxWidth: "240px" }}>
            <PlayerAutocomplete
              value={bonusUser}
              onChange={(val) => setBonusUser(val)}
              placeholder="Account name..."
              typeFilter="account"
              required
            />
          </div>
          <input
            className="input mono"
            style={{ maxWidth: 110 }}
            type="number"
            min={0}
            max={10}
            step={0.5}
            value={bonusTimes}
            onChange={(e) => setBonusTimes(e.target.value)}
            required
          />
          <input
            className="input"
            style={{ maxWidth: 280 }}
            placeholder="Note (why?)"
            value={bonusNote}
            onChange={(e) => setBonusNote(e.target.value)}
          />
          <button className="btn" disabled={bonusBusy}>
            {bonusBusy ? "Saving…" : "Set multiplier"}
          </button>
        </div>
        {bonusMsg && (
          <div className={`msg ${bonusMsg.ok ? "ok" : "error"}`}>
            {bonusMsg.text}
          </div>
        )}

        {bonuses.length > 0 && (
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>Account</th>
                  <th>Pays</th>
                  <th>Characters</th>
                  <th>Note</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {bonuses.map((b) => (
                  <tr key={b.accountId}>
                    <td className="mono">{b.username ?? `#${b.accountId}`}</td>
                    <td>
                      <span
                        className={`pill ${b.multiplierPct > 100 ? "green" : "gray"}`}
                      >
                        {multiplier(b.multiplierPct)}
                      </span>
                    </td>
                    <td className="mono">
                      {b.characters.length > 0 ? (
                        b.characters.join(", ")
                      ) : (
                        <span className="muted">no characters yet</span>
                      )}
                    </td>
                    <td className="muted">
                      {b.note ?? "—"}
                      {b.createdBy && (
                        <span className="muted"> (by {b.createdBy})</span>
                      )}
                    </td>
                    <td>
                      <button
                        className="btn danger small"
                        onClick={() => removeBonus(b.accountId)}
                      >
                        Remove
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </form>

      <div className="card">
        <h2>How a summon is counted</h2>
        <ul className="muted">
          <li>
            A summon counts when a player casts a warlock Ritual of Summoning
            (spell <span className="mono">7720</span>) or clicks a meeting stone
            (<span className="mono">23598</span>) at another player{" "}
            <em>and that player actually arrives</em>. An offer nobody accepts
            counts as nothing, and neither does a cast at someone already
            standing next to you.
          </li>
          <li>
            Points are credited by the portal, not the game server: the payout
            runs whenever this page, the shop or the front page is loaded, so a
            fresh summon can take a moment to show up in a balance. Every payout
            is a <span className="mono">summon</span> row in the shop ledger.
          </li>
          <li>
            Summoning an alt on your own account never pays. Beyond that the
            cooldown limits how often one pair of players can pay each other,
            and the daily cap limits the total.
          </li>
          <li>
            Turning payouts off leaves the counter running — summons are still
            recorded, just marked as unpaid, and are never paid retroactively if
            you turn them back on.
          </li>
        </ul>
      </div>

      {stats.top.length > 0 && (
        <div className="card">
          <h2>Top summoners</h2>
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>Character</th>
                  <th>Summons</th>
                  <th>Points earned</th>
                </tr>
              </thead>
              <tbody>
                {stats.top.map((leader) => (
                  <tr key={`${leader.realmId}-${leader.guid}`}>
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
        </div>
      )}

      <div className="card">
        <h2>Recent summons</h2>
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th>When</th>
                <th>Summoner</th>
                <th>Summoned</th>
                <th>How</th>
                <th>Reward</th>
              </tr>
            </thead>
            <tbody>
              {recent.map((row) => (
                <tr key={row.id}>
                  <td className="muted">
                    {new Date(row.created_at).toLocaleString()}
                  </td>
                  <td className="mono">
                    {row.summoner_name}
                    {row.summoner_account_name && (
                      <span className="muted"> ({row.summoner_account_name})</span>
                    )}
                  </td>
                  <td className="mono">{row.target_name}</td>
                  <td className="muted">
                    {SPELL_SOURCE[row.spell] ?? `spell ${row.spell}`}
                  </td>
                  <td>
                    <span className={`pill ${STATE_PILL[row.award_state] ?? "gray"}`}>
                      {row.award_state === "awarded"
                        ? `+${row.awarded_points}`
                        : row.award_state}
                    </span>
                    {row.award_state === "awarded" && row.bonus_pct !== 100 && (
                      <span className="muted">
                        {" "}
                        {multiplier(row.bonus_pct)} bounty
                      </span>
                    )}
                    {row.award_state === "skipped" && row.skip_reason && (
                      <span className="muted">
                        {" "}
                        {SKIP_REASON[row.skip_reason] ?? row.skip_reason}
                      </span>
                    )}
                  </td>
                </tr>
              ))}
              {recent.length === 0 && (
                <tr>
                  <td colSpan={5} className="muted">
                    No summons recorded yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}
