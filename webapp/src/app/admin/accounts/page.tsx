"use client";

import { useCallback, useEffect, useState } from "react";

interface Account {
  id: number;
  username: string;
  email: string;
  joindate: string;
  last_login: string | null;
  last_ip: string;
  gmlevel: number;
  banned: number;
  characters: number;
  online: number;
}

export default function AdminAccountsPage() {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [query, setQuery] = useState("");
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const load = useCallback(async (q: string) => {
    const res = await fetch(`/api/admin/accounts?q=${encodeURIComponent(q)}`);
    if (res.ok) {
      const data = await res.json();
      setAccounts(data.accounts);
    }
  }, []);

  useEffect(() => {
    load("");
  }, [load]);

  async function action(payload: Record<string, unknown>, confirmText?: string) {
    if (confirmText && !window.confirm(confirmText)) return;
    setMsg(null);
    const res = await fetch("/api/admin/accounts/actions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      setMsg({ ok: false, text: data.error ?? "Action failed." });
    } else {
      setMsg({ ok: true, text: "Done." });
    }
    load(query);
  }

  function banAccount(account: Account) {
    const reason = window.prompt(
      `Ban ${account.username}?\n\nReason:`,
      "Banned via admin panel"
    );
    if (reason === null) return;
    const daysRaw = window.prompt(
      "Ban length in days (0 or empty = permanent):",
      "0"
    );
    if (daysRaw === null) return;
    action({
      accountId: account.id,
      action: "ban",
      reason,
      days: Number(daysRaw) || 0,
    });
  }

  function resetPassword(account: Account) {
    const newPassword = window.prompt(
      `New password for ${account.username} (8-16 characters):`
    );
    if (!newPassword) return;
    action({ accountId: account.id, action: "password", newPassword });
  }

  return (
    <>
      <div className="card">
        <form
          className="row"
          onSubmit={(e) => {
            e.preventDefault();
            load(query);
          }}
        >
          <input
            className="input"
            style={{ maxWidth: 320 }}
            placeholder="Search username or email…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <button className="btn secondary">Search</button>
        </form>
        {msg && <div className={`msg ${msg.ok ? "ok" : "error"}`}>{msg.text}</div>}
      </div>

      <div className="card">
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th>ID</th>
                <th>Username</th>
                <th>Email</th>
                <th>Chars</th>
                <th>Status</th>
                <th>GM</th>
                <th>Last login</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {accounts.map((account) => (
                <tr key={account.id}>
                  <td>{account.id}</td>
                  <td className="mono">{account.username}</td>
                  <td>{account.email || <span className="muted">—</span>}</td>
                  <td>{account.characters}</td>
                  <td>
                    {account.banned ? (
                      <span className="pill red">banned</span>
                    ) : account.online ? (
                      <span className="pill green">online</span>
                    ) : (
                      <span className="pill gray">offline</span>
                    )}
                  </td>
                  <td>
                    <select
                      className="input"
                      style={{ width: 90, padding: "0.25rem 0.4rem" }}
                      value={account.gmlevel}
                      onChange={(e) =>
                        action(
                          {
                            accountId: account.id,
                            action: "gmlevel",
                            level: Number(e.target.value),
                          },
                          `Set GM level of ${account.username} to ${e.target.value}?`
                        )
                      }
                    >
                      <option value={0}>Player</option>
                      <option value={1}>GM 1</option>
                      <option value={2}>GM 2</option>
                      <option value={3}>Admin</option>
                    </select>
                  </td>
                  <td>
                    {account.last_login
                      ? new Date(account.last_login).toLocaleDateString()
                      : "never"}
                  </td>
                  <td>
                    <div className="row" style={{ gap: "0.4rem", flexWrap: "nowrap" }}>
                      {account.banned ? (
                        <button
                          className="btn secondary small"
                          onClick={() =>
                            action(
                              { accountId: account.id, action: "unban" },
                              `Unban ${account.username}?`
                            )
                          }
                        >
                          Unban
                        </button>
                      ) : (
                        <button
                          className="btn danger small"
                          onClick={() => banAccount(account)}
                        >
                          Ban
                        </button>
                      )}
                      <button
                        className="btn secondary small"
                        onClick={() => resetPassword(account)}
                      >
                        Set pass
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
              {accounts.length === 0 && (
                <tr>
                  <td colSpan={8} className="muted">
                    No accounts found.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        <p className="muted" style={{ marginBottom: 0 }}>
          Bans take effect at next login; to kick someone who is online, use{" "}
          <span className="mono">kick &lt;charname&gt;</span> in the console.
        </p>
      </div>
    </>
  );
}
