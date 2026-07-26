"use client";

import { useCallback, useEffect, useState } from "react";

interface Invite {
  id: number;
  token: string;
  url: string;
  note: string | null;
  created_by: string;
  created_at: string;
  expires_at: string | null;
  used_by: string | null;
  used_at: string | null;
}

export default function AdminInvitesPage() {
  const [invites, setInvites] = useState<Invite[]>([]);
  const [note, setNote] = useState("");
  const [expiresDays, setExpiresDays] = useState("7");
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [copiedId, setCopiedId] = useState<number | null>(null);

  const load = useCallback(async () => {
    const res = await fetch("/api/admin/invites");
    if (res.ok) {
      const data = await res.json();
      setInvites(data.invites);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function createInvite(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setMsg(null);
    const res = await fetch("/api/admin/invites", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ note, expiresDays: Number(expiresDays) || 0 }),
    });
    const data = await res.json().catch(() => ({}));
    setBusy(false);
    if (!res.ok) {
      setMsg({ ok: false, text: data.error ?? "Could not create invite." });
      return;
    }
    setNote("");
    setMsg({ ok: true, text: `Invite created: ${data.url}` });
    try {
      await navigator.clipboard.writeText(data.url);
      setMsg({ ok: true, text: `Invite link copied to clipboard: ${data.url}` });
    } catch {
      // Clipboard may be unavailable over plain http — link is shown anyway.
    }
    load();
  }

  async function copyLink(invite: Invite) {
    try {
      await navigator.clipboard.writeText(invite.url);
      setCopiedId(invite.id);
      setTimeout(() => setCopiedId(null), 1500);
    } catch {
      window.prompt("Copy the invite link:", invite.url);
    }
  }

  async function revoke(id: number) {
    const res = await fetch(`/api/admin/invites?id=${id}`, { method: "DELETE" });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      setMsg({ ok: false, text: data.error ?? "Could not revoke invite." });
    }
    load();
  }

  return (
    <>
      <form className="card" onSubmit={createInvite}>
        <h2>Create invite link</h2>
        <div className="row">
          <input
            className="input"
            style={{ maxWidth: 320 }}
            placeholder="Note (who is this for?)"
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
          <select
            className="input"
            style={{ maxWidth: 180 }}
            value={expiresDays}
            onChange={(e) => setExpiresDays(e.target.value)}
          >
            <option value="1">Expires in 1 day</option>
            <option value="7">Expires in 7 days</option>
            <option value="30">Expires in 30 days</option>
            <option value="0">Never expires</option>
          </select>
          <button className="btn" disabled={busy}>
            {busy ? "Creating…" : "Create invite"}
          </button>
        </div>
        {msg && (
          <div className={`msg ${msg.ok ? "ok" : "error"}`} style={{ wordBreak: "break-all" }}>
            {msg.text}
          </div>
        )}
        <p className="muted">
          Send the link to the person you want to invite — each link can be
          used exactly once.
        </p>
      </form>

      <div className="card">
        <h2>Invites</h2>
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th>Status</th>
                <th>Note</th>
                <th>Created by</th>
                <th>Created</th>
                <th>Expires</th>
                <th>Used by</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {invites.map((invite) => {
                const expired =
                  !invite.used_by &&
                  invite.expires_at &&
                  new Date(invite.expires_at) < new Date();
                return (
                  <tr key={invite.id}>
                    <td>
                      {invite.used_by ? (
                        <span className="pill gray">used</span>
                      ) : expired ? (
                        <span className="pill red">expired</span>
                      ) : (
                        <span className="pill green">active</span>
                      )}
                    </td>
                    <td>{invite.note || <span className="muted">—</span>}</td>
                    <td className="mono">{invite.created_by}</td>
                    <td>{new Date(invite.created_at).toLocaleDateString()}</td>
                    <td>
                      {invite.expires_at
                        ? new Date(invite.expires_at).toLocaleDateString()
                        : "never"}
                    </td>
                    <td className="mono">{invite.used_by ?? "—"}</td>
                    <td>
                      <div className="row" style={{ gap: "0.4rem", flexWrap: "nowrap" }}>
                        {!invite.used_by && !expired && (
                          <button
                            className="btn secondary small"
                            onClick={() => copyLink(invite)}
                          >
                            {copiedId === invite.id ? "Copied!" : "Copy link"}
                          </button>
                        )}
                        {!invite.used_by && (
                          <button
                            className="btn danger small"
                            onClick={() => revoke(invite.id)}
                          >
                            Revoke
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
              {invites.length === 0 && (
                <tr>
                  <td colSpan={7} className="muted">
                    No invites yet.
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
