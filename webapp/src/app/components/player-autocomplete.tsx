"use client";

import { useEffect, useRef, useState } from "react";

export interface SearchResultItem {
  type: "character" | "account";
  name: string;
  id?: number;
  guid?: number;
  level?: number;
  class?: number;
  race?: number;
  realmId?: number;
  realmName?: string;
  accountName?: string;
}

interface PlayerAutocompleteProps {
  value: string;
  onChange: (val: string, item?: SearchResultItem) => void;
  placeholder?: string;
  typeFilter?: "character" | "account" | "all";
  className?: string;
  style?: React.CSSProperties;
  required?: boolean;
}

const CLASS_NAMES: Record<number, string> = {
  1: "Warrior", 2: "Paladin", 3: "Hunter", 4: "Rogue", 5: "Priest",
  6: "Death Knight", 7: "Shaman", 8: "Mage", 9: "Warlock", 11: "Druid",
};

export default function PlayerAutocomplete({
  value,
  onChange,
  placeholder = "Search character or account...",
  typeFilter = "all",
  className = "input",
  style,
  required,
}: PlayerAutocompleteProps) {
  const [results, setResults] = useState<SearchResultItem[]>([]);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  useEffect(() => {
    if (!value.trim()) {
      setResults([]);
      setOpen(false);
      return;
    }

    const timer = setTimeout(async () => {
      setLoading(true);
      try {
        const res = await fetch(
          `/api/search?q=${encodeURIComponent(value.trim())}&type=${typeFilter}`
        );
        if (res.ok) {
          const data = await res.json();
          setResults(data.results || []);
          setOpen(true);
        }
      } catch {
        setResults([]);
      } finally {
        setLoading(false);
      }
    }, 200);

    return () => clearTimeout(timer);
  }, [value, typeFilter]);

  return (
    <div ref={containerRef} style={{ position: "relative", display: "inline-block", width: "100%", ...style }}>
      <input
        className={className}
        value={value}
        onChange={(e) => {
          onChange(e.target.value);
          setOpen(true);
        }}
        placeholder={placeholder}
        required={required}
        onFocus={() => {
          if (results.length > 0) setOpen(true);
        }}
      />

      {open && (results.length > 0 || loading) && (
        <div
          style={{
            position: "absolute",
            top: "100%",
            left: 0,
            right: 0,
            zIndex: 1000,
            marginTop: "4px",
            background: "var(--card-bg, #1a1a24)",
            border: "1px solid rgba(255, 255, 255, 0.15)",
            borderRadius: "6px",
            boxShadow: "0 8px 24px rgba(0,0,0,0.4)",
            maxHeight: "240px",
            overflowY: "auto",
          }}
        >
          {loading && <div style={{ padding: "0.5rem 0.75rem", fontSize: "0.85rem", color: "#888" }}>Searching...</div>}
          {!loading &&
            results.map((item, i) => (
              <div
                key={i}
                style={{
                  padding: "0.5rem 0.75rem",
                  cursor: "pointer",
                  borderBottom: "1px solid rgba(255, 255, 255, 0.05)",
                  fontSize: "0.875rem",
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                }}
                className="autocomplete-item"
                onClick={() => {
                  onChange(item.name, item);
                  setOpen(false);
                }}
              >
                <div>
                  <strong style={{ color: "#fff" }}>{item.name}</strong>
                  {item.type === "character" && item.class && (
                    <span style={{ marginLeft: "0.5rem", color: "#888", fontSize: "0.8rem" }}>
                      Lvl {item.level} {CLASS_NAMES[item.class] ?? ""}
                    </span>
                  )}
                  {item.accountName && (
                    <span style={{ marginLeft: "0.4rem", color: "#666", fontSize: "0.8rem" }}>
                      ({item.accountName})
                    </span>
                  )}
                </div>
                <div>
                  {item.type === "character" ? (
                    <span className="pill gray" style={{ fontSize: "0.7rem", padding: "0.15rem 0.4rem" }}>
                      {item.realmName ?? "Realm"}
                    </span>
                  ) : (
                    <span className="pill gold" style={{ fontSize: "0.7rem", padding: "0.15rem 0.4rem" }}>
                      Account
                    </span>
                  )}
                </div>
              </div>
            ))}
        </div>
      )}
    </div>
  );
}
