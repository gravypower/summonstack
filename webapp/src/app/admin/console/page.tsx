"use client";

import { useEffect, useRef, useState } from "react";

interface Entry {
  command: string;
  output: string;
  success: boolean;
}

const QUICK_COMMANDS: { label: string; command: string }[] = [
  { label: "Server info", command: "server info" },
  { label: "Online GMs", command: "gm ingame" },
  { label: "Announce", command: "announce Hello from the admin panel!" },
  { label: "Save all", command: "saveall" },
];

interface RealmItem {
  id: number;
  name: string;
}

export default function AdminConsolePage() {
  const [command, setCommand] = useState("");
  const [entries, setEntries] = useState<Entry[]>([]);
  const [busy, setBusy] = useState(false);
  const [history, setHistory] = useState<string[]>([]);
  const [historyIndex, setHistoryIndex] = useState(-1);
  const [realms, setRealms] = useState<RealmItem[]>([]);
  const [selectedRealmId, setSelectedRealmId] = useState<number>(1);
  const outputRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    fetch("/api/realms")
      .then((res) => res.json())
      .then((data) => {
        if (data.realms && Array.isArray(data.realms)) {
          setRealms(data.realms);
          if (data.realms[0]) {
            setSelectedRealmId(data.realms[0].id);
          }
        }
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    outputRef.current?.scrollTo(0, outputRef.current.scrollHeight);
  }, [entries]);

  async function run(cmd: string) {
    const trimmed = cmd.trim();
    if (!trimmed || busy) return;
    setBusy(true);
    setCommand("");
    setHistory((h) => [trimmed, ...h.slice(0, 49)]);
    setHistoryIndex(-1);
    const res = await fetch("/api/admin/soap", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ command: trimmed, realmId: selectedRealmId }),
    });
    const data = await res.json().catch(() => ({}));
    setEntries((prev) => [
      ...prev,
      {
        command: `[Realm ${selectedRealmId}] ${trimmed}`,
        output: data.output ?? data.error ?? "Request failed.",
        success: res.ok && Boolean(data.success),
      },
    ]);
    setBusy(false);
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "ArrowUp") {
      e.preventDefault();
      const next = Math.min(historyIndex + 1, history.length - 1);
      if (history[next]) {
        setHistoryIndex(next);
        setCommand(history[next]);
      }
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      const next = historyIndex - 1;
      setHistoryIndex(next);
      setCommand(next >= 0 ? history[next] : "");
    }
  }

  return (
    <div className="card">
      <h2>Worldserver console (SOAP)</h2>
      <p className="muted">
        Commands run exactly like the in-game console, without the leading
        dot — e.g. <span className="mono">server info</span>,{" "}
        <span className="mono">account onlinelist</span>,{" "}
        <span className="mono">teleport name $player $location</span>. Type{" "}
        <span className="mono">help</span> for a list.
      </p>

      {realms.length > 1 && (
        <div className="field" style={{ marginBottom: "1rem" }}>
          <span>Target Realm</span>
          <select
            className="input"
            value={selectedRealmId}
            onChange={(e) => setSelectedRealmId(Number(e.target.value))}
          >
            {realms.map((r) => (
              <option key={r.id} value={r.id}>
                Realm {r.id}: {r.name}
              </option>
            ))}
          </select>
        </div>
      )}

      <div className="row" style={{ marginBottom: "0.75rem" }}>
        {QUICK_COMMANDS.map((qc) => (
          <button
            key={qc.label}
            className="btn secondary small"
            onClick={() => setCommand(qc.command)}
            disabled={busy}
          >
            {qc.label}
          </button>
        ))}
      </div>

      <div className="console-output mono" ref={outputRef}>
        {entries.length === 0 && (
          <span className="muted">Output will appear here.</span>
        )}
        {entries.map((entry, i) => (
          <div key={i} style={{ marginBottom: "0.75rem" }}>
            <div className="cmd">&gt; {entry.command}</div>
            <div className={entry.success ? "" : "err"}>{entry.output}</div>
          </div>
        ))}
        {busy && <div className="muted">Running…</div>}
      </div>

      <form
        className="row"
        style={{ marginTop: "0.75rem", flexWrap: "nowrap" }}
        onSubmit={(e) => {
          e.preventDefault();
          run(command);
        }}
      >
        <input
          className="input mono"
          placeholder="server info"
          value={command}
          onChange={(e) => setCommand(e.target.value)}
          onKeyDown={onKeyDown}
          autoFocus
        />
        <button className="btn" disabled={busy || !command.trim()}>
          Run
        </button>
      </form>
    </div>
  );
}
