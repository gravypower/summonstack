"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

interface Profile {
  username: string;
  email: string;
  joindate: string;
  lastLogin: string | null;
  isAdmin: boolean;
}

export default function AccountPage() {
  const router = useRouter();
  const [profile, setProfile] = useState<Profile | null>(null);
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    fetch("/api/account/me").then(async (res) => {
      if (res.status === 401) {
        router.push("/login");
        return;
      }
      setProfile(await res.json());
    });
  }, [router]);

  async function changePassword(e: React.FormEvent) {
    e.preventDefault();
    setMsg(null);
    if (newPassword !== confirm) {
      setMsg({ ok: false, text: "New passwords do not match." });
      return;
    }
    setBusy(true);
    const res = await fetch("/api/account/password", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ currentPassword, newPassword }),
    });
    const data = await res.json().catch(() => ({}));
    setBusy(false);
    if (!res.ok) {
      setMsg({ ok: false, text: data.error ?? "Password change failed." });
      return;
    }
    setMsg({
      ok: true,
      text: "Password changed. Use the new password in-game as well.",
    });
    setCurrentPassword("");
    setNewPassword("");
    setConfirm("");
  }

  if (!profile) return <p className="muted">Loading…</p>;

  return (
    <div className="narrow">
      <h1>My account</h1>
      <div className="card">
        <p>
          <strong>Account:</strong> <span className="mono">{profile.username}</span>
        </p>
        <p>
          <strong>Email:</strong> {profile.email || <span className="muted">not set</span>}
        </p>
        <p>
          <strong>Created:</strong>{" "}
          {profile.joindate ? new Date(profile.joindate).toLocaleString() : "—"}
        </p>
        <p>
          <strong>Last game login:</strong>{" "}
          {profile.lastLogin ? new Date(profile.lastLogin).toLocaleString() : "never"}
        </p>
      </div>

      <form className="card" onSubmit={changePassword}>
        <h2>Change password</h2>
        <p className="muted">
          This changes your password for both the website and the game.
        </p>
        <label className="field">
          <span>Current password</span>
          <input
            className="input"
            type="password"
            value={currentPassword}
            onChange={(e) => setCurrentPassword(e.target.value)}
            autoComplete="current-password"
            required
          />
        </label>
        <label className="field">
          <span>New password (8-16 characters)</span>
          <input
            className="input"
            type="password"
            value={newPassword}
            onChange={(e) => setNewPassword(e.target.value)}
            autoComplete="new-password"
            required
          />
        </label>
        <label className="field">
          <span>Confirm new password</span>
          <input
            className="input"
            type="password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            autoComplete="new-password"
            required
          />
        </label>
        {msg && <div className={`msg ${msg.ok ? "ok" : "error"}`}>{msg.text}</div>}
        <button className="btn" disabled={busy}>
          {busy ? "Saving…" : "Change password"}
        </button>
      </form>
    </div>
  );
}
