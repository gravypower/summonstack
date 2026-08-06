// Seeds the shop catalog: products, packs, and pack items.
//
// Idempotent — safe to re-run after editing data/packs/*.json. Pack contents
// are replaced wholesale; product prices are only set on first insert so
// in-DB price tweaks survive a reseed.
//
// Every item id is validated against acore_world.item_template and the seed
// ABORTS on unknown ids: a typo'd id must never reach `.send items`.
//
// Usage (inside the running stack):
//   docker compose exec ac-webapp node scripts/seed-shop.mjs
import { readFileSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const mysql = require("mysql2/promise");

const WEB_DB = process.env.WEB_DB || "summonstack_web";
const WORLD_DB = process.env.WORLD_DB || "acore_world";
const PACKS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "data", "packs");

// AzerothCore class ids.
const CLASS_IDS = {
  warrior: 1, paladin: 2, hunter: 3, rogue: 4, priest: 5,
  deathknight: 6, shaman: 7, mage: 8, warlock: 9, druid: 11,
};

// Kept in sync with SHOP_DDL in src/lib/db.ts. The summon and xp_event tables
// are not here: nothing in this seed touches them, and the webapp creates them
// on its first request.
const DDL = [
  `CREATE DATABASE IF NOT EXISTS \`${WEB_DB}\` CHARACTER SET utf8mb4`,
  `CREATE TABLE IF NOT EXISTS \`${WEB_DB}\`.shop_balances (
     account_id INT UNSIGNED NOT NULL,
     balance INT UNSIGNED NOT NULL DEFAULT 0,
     updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
     PRIMARY KEY (account_id)
   ) ENGINE=InnoDB`,
  `CREATE TABLE IF NOT EXISTS \`${WEB_DB}\`.shop_ledger (
     id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
     account_id INT UNSIGNED NOT NULL,
     delta INT NOT NULL,
     reason ENUM('vote','donation','admin_grant','purchase','refund','summon') NOT NULL,
     reference VARCHAR(64) NULL,
     note VARCHAR(255) NULL,
     created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
     PRIMARY KEY (id),
     KEY idx_account_time (account_id, created_at),
     UNIQUE KEY uq_reason_ref (reason, reference)
   ) ENGINE=InnoDB`,
  `CREATE TABLE IF NOT EXISTS \`${WEB_DB}\`.shop_products (
     id INT UNSIGNED NOT NULL AUTO_INCREMENT,
     slug VARCHAR(64) NOT NULL,
     name VARCHAR(128) NOT NULL,
     description TEXT NULL,
     price INT UNSIGNED NOT NULL,
     delivery_type ENUM('level_boost','profession_boost','item_pack','xp_lock','playerbot_slot') NOT NULL,
     payload JSON NOT NULL,
     enabled TINYINT(1) NOT NULL DEFAULT 1,
     created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
     PRIMARY KEY (id),
     UNIQUE KEY uq_slug (slug)
   ) ENGINE=InnoDB`,
  `CREATE TABLE IF NOT EXISTS \`${WEB_DB}\`.shop_transactions (
     id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
     idempotency_key CHAR(36) NOT NULL,
     account_id INT UNSIGNED NOT NULL,
     product_id INT UNSIGNED NOT NULL,
     price_paid INT UNSIGNED NOT NULL,
     character_guid INT UNSIGNED NOT NULL,
     character_name VARCHAR(12) NOT NULL,
     payload_snapshot JSON NOT NULL,
     status ENUM('pending','delivering','delivered','failed','refunded') NOT NULL DEFAULT 'pending',
     attempts TINYINT UNSIGNED NOT NULL DEFAULT 0,
     error TEXT NULL,
     created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
     updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
     PRIMARY KEY (id),
     UNIQUE KEY uq_idem (idempotency_key),
     KEY idx_account (account_id, created_at),
     KEY idx_status (status)
   ) ENGINE=InnoDB`,
  `CREATE TABLE IF NOT EXISTS \`${WEB_DB}\`.shop_packs (
     id INT UNSIGNED NOT NULL AUTO_INCREMENT,
     slug VARCHAR(32) NOT NULL,
     name VARCHAR(64) NOT NULL,
     level_cap TINYINT UNSIGNED NOT NULL,
     min_level TINYINT UNSIGNED NOT NULL,
     PRIMARY KEY (id),
     UNIQUE KEY uq_slug (slug)
   ) ENGINE=InnoDB`,
  `CREATE TABLE IF NOT EXISTS \`${WEB_DB}\`.shop_pack_items (
     id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
     pack_id INT UNSIGNED NOT NULL,
     class_id TINYINT UNSIGNED NULL,
     spec VARCHAR(24) NULL,
     item_id INT UNSIGNED NOT NULL,
     count SMALLINT UNSIGNED NOT NULL DEFAULT 1,
     category ENUM('gear','consumable','bag') NOT NULL,
     slot_hint VARCHAR(16) NULL,
     PRIMARY KEY (id),
     KEY idx_lookup (pack_id, class_id, spec),
     CONSTRAINT fk_pack_items_pack FOREIGN KEY (pack_id)
       REFERENCES \`${WEB_DB}\`.shop_packs (id) ON DELETE CASCADE
   ) ENGINE=InnoDB`,
  `CREATE TABLE IF NOT EXISTS \`${WEB_DB}\`.shop_xp_locks (
     character_guid INT UNSIGNED NOT NULL,
     account_id INT UNSIGNED NOT NULL,
     realm_id INT UNSIGNED NOT NULL DEFAULT 1,
     target_level TINYINT UNSIGNED NOT NULL,
     locked_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
     released_at DATETIME NULL,
     PRIMARY KEY (realm_id, character_guid),
     KEY idx_active (released_at)
   ) ENGINE=InnoDB`,
  // 'bag' and 'xp_lock' were added after the first installs; CREATE TABLE IF
  // NOT EXISTS above won't widen an existing enum, and re-running a MODIFY is
  // harmless.
  `ALTER TABLE \`${WEB_DB}\`.shop_pack_items
     MODIFY category ENUM('gear','consumable','bag') NOT NULL`,
  `ALTER TABLE \`${WEB_DB}\`.shop_products
     MODIFY delivery_type
       ENUM('level_boost','profession_boost','item_pack','xp_lock','playerbot_slot') NOT NULL`,
];

// Prices are starting points — tune them in shop_products, they survive reseeds.
const PRODUCTS = [
  {
    slug: "playerbot-slot",
    name: "Playerbot Access Token",
    description:
      "Unlock personal AI companion bot control for your account. Command bots to log in and join your party.",
    price: 250,
    delivery_type: "playerbot_slot",
    payload: { max_bots: 1 },
  },
  {
    slug: "level-boost-60",
    name: "Level 60 Boost",
    description: "Instantly boost a character to level 60, the Classic cap.",
    price: 200,
    delivery_type: "level_boost",
    payload: { level: 60 },
  },
  {
    slug: "level-boost-70",
    name: "Level 70 Boost",
    description: "Instantly boost a character to level 70, the TBC cap.",
    price: 350,
    delivery_type: "level_boost",
    payload: { level: 70 },
  },
  {
    slug: "level-boost-80",
    name: "Level 80 Boost",
    description: "Instantly boost a character to level 80.",
    price: 500,
    delivery_type: "level_boost",
    payload: { level: 80 },
  },
  {
    slug: "profession-boost",
    name: "Profession Boost",
    description:
      "Max out all learned primary and secondary professions to 450. The character must be logged out.",
    price: 300,
    delivery_type: "profession_boost",
    payload: { skill_cap: 450 },
  },
  // level: null means "hold the character where it stands when you buy".
  // Set a number instead for a bracket product (e.g. { level: 19 }) — it can
  // be bought at or below that level and takes hold on arrival.
  {
    slug: "xp-lock",
    name: "Experience Lock",
    description:
      "Stop a character gaining experience, holding it at its current level. Twink-friendly, and reversible with the unlock.",
    price: 150,
    delivery_type: "xp_lock",
    payload: { action: "lock", level: null },
  },
  {
    slug: "xp-unlock",
    name: "Remove Experience Lock",
    description: "Lift the experience lock on a character so it levels again.",
    price: 50,
    delivery_type: "xp_lock",
    payload: { action: "release" },
  },
  {
    slug: "pack-classic",
    name: "Classic Starter Pack (60)",
    description: "Level 60 pre-raid gear for your class/spec, four 18-slot bags and vanilla consumables, by mail.",
    price: 400,
    delivery_type: "item_pack",
    payload: { pack: "classic" },
  },
  {
    slug: "raid-classic",
    name: "Classic Raid Consumables (60)",
    description:
      "A raid night in one mailbox: Winterfall Firewater, jujus, elixirs, weapon oils and stones, protection potions, potions and buff food.",
    price: 250,
    delivery_type: "item_pack",
    payload: { pack: "classic-raid" },
  },
  {
    slug: "pack-tbc",
    name: "TBC Starter Pack (70)",
    description: "Level 70 pre-raid gear for your class/spec, four 22-slot bags and Outland consumables, by mail.",
    price: 700,
    delivery_type: "item_pack",
    payload: { pack: "tbc" },
  },
  {
    slug: "raid-tbc",
    name: "TBC Raid Consumables (70)",
    description:
      "Karazhan-ready: all five flasks, the major elixirs, potions, weapon oils and stones, protection potions and buff food.",
    price: 450,
    delivery_type: "item_pack",
    payload: { pack: "tbc-raid" },
  },
  {
    slug: "pack-wotlk",
    name: "WotLK Starter Pack (80)",
    description: "Level 80 pre-raid gear for your class/spec, four 22-slot bags and Northrend consumables, by mail.",
    price: 1000,
    delivery_type: "item_pack",
    payload: { pack: "wotlk" },
  },
  {
    slug: "raid-wotlk",
    name: "WotLK Raid Consumables (80)",
    description:
      "Naxx-ready: all four flasks, the mighty elixirs, potions and injectors, weapon oils and chains, and Northrend feasts.",
    price: 600,
    delivery_type: "item_pack",
    payload: { pack: "wotlk-raid" },
  },
  {
    slug: "summon-stone",
    name: "Summoning Stone",
    description:
      "A consumable that spawns a warlock and summoning portal — summon any online player to your location, no group required. Counted for summon rewards.",
    price: 100,
    delivery_type: "item_pack",
    payload: { pack: "summon-stone" },
  },
];

function loadPackFiles() {
  const packs = [];
  for (const file of readdirSync(PACKS_DIR).filter((f) => f.endsWith(".json")).sort()) {
    const pack = JSON.parse(readFileSync(join(PACKS_DIR, file), "utf8"));
    // Flatten the three scopes into shop_pack_items rows.
    const rows = [];
    // Bags are non-stackable, so one row per bag: mails are chunked by row and
    // the core counts each bag against MAX_MAIL_ITEMS separately.
    for (const b of pack.bags ?? []) {
      for (let i = 0; i < (b.count ?? 1); i++) {
        rows.push({ class_id: null, spec: null, item_id: b.item_id, count: 1, category: "bag", slot_hint: "bag" });
      }
    }
    for (const c of pack.consumables ?? []) {
      rows.push({ class_id: null, spec: null, item_id: c.item_id, count: c.count ?? 1, category: "consumable", slot_hint: null });
    }
    for (const [className, cls] of Object.entries(pack.classes ?? {})) {
      const classId = CLASS_IDS[className];
      if (!classId) throw new Error(`${file}: unknown class '${className}'`);
      for (const c of cls.class_consumables ?? []) {
        rows.push({ class_id: classId, spec: null, item_id: c.item_id, count: c.count ?? 1, category: "consumable", slot_hint: null });
      }
      for (const [specName, spec] of Object.entries(cls.specs ?? {})) {
        if (!/^[a-z][a-z-]{1,23}$/.test(specName)) {
          throw new Error(`${file}: bad spec name '${specName}'`);
        }
        for (const g of spec.gear ?? []) {
          rows.push({ class_id: classId, spec: specName, item_id: g.item_id, count: g.count ?? 1, category: "gear", slot_hint: g.slot ?? null });
        }
      }
    }
    packs.push({ file, meta: pack, rows });
  }
  return packs;
}

const conn = await mysql.createConnection({
  host: process.env.DB_HOST || "127.0.0.1",
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER || "root",
  password: process.env.DB_PASS || "",
});

for (const ddl of DDL) await conn.query(ddl);

const packs = loadPackFiles();

// Validate every item id against the world DB before touching anything.
const allIds = [...new Set(packs.flatMap((p) => p.rows.map((r) => r.item_id)))];
if (allIds.length > 0) {
  const [found] = await conn.query(
    `SELECT entry, name, stackable, maxcount FROM \`${WORLD_DB}\`.item_template WHERE entry IN (?)`,
    [allIds]
  );
  const byId = new Map(found.map((r) => [Number(r.entry), r]));
  const missing = allIds.filter((id) => !byId.has(id));
  if (missing.length > 0) {
    console.error(`ABORT: item ids not present in ${WORLD_DB}.item_template: ${missing.join(", ")}`);
    console.error("Fix data/packs/*.json — a bad id must never reach '.send items'.");
    await conn.end();
    process.exit(1);
  }
  for (const p of packs) {
    for (const r of p.rows) {
      const t = byId.get(r.item_id);
      if (r.count > Math.max(1, Number(t.stackable))) {
        console.warn(
          `WARNING ${p.file}: '${t.name}' (${r.item_id}) count ${r.count} exceeds stack size ${t.stackable} — split into multiple entries.`
        );
      }
      if (Number(t.maxcount) > 0 && r.count > Number(t.maxcount)) {
        console.warn(
          `WARNING ${p.file}: '${t.name}' (${r.item_id}) is unique (maxcount ${t.maxcount}) but count is ${r.count}.`
        );
      }
    }
  }
}

// Upsert products. Price/enabled intentionally not overwritten on reseed.
for (const p of PRODUCTS) {
  await conn.query(
    `INSERT INTO \`${WEB_DB}\`.shop_products (slug, name, description, price, delivery_type, payload)
     VALUES (?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE name = VALUES(name), description = VALUES(description),
       delivery_type = VALUES(delivery_type), payload = VALUES(payload)`,
    [p.slug, p.name, p.description, p.price, p.delivery_type, JSON.stringify(p.payload)]
  );
}
console.log(`Products: ${PRODUCTS.length} upserted.`);

// Upsert packs and replace their contents wholesale.
for (const p of packs) {
  await conn.query(
    `INSERT INTO \`${WEB_DB}\`.shop_packs (slug, name, level_cap, min_level)
     VALUES (?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE name = VALUES(name), level_cap = VALUES(level_cap),
       min_level = VALUES(min_level)`,
    [p.meta.slug, p.meta.name, p.meta.level_cap, p.meta.min_level]
  );
  const [[{ id: packId }]] = await conn.query(
    `SELECT id FROM \`${WEB_DB}\`.shop_packs WHERE slug = ?`,
    [p.meta.slug]
  );
  await conn.query(`DELETE FROM \`${WEB_DB}\`.shop_pack_items WHERE pack_id = ?`, [packId]);
  if (p.rows.length > 0) {
    await conn.query(
      `INSERT INTO \`${WEB_DB}\`.shop_pack_items
         (pack_id, class_id, spec, item_id, count, category, slot_hint) VALUES ?`,
      [p.rows.map((r) => [packId, r.class_id, r.spec, r.item_id, r.count, r.category, r.slot_hint])]
    );
  }
  const gear = p.rows.filter((r) => r.category === "gear").length;
  const bags = p.rows.filter((r) => r.category === "bag").length;
  console.log(
    `Pack '${p.meta.slug}': ${p.rows.length} items (${gear} gear, ${bags} bags, ${p.rows.length - gear - bags} consumable rows).`
  );
}

console.log("Shop seed complete.");
await conn.end();
