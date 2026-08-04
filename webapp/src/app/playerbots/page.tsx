"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import PlayerAutocomplete from "@/app/components/player-autocomplete";

interface Character {
  guid: number;
  name: string;
  race: number;
  class: number;
  level: number;
  online: boolean;
  realmId: number;
  realmName: string;
}

const CLASS_NAMES: Record<number, string> = {
  1: "Warrior", 2: "Paladin", 3: "Hunter", 4: "Rogue", 5: "Priest",
  6: "Death Knight", 7: "Shaman", 8: "Mage", 9: "Warlock", 11: "Druid",
};

export default function PlayerbotsUserPage() {
  const router = useRouter();
  const [loading, setLoading] = useState(true);
  const [hasPurchased, setHasPurchased] = useState(false);
  const [characters, setCharacters] = useState<Character[]>([]);
  const [busyBot, setBusyBot] = useState<string | null>(null);
  const [customBotName, setCustomBotName] = useState("");
  const [selectedRealmId, setSelectedRealmId] = useState<number>(1);
  const [logs, setLogs] = useState<{ command: string; output: string; success: boolean }[]>([]);

  const loadData = useCallback(async () => {
    try {
      const res = await fetch("/api/playerbots");
      if (res.status === 401) {
        router.push("/login");
        return;
      }
      const data = await res.json();
      setHasPurchased(Boolean(data.hasPurchased));
      setCharacters(data.characters || []);
      if (data.characters && data.characters.length > 0) {
        setSelectedRealmId(data.characters[0].realmId);
      }
    } catch {
      // API error fallback
    } finally {
      setLoading(false);
    }
  }, [router]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  async function toggleBot(characterName: string, action: "login" | "logout", realmId: number) {
    setBusyBot(characterName);
    try {
      const res = await fetch("/api/playerbots", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, characterName, realmId }),
      });
      const data = await res.json();
      setLogs((prev) => [
        {
          command: `.playerbots rndbot ${action === "login" ? "add" : "delete"} ${characterName}`,
          output: data.output ?? (data.success ? "Command sent successfully." : "Execution failed."),
          success: Boolean(data.success),
        },
        ...prev,
      ]);
      await loadData();
    } catch (err) {
      setLogs((prev) => [
        {
          command: `.playerbots rndbot ${action === "login" ? "add" : "delete"} ${characterName}`,
          output: (err as Error).message || "Execution error",
          success: false,
        },
        ...prev,
      ]);
    } finally {
      setBusyBot(null);
    }
  }

  if (loading) {
    return <p className="muted">Loading playerbot information…</p>;
  }

  return (
    <div>
      <div className="row" style={{ justifyContent: "space-between", marginBottom: "1.5rem" }}>
        <div>
          <h1 style={{ margin: 0 }}>Playerbots Management</h1>
          <p className="muted" style={{ margin: 0, marginTop: "0.25rem" }}>
            Summon, log in, or dismiss companion bots for your party using MultiBot / mod-playerbots.
          </p>
        </div>
        <Link href="/shop" className="btn secondary">
          🛒 Visit Shop
        </Link>
      </div>

      {!hasPurchased ? (
        <div className="card" style={{ background: "rgba(239, 68, 68, 0.1)", borderColor: "rgba(239, 68, 68, 0.3)", marginBottom: "1.5rem" }}>
          <h3 style={{ marginTop: 0, color: "#f87171" }}>Playerbot Token Required</h3>
          <p className="muted">
            You do not currently have an active <strong>Playerbot Access Token</strong>.
            You must purchase one in the Points Shop before you can summon and control bots on your account.
          </p>
          <Link href="/shop" className="btn">
            Buy Playerbot Access Token (250 pts)
          </Link>
        </div>
      ) : (
        <>
          {/* Account Characters Control */}
          <div className="card" style={{ marginBottom: "1.5rem" }}>
            <h2>Your Account Characters / Bots</h2>
            <p className="muted" style={{ fontSize: "0.875rem" }}>
              Control whether your alts or created bot characters log in to join your group.
            </p>

            {characters.length === 0 ? (
              <p className="muted">No characters found on your account.</p>
            ) : (
              <div className="table-wrap">
                <table className="data">
                  <thead>
                    <tr>
                      <th>Character</th>
                      <th>Class & Level</th>
                      <th>Realm</th>
                      <th>Status</th>
                      <th>Action</th>
                    </tr>
                  </thead>
                  <tbody>
                    {characters.map((c) => (
                      <tr key={`${c.realmId}-${c.guid}`}>
                        <td>
                          <strong>{c.name}</strong>
                        </td>
                        <td>
                          {CLASS_NAMES[c.class] ?? "Unknown"} (Level {c.level})
                        </td>
                        <td>{c.realmName}</td>
                        <td>
                          <span className={`pill ${c.online ? "green" : "gray"}`}>
                            {c.online ? "Online" : "Offline"}
                          </span>
                        </td>
                        <td>
                          {c.online ? (
                            <button
                              className="btn secondary small"
                              disabled={busyBot === c.name}
                              onClick={() => toggleBot(c.name, "logout", c.realmId)}
                            >
                              {busyBot === c.name ? "Sending..." : "Log Bot Out"}
                            </button>
                          ) : (
                            <button
                              className="btn small"
                              disabled={busyBot === c.name}
                              onClick={() => toggleBot(c.name, "login", c.realmId)}
                            >
                              {busyBot === c.name ? "Sending..." : "Log Bot In"}
                            </button>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {/* Direct Custom Bot Command Form */}
          <div className="card" style={{ marginBottom: "1.5rem" }}>
            <h2>Custom Bot Command</h2>
            <p className="muted" style={{ fontSize: "0.875rem" }}>
              Summon or dismiss any specific bot by character name.
            </p>

            <form
              className="row"
              style={{ gap: "0.75rem", flexWrap: "wrap" }}
              onSubmit={(e) => {
                e.preventDefault();
                if (customBotName.trim()) {
                  toggleBot(customBotName.trim(), "login", selectedRealmId);
                }
              }}
            >
              <div style={{ flex: 1, minWidth: "220px" }}>
                <PlayerAutocomplete
                  value={customBotName}
                  onChange={(val, item) => {
                    setCustomBotName(val);
                    if (item?.realmId) setSelectedRealmId(item.realmId);
                  }}
                  placeholder="Type character name..."
                  typeFilter="character"
                />
              </div>
              <button
                type="submit"
                className="btn"
                disabled={!customBotName.trim() || Boolean(busyBot)}
              >
                Log Bot In
              </button>
              <button
                type="button"
                className="btn secondary"
                disabled={!customBotName.trim() || Boolean(busyBot)}
                onClick={() => {
                  if (customBotName.trim()) {
                    toggleBot(customBotName.trim(), "logout", selectedRealmId);
                  }
                }}
              >
                Log Bot Out
              </button>
            </form>
          </div>

          {/* Action Log Console */}
          <div className="card">
            <h2>Bot Action History</h2>
            <div className="console-output mono" style={{ minHeight: "140px", maxHeight: "280px", overflowY: "auto" }}>
              {logs.length === 0 && <span className="muted">Bot commands and output will appear here.</span>}
              {logs.map((log, index) => (
                <div key={index} style={{ marginBottom: "0.75rem" }}>
                  <div className="cmd">&gt; {log.command}</div>
                  <div className={log.success ? "" : "err"}>{log.output}</div>
                </div>
              ))}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
