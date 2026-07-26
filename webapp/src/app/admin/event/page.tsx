"use client";

import { useCallback, useEffect, useState } from "react";

interface XpEvent {
  name: string;
  enabled: boolean;
  multiplier: number;
  auraSpell: number;
  endsAt: string | null;
  updatedBy: string | null;
  updatedAt: string | null;
  seenAt: string | null;
  active: boolean;
  worldserverReading: boolean;
}

interface Draft {
  name: string;
  multiplier: string;
  auraSpell: string;
  endsInHours: string;
}

function draftFrom(event: XpEvent): Draft {
  const hoursLeft = event.endsAt
    ? (new Date(event.endsAt).getTime() - Date.now()) / 3600000
    : 0;
  return {
    name: event.name,
    multiplier: String(event.multiplier),
    auraSpell: String(event.auraSpell),
    // Round up so a 47.6h remainder reads as the 48 that was typed.
    endsInHours: hoursLeft > 0 ? String(Math.ceil(hoursLeft)) : "",
  };
}

function timeAgo(iso: string): string {
  const seconds = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (seconds < 60) return `${Math.max(seconds, 0)}s ago`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
  return `${Math.round(seconds / 3600)}h ago`;
}

export default function AdminEventPage() {
  const [event, setEvent] = useState<XpEvent | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async (reseed: boolean) => {
    const res = await fetch("/api/admin/event");
    if (!res.ok) return;
    const data = await res.json();
    setEvent(data.event);
    // Only overwrite the form on the first load and after a save, so the
    // heartbeat poll cannot yank a field out from under the admin.
    if (reseed) setDraft(draftFrom(data.event));
  }, []);

  useEffect(() => {
    load(true);
    const timer = setInterval(() => load(false), 10000);
    return () => clearInterval(timer);
  }, [load]);

  async function save(enabled: boolean) {
    if (!draft) return;
    setBusy(true);
    setMsg(null);
    const res = await fetch("/api/admin/event", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: draft.name,
        enabled,
        multiplier: Number(draft.multiplier),
        auraSpell: Number(draft.auraSpell),
        endsInHours: draft.endsInHours.trim()
          ? Number(draft.endsInHours)
          : null,
      }),
    });
    const data = await res.json().catch(() => ({}));
    setBusy(false);
    if (!res.ok) {
      setMsg({ ok: false, text: data.error ?? "Could not save the event." });
      return;
    }
    setEvent(data.event);
    setDraft(draftFrom(data.event));
    setMsg({
      ok: true,
      text: data.event.active
        ? `${data.event.name} is running at ${data.event.multiplier}× XP. Players are told within 15 seconds.`
        : "Saved. The event is off.",
    });
  }

  if (!event || !draft) {
    return (
      <div className="card">
        <p className="muted">Loading…</p>
      </div>
    );
  }

  const percent = Math.round((Number(draft.multiplier) - 1) * 100);

  return (
    <>
      {msg && <div className={`msg ${msg.ok ? "ok" : "error"}`}>{msg.text}</div>}

      {!event.worldserverReading && (
        <div className="msg error">
          The worldserver has not read this setting
          {event.seenAt ? ` since ${timeAgo(event.seenAt)}` : " yet"}. The Lua
          script is mounted from <span className="mono">worldserver/lua_scripts</span>,
          so it only appears after a{" "}
          <span className="mono">docker compose up -d</span> that recreates{" "}
          <span className="mono">ac-worldserver</span>. Until then the toggle
          saves but nothing changes in game.
        </div>
      )}

      <form
        className="card"
        onSubmit={(e) => {
          e.preventDefault();
          save(event.enabled);
        }}
      >
        <h2>
          {event.name}{" "}
          {event.active ? (
            <span className="pill green">running</span>
          ) : event.enabled ? (
            <span className="pill gold">expired</span>
          ) : (
            <span className="pill gray">off</span>
          )}
        </h2>

        <div className="grid">
          <label className="field">
            <span>Event name — used in the announcement</span>
            <input
              className="input"
              value={draft.name}
              onChange={(e) => setDraft({ ...draft, name: e.target.value })}
              required
            />
          </label>
          <label className="field">
            <span>
              XP multiplier{" "}
              {Number.isFinite(percent) && percent >= 0 && `(+${percent}%)`}
            </span>
            <input
              className="input mono"
              type="number"
              min={1}
              max={10}
              step={0.05}
              value={draft.multiplier}
              onChange={(e) =>
                setDraft({ ...draft, multiplier: e.target.value })
              }
              required
            />
          </label>
          <label className="field">
            <span>Run for (hours) — blank runs until you stop it</span>
            <input
              className="input mono"
              type="number"
              min={1}
              placeholder="48"
              value={draft.endsInHours}
              onChange={(e) =>
                setDraft({ ...draft, endsInHours: e.target.value })
              }
            />
          </label>
          <label className="field">
            <span>Buff icon spell id — 0 for no icon</span>
            <input
              className="input mono"
              type="number"
              min={0}
              value={draft.auraSpell}
              onChange={(e) => setDraft({ ...draft, auraSpell: e.target.value })}
              required
            />
          </label>
        </div>

        <div className="row">
          {event.enabled ? (
            <button
              type="button"
              className="btn danger"
              disabled={busy}
              onClick={() => save(false)}
            >
              {busy ? "Saving…" : "Stop the event"}
            </button>
          ) : (
            <button
              type="button"
              className="btn"
              disabled={busy}
              onClick={() => save(true)}
            >
              {busy ? "Saving…" : "Start the event"}
            </button>
          )}
          <button className="btn secondary" disabled={busy}>
            Save settings
          </button>
        </div>

        <p className="muted">
          {event.endsAt && event.active
            ? `Ends automatically at ${new Date(event.endsAt).toLocaleString()}. `
            : ""}
          {event.updatedBy
            ? `Last changed by ${event.updatedBy}${
                event.updatedAt ? ` ${timeAgo(event.updatedAt)}` : ""
              }. `
            : ""}
          {event.worldserverReading && event.seenAt
            ? `Worldserver last read this ${timeAgo(event.seenAt)}.`
            : ""}
        </p>
      </form>

      <div className="card">
        <h2>What players get</h2>
        <ul className="muted">
          <li>
            The multiplier applies to kill, quest and exploration XP — all three
            go through the same server call the script hooks. Rested XP and
            heirloom bonuses still stack on top as normal.
          </li>
          <li>
            Everyone online is buffed within 15 seconds of you starting it, and
            anyone logging in afterwards is buffed on login. Stopping it removes
            the icon just as quickly.
          </li>
          <li>
            The start and end are announced server-wide, and each player gets a
            line in chat on login while it runs.
          </li>
          <li>
            3.3.5a has no Joyous Journeys spell — that one is Classic-only — so
            the icon is <span className="mono">12655</span> (&ldquo;Enlightenment&rdquo;),
            a buff with no combat effect. The XP itself comes from the script,
            not the icon, so any spell id works here; <span className="mono">0</span>{" "}
            runs the event with no icon at all.
          </li>
          <li>
            Nothing here restarts the server or disconnects anyone.
          </li>
        </ul>
      </div>
    </>
  );
}
