"use client";

import { useEffect, useState } from "react";

interface RealmItem {
  id: number;
  name: string;
}

export default function AdminPlayerbotsPage() {
  const [realms, setRealms] = useState<RealmItem[]>([]);
  const [selectedRealmId, setSelectedRealmId] = useState<number>(1);
  const [botCount, setBotCount] = useState<number>(10);
  const [randomBotCount, setRandomBotCount] = useState<number>(20);
  const [customCommand, setCustomCommand] = useState<string>("");
  const [busy, setBusy] = useState<boolean>(false);
  const [logs, setLogs] = useState<{ command: string; output: string; success: boolean }[]>([]);

  useEffect(() => {
    fetch("/api/realms")
      .then((res) => res.json())
      .then((data) => {
        if (data.realms && Array.isArray(data.realms)) {
          setRealms(data.realms);
          // Auto-select the playerbots realm (type === 'playerbots' or id 2) if present
          const pbRealm = data.realms.find((r: { type?: string; id: number }) => r.type === "playerbots" || r.id === 2);
          if (pbRealm) {
            setSelectedRealmId(pbRealm.id);
          } else if (data.realms[0]) {
            setSelectedRealmId(data.realms[0].id);
          }
        }
      })
      .catch(() => {});
  }, []);

  async function executeSoapCommand(cmd: string) {
    const trimmed = cmd.trim();
    if (!trimmed || busy) return;

    setBusy(true);
    try {
      const res = await fetch("/api/admin/soap", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ command: trimmed, realmId: selectedRealmId }),
      });
      const data = await res.json().catch(() => ({}));
      setLogs((prev) => [
        {
          command: `[Realm ${selectedRealmId}] .${trimmed}`,
          output: data.output ?? data.error ?? "Request failed.",
          success: res.ok && Boolean(data.success),
        },
        ...prev,
      ]);
    } catch (err) {
      setLogs((prev) => [
        {
          command: `[Realm ${selectedRealmId}] .${trimmed}`,
          output: (err as Error).message || "Execution error",
          success: false,
        },
        ...prev,
      ]);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card">
      <h2>Playerbots Management (Admin)</h2>
      <p className="muted">
        Control world population, spawn random bots, manage AI activity, and issue <span className="mono">mod-playerbots</span> and <span className="mono">MultiBot</span> commands.
      </p>

      <div className="field" style={{ marginBottom: "1.25rem" }}>
        <span>Target Realm</span>
        <select
          className="input"
          value={selectedRealmId}
          onChange={(e) => setSelectedRealmId(Number(e.target.value))}
        >
          {realms.map((r) => (
            <option key={r.id} value={r.id}>
              Realm {r.id}: {r.name} {r.id === 1 ? "(Standard Realm — mod-playerbots disabled)" : "(Playerbots Enabled)"}
            </option>
          ))}
        </select>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))", gap: "1.25rem", marginBottom: "1.5rem" }}>
        {/* World Population & Random Bots */}
        <div className="card" style={{ background: "rgba(255, 255, 255, 0.03)", border: "1px solid rgba(255, 255, 255, 0.1)", margin: 0 }}>
          <h3>Random World Population</h3>
          <p className="muted" style={{ fontSize: "0.875rem" }}>
            Control roaming random bots that populate the world and make cities/zones active.
          </p>
          <div className="field" style={{ marginBottom: "1rem" }}>
            <span>Target Random Bot Count</span>
            <input
              type="number"
              className="input mono"
              value={randomBotCount}
              min={1}
              max={500}
              onChange={(e) => setRandomBotCount(Math.max(1, parseInt(e.target.value) || 1))}
            />
          </div>
          <div className="row" style={{ gap: "0.5rem", flexWrap: "wrap" }}>
            <button
              className="btn"
              disabled={busy}
              onClick={() => executeSoapCommand(`playerbots rndbot ${randomBotCount}`)}
            >
              Set {randomBotCount} Random Bots
            </button>
            <button
              className="btn secondary"
              disabled={busy}
              onClick={() => executeSoapCommand("playerbots rndbot update")}
            >
              Force Bot Update
            </button>
            <button
              className="btn secondary"
              disabled={busy}
              onClick={() => executeSoapCommand("playerbots rndbot reload")}
            >
              Reload Bot Config
            </button>
          </div>
        </div>

        {/* Quick Action Presets */}
        <div className="card" style={{ background: "rgba(255, 255, 255, 0.03)", border: "1px solid rgba(255, 255, 255, 0.1)", margin: 0 }}>
          <h3>Random Bot Controls</h3>
          <p className="muted" style={{ fontSize: "0.875rem" }}>
            Query server bot statistics or trigger immediate random bot updates.
          </p>
          <div className="row" style={{ gap: "0.5rem", flexWrap: "wrap" }}>
            <button
              className="btn"
              disabled={busy}
              onClick={() => executeSoapCommand("playerbots rndbot stats")}
            >
              Bot Statistics
            </button>
            <button
              className="btn secondary"
              disabled={busy}
              onClick={() => executeSoapCommand("playerbots rndbot update")}
            >
              Tick Bot AI
            </button>
          </div>
        </div>

        {/* Status & Maintenance */}
        <div className="card" style={{ background: "rgba(255, 255, 255, 0.03)", border: "1px solid rgba(255, 255, 255, 0.1)", margin: 0 }}>
          <h3>Bot Maintenance</h3>
          <p className="muted" style={{ fontSize: "0.875rem" }}>
            Query server bot statistics or remove active bots.
          </p>
          <div className="row" style={{ gap: "0.5rem", flexWrap: "wrap" }}>
            <button
              className="btn secondary small"
              disabled={busy}
              onClick={() => executeSoapCommand("playerbots status")}
            >
              Bot Status
            </button>
            <button
              className="btn secondary small"
              disabled={busy}
              onClick={() => executeSoapCommand("playerbots count")}
            >
              Bot Count Info
            </button>
            <button
              className="btn secondary small"
              disabled={busy}
              onClick={() => executeSoapCommand("playerbots join")}
            >
              Join Guild/Party
            </button>
            <button
              className="btn danger small"
              disabled={busy}
              onClick={() => executeSoapCommand("playerbots remove")}
            >
              Remove All Bots
            </button>
          </div>
        </div>
      </div>

      {/* Custom Command Form */}
      <div style={{ marginBottom: "1.5rem" }}>
        <h3>Console Command Execution</h3>
        <p className="muted" style={{ fontSize: "0.875rem" }}>
          Execute any <span className="mono">.playerbots</span> or <span className="mono">.bot</span> command directly.
        </p>
        <form
          className="row"
          style={{ marginTop: "0.5rem", flexWrap: "nowrap" }}
          onSubmit={(e) => {
            e.preventDefault();
            if (customCommand.trim()) {
              executeSoapCommand(customCommand.trim().replace(/^\.?/, ""));
            }
          }}
        >
          <span className="mono" style={{ alignSelf: "center", paddingRight: "0.5rem", color: "var(--muted, #888)" }}>
            .
          </span>
          <input
            className="input mono"
            placeholder="playerbots rndbot 50 / bot add Botname / playerbots status"
            value={customCommand}
            onChange={(e) => setCustomCommand(e.target.value)}
          />
          <button className="btn" disabled={busy || !customCommand.trim()}>
            Run
          </button>
        </form>
      </div>

      {/* Console Execution Logs */}
      <div>
        <h3>Execution Logs</h3>
        <div className="console-output mono" style={{ minHeight: "160px", maxHeight: "320px", overflowY: "auto" }}>
          {logs.length === 0 && <span className="muted">Command results will be displayed here.</span>}
          {logs.map((log, index) => (
            <div key={index} style={{ marginBottom: "0.75rem" }}>
              <div className="cmd">&gt; {log.command}</div>
              <div className={log.success ? "" : "err"}>{log.output}</div>
            </div>
          ))}
          {busy && <div className="muted">Sending command via SOAP...</div>}
        </div>
      </div>
    </div>
  );
}
