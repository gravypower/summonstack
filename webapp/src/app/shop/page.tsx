"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";

interface Character {
  guid: number;
  name: string;
  race: number;
  class: number;
  level: number;
  online: boolean;
  realm_id?: number;
  realm_name?: string;
  /** Level this character's XP is held at, or null if it still levels. */
  xpLockedAt: number | null;
}

interface Product {
  slug: string;
  name: string;
  description: string | null;
  price: number;
  deliveryType: "level_boost" | "profession_boost" | "item_pack" | "xp_lock" | "playerbot_slot";
  boostLevel: number | null;
  lockAction: "lock" | "release" | null;
  /** null on a lock product means "hold them at whatever level they are". */
  lockLevel: number | null;
  pack: string | null;
  minLevel: number | null;
  specsByClass: Record<number, string[]> | null;
}

/** What this account has earned by summoning people, and the current rate. */
interface SummonSummary {
  count: number;
  pointsEarned: number;
  enabled: boolean;
  pointsPerSummon: number;
  dailyPointCap: number;
  pairCooldownMinutes: number;
  /** Players who currently pay more than the base rate to summon. */
  bounties: { multiplierPct: number; characters: string[] }[];
}

interface Txn {
  id: number;
  product_name: string;
  character_name: string;
  price_paid: number;
  status: string;
  error: string | null;
  created_at: string;
}

const CLASS_NAMES: Record<number, string> = {
  1: "Warrior", 2: "Paladin", 3: "Hunter", 4: "Rogue", 5: "Priest",
  6: "Death Knight", 7: "Shaman", 8: "Mage", 9: "Warlock", 11: "Druid",
};

const STATUS_PILL: Record<string, string> = {
  delivered: "green",
  refunded: "red",
  failed: "red",
  delivering: "gold",
  pending: "gray",
};

/** 200 → "2×", 150 → "1.5×". */
function timesLabel(pct: number): string {
  const times = pct / 100;
  return `${Number.isInteger(times) ? times : times.toFixed(1)}×`;
}

function specLabel(spec: string): string {
  if (spec === "dps") return "DPS";
  return spec.charAt(0).toUpperCase() + spec.slice(1);
}

// crypto.randomUUID only exists in secure contexts, and the portal is usually
// reached over plain HTTP on a LAN address. getRandomValues has no such
// restriction, so build the v4 UUID by hand when randomUUID is missing.
function newIdempotencyKey(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const hex = Array.from(b, (n) => n.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export default function ShopPage() {
  const router = useRouter();
  const [balance, setBalance] = useState<number | null>(null);
  const [characters, setCharacters] = useState<Character[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [txns, setTxns] = useState<Txn[]>([]);
  const [summons, setSummons] = useState<SummonSummary | null>(null);

  // Purchase panel state (one panel open at a time).
  const [active, setActive] = useState<string | null>(null);
  const [charGuid, setCharGuid] = useState<number>(0);
  const [spec, setSpec] = useState<string>("");
  const [idemKey, setIdemKey] = useState<string>("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const refresh = useCallback(async () => {
    const [meRes, txRes] = await Promise.all([
      fetch("/api/shop/me"),
      fetch("/api/shop/transactions"),
    ]);
    if (meRes.status === 401) {
      router.push("/login");
      return;
    }
    const me = await meRes.json();
    setBalance(me.balance);
    setCharacters(me.characters);
    setSummons(me.summons ?? null);
    setTxns((await txRes.json()).transactions ?? []);
  }, [router]);

  useEffect(() => {
    refresh();
    fetch("/api/shop/products").then(async (res) => {
      if (res.ok) setProducts((await res.json()).products);
    });
  }, [refresh]);

  function openPanel(slug: string) {
    setActive(slug);
    setCharGuid(0);
    setSpec("");
    setMsg(null);
    // Minted when the panel opens: double-clicking Buy replays the same
    // purchase instead of making a second one.
    setIdemKey(newIdempotencyKey());
  }

  const product = products.find((p) => p.slug === active) ?? null;
  const character = characters.find((c) => c.guid === charGuid) ?? null;
  const specOptions =
    product?.specsByClass && character
      ? product.specsByClass[character.class] ?? []
      : [];
  const needsSpec = specOptions.length > 0;

  /** Why this character can't be picked, or null if it can. */
  function ineligible(p: Product, c: Character): string | null {
    // A boost only moves a character up, so anyone already at or past the
    // target level is out — the server rejects those with a 409 anyway. It
    // also sets the level outright, which would jump an XP lock.
    if (p.deliveryType === "level_boost") {
      if (c.xpLockedAt != null) return `XP locked at ${c.xpLockedAt}`;
      return c.level < (p.boostLevel ?? 80) ? null : `already ${c.level}`;
    }
    if (p.deliveryType === "xp_lock") {
      if (p.lockAction === "release") {
        return c.xpLockedAt != null ? null : "not locked";
      }
      if (c.xpLockedAt != null) return `already locked at ${c.xpLockedAt}`;
      if (p.lockLevel != null && c.level > p.lockLevel) {
        return `past level ${p.lockLevel}`;
      }
      return null;
    }
    if (p.minLevel != null && c.level < p.minLevel) {
      return `needs level ${p.minLevel}`;
    }
    return null;
  }

  async function buy(e: React.FormEvent) {
    e.preventDefault();
    if (!product || !character) return;
    setBusy(true);
    setMsg(null);
    const res = await fetch("/api/shop/purchase", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        productSlug: product.slug,
        characterGuid: character.guid,
        spec: needsSpec ? spec : null,
        idempotencyKey: idemKey,
      }),
    });
    const data = await res.json().catch(() => ({}));
    setBusy(false);
    if (!res.ok) {
      setMsg({ ok: false, text: data.error ?? "Purchase failed." });
      // A failed attempt never charged, so the key stays valid for a retry
      // after the user fixes the problem (e.g. picks a spec).
      return;
    }
    const t = data.transaction;
    if (t.status === "delivered") {
      setMsg({
        ok: true,
        text:
          product.deliveryType === "item_pack"
            ? `Delivered! Check ${t.characterName}'s mailbox in-game.`
            : product.deliveryType === "xp_lock"
              ? product.lockAction === "release"
                ? `${t.characterName} is gaining experience again.`
                : `${t.characterName}'s experience is locked — the game picks it up within a few seconds.`
              : product.deliveryType === "playerbot_slot"
                ? `Playerbot access unlocked for ${t.characterName}! Head over to the Playerbots tab to manage your bot.`
                : `Delivered to ${t.characterName}!`,
      });
    } else if (t.status === "refunded") {
      setMsg({
        ok: false,
        text: `Delivery failed and your points were refunded: ${t.error ?? "unknown error"}`,
      });
    } else {
      setMsg({
        ok: false,
        text: `Order #${t.id} is ${t.status} — if it doesn't resolve shortly, contact an admin.`,
      });
    }
    setIdemKey(newIdempotencyKey());
    refresh();
  }

  if (balance === null) return <p className="muted">Loading…</p>;

  return (
    <div>
      <div className="row" style={{ justifyContent: "space-between" }}>
        <h1>Shop</h1>
        <div className="card stat" style={{ margin: 0, padding: "0.6rem 1.4rem" }}>
          <div className="label">Your points</div>
          <div className="value">{balance}</div>
        </div>
      </div>

      {summons && summons.enabled && summons.pointsPerSummon > 0 && (
        <p className="muted">
          You have summoned {summons.count} player
          {summons.count === 1 ? "" : "s"} and earned {summons.pointsEarned}{" "}
          points that way. Every player you summon — warlock ritual or meeting
          stone — is worth {summons.pointsPerSummon} points
          {summons.dailyPointCap > 0
            ? `, up to ${summons.dailyPointCap} a day`
            : ""}
          . Summoning your own alts pays nothing
          {summons.pairCooldownMinutes > 0
            ? `, and the same person only pays again after ${summons.pairCooldownMinutes} minutes`
            : ""}
          .
          {(summons.bounties ?? []).length > 0 && (
            <>
              {" "}
              Worth extra right now:{" "}
              {summons.bounties
                .map(
                  (b) =>
                    `${b.characters.join(", ")} at ${timesLabel(b.multiplierPct)}`
                )
                .join("; ")}
              .
            </>
          )}
        </p>
      )}

      {characters.length === 0 && (
        <div className="msg error">
          No characters on your account yet — log into the game and create one
          first.
        </div>
      )}

      <div className="grid" style={{ marginTop: "1rem" }}>
        {products.map((p) => (
          <div className="card" key={p.slug} style={{ marginBottom: 0 }}>
            <div className="row" style={{ justifyContent: "space-between" }}>
              <h2 style={{ margin: 0 }}>{p.name}</h2>
              <span className="pill gold">{p.price} pts</span>
            </div>
            <p className="muted">{p.description}</p>

            {active === p.slug ? (
              <form onSubmit={buy}>
                <label className="field">
                  <span>Character</span>
                  <select
                    className="input"
                    value={charGuid}
                    onChange={(e) => {
                      setCharGuid(Number(e.target.value));
                      setSpec("");
                    }}
                    required
                  >
                    <option value={0} disabled>
                      Pick a character…
                    </option>
                    {characters.map((c) => {
                      const reason = ineligible(p, c);
                      return (
                        <option
                          key={c.guid}
                          value={c.guid}
                          disabled={reason !== null}
                        >
                          {c.realm_name ? `[${c.realm_name}] ` : ""}
                          {c.name} — {CLASS_NAMES[c.class] ?? "?"} {c.level}
                          {reason
                            ? ` (${reason})`
                            : c.online
                              ? " (online)"
                              : ""}
                        </option>
                      );
                    })}
                  </select>
                </label>

                {needsSpec && (
                  <label className="field">
                    <span>Gear for spec</span>
                    <select
                      className="input"
                      value={spec}
                      onChange={(e) => setSpec(e.target.value)}
                      required
                    >
                      <option value="" disabled>
                        Pick a spec…
                      </option>
                      {specOptions.map((s) => (
                        <option key={s} value={s}>
                          {specLabel(s)}
                        </option>
                      ))}
                    </select>
                  </label>
                )}

                {product?.deliveryType === "item_pack" &&
                  character &&
                  !needsSpec && (
                    <p className="muted">
                      No {CLASS_NAMES[character.class]} gear in this pack yet —
                      you would receive the consumables only.
                    </p>
                  )}

                {product?.deliveryType === "xp_lock" &&
                  product.lockAction === "lock" &&
                  character && (
                    <p className="muted">
                      {character.name} stops gaining experience at level{" "}
                      {product.lockLevel ?? character.level}. Buying the unlock
                      later lifts it.
                    </p>
                  )}

                {product?.deliveryType === "profession_boost" &&
                  character?.online && (
                    <div className="msg error">
                      {character.name} is online — log out first, profession
                      boosts are applied while offline.
                    </div>
                  )}

                {msg && (
                  <div className={`msg ${msg.ok ? "ok" : "error"}`}>
                    {msg.text}
                  </div>
                )}

                <div className="row">
                  <button
                    className="btn"
                    disabled={busy || !character || (balance ?? 0) < p.price}
                  >
                    {busy
                      ? "Purchasing…"
                      : (balance ?? 0) < p.price
                        ? "Not enough points"
                        : `Buy for ${p.price} pts`}
                  </button>
                  <button
                    type="button"
                    className="btn secondary"
                    onClick={() => setActive(null)}
                    disabled={busy}
                  >
                    Cancel
                  </button>
                </div>
              </form>
            ) : (
              <button
                className="btn secondary"
                onClick={() => openPanel(p.slug)}
                disabled={characters.length === 0}
              >
                Buy…
              </button>
            )}
          </div>
        ))}
      </div>

      {txns.length > 0 && (
        <div className="card" style={{ marginTop: "1.25rem" }}>
          <h2>Purchase history</h2>
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>Item</th>
                  <th>Character</th>
                  <th>Points</th>
                  <th>Status</th>
                  <th>When</th>
                </tr>
              </thead>
              <tbody>
                {txns.map((t) => (
                  <tr key={t.id}>
                    <td>{t.product_name}</td>
                    <td>{t.character_name}</td>
                    <td>{t.price_paid}</td>
                    <td>
                      <span className={`pill ${STATUS_PILL[t.status] ?? "gray"}`}>
                        {t.status}
                      </span>
                      {t.error && (t.status === "refunded" || t.status === "failed") && (
                        <div className="muted" style={{ marginTop: "0.2rem" }}>
                          {t.error}
                        </div>
                      )}
                    </td>
                    <td className="muted">
                      {new Date(t.created_at).toLocaleString()}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
