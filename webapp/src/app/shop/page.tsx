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
}

interface Product {
  slug: string;
  name: string;
  description: string | null;
  price: number;
  deliveryType: "level_boost" | "profession_boost" | "item_pack";
  boostLevel: number | null;
  pack: string | null;
  minLevel: number | null;
  specsByClass: Record<number, string[]> | null;
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

  function eligible(p: Product, c: Character): boolean {
    // A boost only moves a character up, so anyone already at or past the
    // target level is out — the server rejects those with a 409 anyway.
    if (p.deliveryType === "level_boost") return c.level < (p.boostLevel ?? 80);
    if (p.minLevel != null) return c.level >= p.minLevel;
    return true;
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
                    {characters.map((c) => (
                      <option
                        key={c.guid}
                        value={c.guid}
                        disabled={!eligible(p, c)}
                      >
                        {c.name} — {CLASS_NAMES[c.class] ?? "?"} {c.level}
                        {!eligible(p, c)
                          ? p.deliveryType === "level_boost"
                            ? ` (already ${c.level})`
                            : ` (needs level ${p.minLevel})`
                          : c.online
                            ? " (online)"
                            : ""}
                      </option>
                    ))}
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
