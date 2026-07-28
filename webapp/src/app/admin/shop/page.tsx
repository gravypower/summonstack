"use client";

import { useCallback, useEffect, useState } from "react";

interface Balance {
  account_id: number;
  username: string;
  balance: number;
  updated_at: string;
}

interface LedgerRow {
  id: number;
  account_id: number;
  username: string | null;
  delta: number;
  reason: string;
  note: string | null;
  created_at: string;
}

const REASON_PILL: Record<string, string> = {
  admin_grant: "gold",
  vote: "green",
  donation: "green",
  purchase: "gray",
  refund: "red",
  summon: "green",
};

export default function AdminShopPage() {
  const [balances, setBalances] = useState<Balance[]>([]);
  const [ledger, setLedger] = useState<LedgerRow[]>([]);
  const [username, setUsername] = useState("");
  const [amount, setAmount] = useState("500");
  const [note, setNote] = useState("");
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const res = await fetch("/api/admin/shop/grant");
    if (res.ok) {
      const data = await res.json();
      setBalances(data.balances);
      setLedger(data.ledger);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function grant(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setMsg(null);
    const res = await fetch("/api/admin/shop/grant", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, amount: Number(amount), note }),
    });
    const data = await res.json().catch(() => ({}));
    setBusy(false);
    if (!res.ok) {
      setMsg({ ok: false, text: data.error ?? "Could not grant points." });
      return;
    }
    setMsg({
      ok: true,
      text: `${Number(amount) > 0 ? "Granted" : "Deducted"} ${Math.abs(
        Number(amount)
      )} points — ${data.username} now has ${data.balance}.`,
    });
    setNote("");
    load();
  }

  return (
    <>
      <form className="card" onSubmit={grant}>
        <h2>Grant points</h2>
        <div className="row">
          <input
            className="input"
            style={{ maxWidth: 200 }}
            placeholder="Account name"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            required
          />
          <input
            className="input"
            style={{ maxWidth: 130 }}
            type="number"
            placeholder="Amount"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            required
          />
          <input
            className="input"
            style={{ maxWidth: 280 }}
            placeholder="Reason (shown in the ledger)"
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
          <button className="btn" disabled={busy}>
            {busy ? "Saving…" : "Grant"}
          </button>
        </div>
        {msg && <div className={`msg ${msg.ok ? "ok" : "error"}`}>{msg.text}</div>}
        <p className="muted">
          Use a negative amount to take points back. Every change is written to
          the ledger below and can never be silently edited away.
        </p>
      </form>

      <div className="card">
        <h2>Balances</h2>
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th>Account</th>
                <th>Points</th>
                <th>Last change</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {balances.map((b) => (
                <tr key={b.account_id}>
                  <td className="mono">{b.username}</td>
                  <td>
                    <span className="pill gold">{b.balance}</span>
                  </td>
                  <td className="muted">
                    {new Date(b.updated_at).toLocaleString()}
                  </td>
                  <td>
                    <button
                      className="btn secondary small"
                      onClick={() => {
                        setUsername(b.username);
                        window.scrollTo({ top: 0, behavior: "smooth" });
                      }}
                    >
                      Adjust
                    </button>
                  </td>
                </tr>
              ))}
              {balances.length === 0 && (
                <tr>
                  <td colSpan={4} className="muted">
                    Nobody has points yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      <div className="card">
        <h2>Ledger</h2>
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th>When</th>
                <th>Account</th>
                <th>Change</th>
                <th>Reason</th>
                <th>Note</th>
              </tr>
            </thead>
            <tbody>
              {ledger.map((l) => (
                <tr key={l.id}>
                  <td className="muted">
                    {new Date(l.created_at).toLocaleString()}
                  </td>
                  <td className="mono">{l.username ?? `#${l.account_id}`}</td>
                  <td style={{ color: l.delta < 0 ? "var(--bad)" : "var(--good)" }}>
                    {l.delta > 0 ? `+${l.delta}` : l.delta}
                  </td>
                  <td>
                    <span className={`pill ${REASON_PILL[l.reason] ?? "gray"}`}>
                      {l.reason.replace("_", " ")}
                    </span>
                  </td>
                  <td className="muted">{l.note ?? "—"}</td>
                </tr>
              ))}
              {ledger.length === 0 && (
                <tr>
                  <td colSpan={5} className="muted">
                    No point movements yet.
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
