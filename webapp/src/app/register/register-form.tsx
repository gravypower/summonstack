"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

export default function RegisterForm({ token }: { token: string }) {
  const router = useRouter();
  const [inviteValid, setInviteValid] = useState<boolean | null>(null);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [email, setEmail] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    fetch(`/api/auth/register?token=${encodeURIComponent(token)}`)
      .then((res) => res.json())
      .then((data) => setInviteValid(Boolean(data.valid)))
      .catch(() => setInviteValid(false));
  }, [token]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (password !== confirm) {
      setError("Passwords do not match.");
      return;
    }
    setBusy(true);
    const res = await fetch("/api/auth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token, username, password, email }),
    });
    const data = await res.json().catch(() => ({}));
    setBusy(false);
    if (!res.ok) {
      setError(data.error ?? "Registration failed.");
      return;
    }
    router.push("/account");
    router.refresh();
  }

  if (inviteValid === null) {
    return <p className="muted">Checking invite…</p>;
  }
  if (!inviteValid) {
    return (
      <div className="narrow">
        <h1>Create account</h1>
        <div className="msg error">
          This invite link is invalid, expired, or has already been used.
          Please ask an admin for a new one.
        </div>
      </div>
    );
  }

  return (
    <div className="narrow">
      <h1>Create account</h1>
      <p className="muted">
        This creates your <strong>game login</strong> — you will use the same
        account name and password inside World of Warcraft.
      </p>
      <form className="card" onSubmit={submit}>
        <label className="field">
          <span>Account name (3-16 letters/numbers)</span>
          <input
            className="input"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            autoComplete="username"
            required
          />
        </label>
        <label className="field">
          <span>Password (8-16 characters)</span>
          <input
            className="input"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="new-password"
            required
          />
        </label>
        <label className="field">
          <span>Confirm password</span>
          <input
            className="input"
            type="password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            autoComplete="new-password"
            required
          />
        </label>
        <label className="field">
          <span>Email (optional, for account recovery)</span>
          <input
            className="input"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            autoComplete="email"
          />
        </label>
        {error && <div className="msg error">{error}</div>}
        <button className="btn" disabled={busy}>
          {busy ? "Creating…" : "Create account"}
        </button>
      </form>
    </div>
  );
}
