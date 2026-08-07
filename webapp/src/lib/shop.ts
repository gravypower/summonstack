// Shop core. The money invariant lives here:
//
//   - The web DB is the ledger. Currency only moves inside a DB transaction
//     that writes both shop_balances and shop_ledger.
//   - Deduction is a single conditional UPDATE (no read-then-write), so
//     concurrent purchases cannot double-spend.
//   - Delivery happens strictly AFTER the money transaction commits, and
//     never inside an open DB transaction (a slow SOAP call must not hold
//     row locks). Status transitions are guarded UPDATEs so a transaction
//     can never be delivered or refunded twice.
import type { ResultSetHeader, RowDataPacket } from "mysql2";
import { HttpError } from "./auth";
import { AUTH_DB, WEB_DB, ensureWebDb, getPool } from "./db";
import { getRealmConfigById, listRealmsWithConfig } from "./realm";
import { soapCommand } from "./soap";

/** AC character names are plain letters; this also guards SOAP interpolation. */
const NAME_RE = /^[A-Za-z]{2,12}$/;
const SPEC_RE = /^[a-z][a-z-]{1,23}$/;
/** The core's MAX_MAIL_ITEMS. */
const MAIL_MAX_ATTACHMENTS = 12;

// Skill-line ids of the boostable professions on 3.3.5a.
const PRIMARY_SKILLS = [164, 165, 171, 182, 186, 197, 202, 333, 393, 755, 773];
const SECONDARY_SKILLS = [129, 185, 356]; // First Aid, Cooking, Fishing

export type Snapshot =
  | { type: "level_boost"; level: number }
  | { type: "profession_boost"; skillCap: number }
  | { type: "xp_lock"; action: "lock" | "release"; targetLevel: number }
  | { type: "playerbot_slot"; maxBots: number }
  | {
      type: "item_pack";
      pack: string;
      spec: string | null;
      mails: { itemId: number; count: number }[][];
    };

interface ProductRow extends RowDataPacket {
  id: number;
  slug: string;
  name: string;
  description: string | null;
  price: number;
  delivery_type: "level_boost" | "profession_boost" | "item_pack" | "xp_lock" | "playerbot_slot";
  payload: unknown;
}

export interface CharacterRow extends RowDataPacket {
  guid: number;
  name: string;
  race: number;
  class: number;
  level: number;
  online: number;
  realm_id: number;
  realm_name: string;
}

export interface TxnRow extends RowDataPacket {
  id: number;
  idempotency_key: string;
  account_id: number;
  product_id: number;
  price_paid: number;
  character_guid: number;
  character_name: string;
  realm_id: number;
  payload_snapshot: unknown;
  status: "pending" | "delivering" | "delivered" | "failed" | "refunded";
  attempts: number;
  error: string | null;
  created_at: Date;
}

/** mysql2 usually parses JSON columns; tolerate drivers/paths that don't. */
function asJson<T>(value: unknown): T {
  return (typeof value === "string" ? JSON.parse(value) : value) as T;
}

class DeliveryError extends Error {
  kind: "fault" | "unreachable" | "partial";
  constructor(kind: "fault" | "unreachable" | "partial", message: string) {
    super(message);
    this.kind = kind;
  }
}

/**
 * Every delivery command is addressed to the realm the character lives on.
 * Without the realm id soapCommand() falls back to SOAP_URL — realm 1 — so a
 * purchase made on any other realm was executed against whoever held that
 * name on realm 1.
 */
async function soapOrThrow(command: string, realmId: number): Promise<string> {
  const res = await soapCommand(command, realmId);
  if (!res.success) {
    throw new DeliveryError(res.unreachable ? "unreachable" : "fault", res.output);
  }
  return res.output;
}

/**
 * The character database for a realm, or null when the realm is unknown.
 *
 * There is deliberately no fallback to a default: the old CHARS_DB constant
 * names the single-realm database from before realms.yml existed, and on a
 * manifest-driven install it belongs to no realm at all. Reading it returns
 * nothing and writing it touches an unrelated character, both silently — so
 * every caller here refuses instead.
 */
async function charsDbForRealm(realmId: number): Promise<string | null> {
  const config = await getRealmConfigById(realmId).catch(() => null);
  return config?.charsDb ?? null;
}

// ── Reads ──────────────────────────────────────────────────────────────────

export async function getBalance(accountId: number): Promise<number> {
  await ensureWebDb();
  const [rows] = await getPool().query<RowDataPacket[]>(
    `SELECT balance FROM \`${WEB_DB}\`.shop_balances WHERE account_id = ?`,
    [accountId]
  );
  return Number(rows[0]?.balance ?? 0);
}

export async function listCharacters(accountId: number): Promise<CharacterRow[]> {
  const realms = await listRealmsWithConfig();
  const pool = getPool();
  const allCharacters: CharacterRow[] = [];

  for (const r of realms) {
    try {
      const [rows] = await pool.query<RowDataPacket[]>(
        `SELECT guid, name, race, class, level, online
           FROM \`${r.charsDb}\`.characters
          WHERE account = ? AND deleteInfos_Account IS NULL
          ORDER BY level DESC, name`,
        [accountId]
      );
      for (const row of rows) {
        allCharacters.push({
          guid: Number(row.guid),
          name: String(row.name),
          race: Number(row.race),
          class: Number(row.class),
          level: Number(row.level),
          online: Number(row.online),
          realm_id: r.id,
          realm_name: r.name,
        } as CharacterRow);
      }
    } catch {}
  }

  allCharacters.sort((a, b) => b.level - a.level || a.name.localeCompare(b.name));
  return allCharacters;
}

/**
 * The level a character's XP is held at, or null if it still gains XP.
 * `worldserver/lua_scripts/xp.lua` reads the same rows every few seconds.
 */
export async function getXpLock(guid: number, realmId: number = 1): Promise<number | null> {
  await ensureWebDb();
  const [rows] = await getPool().query<RowDataPacket[]>(
    `SELECT target_level FROM \`${WEB_DB}\`.shop_xp_locks
      WHERE character_guid = ? AND realm_id = ? AND released_at IS NULL`,
    [guid, realmId]
  );
  return rows[0] ? Number(rows[0].target_level) : null;
}

/** Every live lock on an account's characters, keyed by guid & realm, for the UI. */
export async function listXpLocks(
  accountId: number
): Promise<Record<string, number>> {
  await ensureWebDb();
  const [rows] = await getPool().query<RowDataPacket[]>(
    `SELECT character_guid, realm_id, target_level
       FROM \`${WEB_DB}\`.shop_xp_locks
      WHERE account_id = ? AND released_at IS NULL`,
    [accountId]
  );
  const out: Record<string, number> = {};
  for (const r of rows) {
    const guid = Number(r.character_guid);
    const realmId = Number(r.realm_id);
    const level = Number(r.target_level);
    out[`${realmId}:${guid}`] = level;
    out[String(guid)] = level;
  }
  return out;
}

export async function listProducts(): Promise<ProductRow[]> {
  await ensureWebDb();
  const [rows] = await getPool().query<ProductRow[]>(
    `SELECT id, slug, name, description, price, delivery_type, payload
       FROM \`${WEB_DB}\`.shop_products
      WHERE enabled = 1
      ORDER BY price, id`
  );
  return rows;
}

export interface PackInfo {
  minLevel: number;
  /** class id → spec slugs that have gear in this pack (empty = no choice needed). */
  specsByClass: Record<number, string[]>;
}

/** Pack metadata the shop UI needs to render character/spec pickers. */
export async function listPackInfo(): Promise<Record<string, PackInfo>> {
  await ensureWebDb();
  const pool = getPool();
  const [packs] = await pool.query<RowDataPacket[]>(
    `SELECT id, slug, min_level FROM \`${WEB_DB}\`.shop_packs`
  );
  const [specs] = await pool.query<RowDataPacket[]>(
    `SELECT pack_id, class_id, spec FROM \`${WEB_DB}\`.shop_pack_items
      WHERE spec IS NOT NULL
      GROUP BY pack_id, class_id, spec`
  );
  const out: Record<string, PackInfo> = {};
  const byId = new Map<number, PackInfo>();
  for (const p of packs) {
    const info: PackInfo = { minLevel: Number(p.min_level), specsByClass: {} };
    out[String(p.slug)] = info;
    byId.set(Number(p.id), info);
  }
  for (const s of specs) {
    const info = byId.get(Number(s.pack_id));
    if (!info) continue;
    (info.specsByClass[Number(s.class_id)] ??= []).push(String(s.spec));
  }
  return out;
}

export async function listTransactions(accountId: number): Promise<RowDataPacket[]> {
  await ensureWebDb();
  const [rows] = await getPool().query<RowDataPacket[]>(
    `SELECT t.id, p.slug AS product_slug, p.name AS product_name,
            t.character_name, t.price_paid, t.status, t.error, t.created_at
       FROM \`${WEB_DB}\`.shop_transactions t
       JOIN \`${WEB_DB}\`.shop_products p ON p.id = t.product_id
      WHERE t.account_id = ?
      ORDER BY t.id DESC
      LIMIT 50`,
    [accountId]
  );
  return rows;
}

/** Every account that has ever held points, for the admin overview. */
export async function listBalances(): Promise<RowDataPacket[]> {
  await ensureWebDb();
  const [rows] = await getPool().query<RowDataPacket[]>(
    `SELECT b.account_id, a.username, b.balance, b.updated_at
       FROM \`${WEB_DB}\`.shop_balances b
       JOIN \`${AUTH_DB}\`.account a ON a.id = b.account_id
      ORDER BY b.balance DESC, a.username
      LIMIT 200`
  );
  return rows;
}

export async function listRecentLedger(): Promise<RowDataPacket[]> {
  await ensureWebDb();
  const [rows] = await getPool().query<RowDataPacket[]>(
    `SELECT l.id, l.account_id, a.username, l.delta, l.reason, l.note, l.created_at
       FROM \`${WEB_DB}\`.shop_ledger l
       LEFT JOIN \`${AUTH_DB}\`.account a ON a.id = l.account_id
      ORDER BY l.id DESC
      LIMIT 100`
  );
  return rows;
}

export async function getTransactionById(id: number): Promise<TxnRow> {
  const [rows] = await getPool().query<TxnRow[]>(
    `SELECT * FROM \`${WEB_DB}\`.shop_transactions WHERE id = ?`,
    [id]
  );
  if (!rows[0]) throw new HttpError(404, "Transaction not found.");
  return rows[0];
}

async function getTransactionByIdempotencyKey(key: string): Promise<TxnRow> {
  const [rows] = await getPool().query<TxnRow[]>(
    `SELECT * FROM \`${WEB_DB}\`.shop_transactions WHERE idempotency_key = ?`,
    [key]
  );
  if (!rows[0]) throw new HttpError(500, "Duplicate purchase could not be resolved.");
  return rows[0];
}

// ── Currency grants (admin / vote / donation callbacks) ───────────────────

export async function grantPoints(input: {
  accountId: number;
  delta: number;
  reason: "vote" | "donation" | "admin_grant";
  reference: string | null;
  note: string | null;
}): Promise<number> {
  await ensureWebDb();
  const pool = getPool();
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    if (input.delta >= 0) {
      await conn.query(
        `INSERT INTO \`${WEB_DB}\`.shop_balances (account_id, balance)
         VALUES (?, ?) ON DUPLICATE KEY UPDATE balance = balance + VALUES(balance)`,
        [input.accountId, input.delta]
      );
    } else {
      const [res] = await conn.query<ResultSetHeader>(
        `UPDATE \`${WEB_DB}\`.shop_balances
            SET balance = balance - ?
          WHERE account_id = ? AND balance >= ?`,
        [-input.delta, input.accountId, -input.delta]
      );
      if (res.affectedRows === 0) {
        throw new HttpError(409, "Balance too low for that deduction.");
      }
    }
    await conn.query(
      `INSERT INTO \`${WEB_DB}\`.shop_ledger (account_id, delta, reason, reference, note)
       VALUES (?, ?, ?, ?, ?)`,
      [input.accountId, input.delta, input.reason, input.reference, input.note]
    );
    await conn.commit();
  } catch (err) {
    await conn.rollback();
    if ((err as { code?: string }).code === "ER_DUP_ENTRY") {
      // uq_reason_ref: this external credit was already applied once.
      throw new HttpError(409, "This credit was already applied.");
    }
    throw err;
  } finally {
    conn.release();
  }
  return getBalance(input.accountId);
}

// ── Purchase ───────────────────────────────────────────────────────────────

export async function purchase(input: {
  accountId: number;
  productSlug: string;
  characterGuid: number;
  realmId?: number;
  spec: string | null;
  idempotencyKey: string;
}): Promise<TxnRow> {
  await ensureWebDb();
  const pool = getPool();

  // Phase 0: resolve and validate everything before any money moves.
  const product = await getEnabledProduct(input.productSlug);
  const character = await getOwnedCharacter(input.characterGuid, input.accountId, input.realmId);
  if (!NAME_RE.test(character.name)) {
    throw new HttpError(400, "Character name contains unsupported characters.");
  }
  const snapshot = await resolveSnapshot(product, character, input.spec);

  // Phase 1: atomically deduct and record the order.
  const conn = await pool.getConnection();
  let txnId: number;
  try {
    await conn.beginTransaction();

    const [deduct] = await conn.query<ResultSetHeader>(
      `UPDATE \`${WEB_DB}\`.shop_balances
          SET balance = balance - ?
        WHERE account_id = ? AND balance >= ?`,
      [product.price, input.accountId, product.price]
    );
    if (deduct.affectedRows === 0) {
      throw new HttpError(402, "Not enough points.");
    }

    const [ins] = await conn.query<ResultSetHeader>(
      `INSERT INTO \`${WEB_DB}\`.shop_transactions
         (idempotency_key, account_id, product_id, price_paid,
          character_guid, character_name, realm_id, payload_snapshot, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending')`,
      [
        input.idempotencyKey,
        input.accountId,
        product.id,
        product.price,
        character.guid,
        character.name,
        character.realm_id || input.realmId || 1,
        JSON.stringify(snapshot),
      ]
    );
    txnId = ins.insertId;

    await conn.query(
      `INSERT INTO \`${WEB_DB}\`.shop_ledger (account_id, delta, reason, reference, note)
       VALUES (?, ?, 'purchase', ?, ?)`,
      [input.accountId, -product.price, String(txnId), product.slug]
    );

    await conn.commit();
  } catch (err) {
    await conn.rollback();
    if ((err as { code?: string }).code === "ER_DUP_ENTRY") {
      // Replayed idempotency key: return the original order unchanged.
      return getTransactionByIdempotencyKey(input.idempotencyKey);
    }
    throw err;
  } finally {
    conn.release();
  }

  // Phase 2: deliver, outside any DB transaction.
  await deliver(txnId);
  return getTransactionById(txnId);
}

async function getEnabledProduct(slug: string): Promise<ProductRow> {
  const [rows] = await getPool().query<ProductRow[]>(
    `SELECT id, slug, name, description, price, delivery_type, payload
       FROM \`${WEB_DB}\`.shop_products
      WHERE slug = ? AND enabled = 1`,
    [slug]
  );
  if (!rows[0]) throw new HttpError(404, "Unknown shop item.");
  return rows[0];
}

async function getOwnedCharacter(
  guid: number,
  accountId: number,
  realmId?: number
): Promise<CharacterRow> {
  if (!Number.isInteger(guid) || guid <= 0) {
    throw new HttpError(400, "Pick a character.");
  }

  const pool = getPool();
  if (realmId) {
    const realmConfig = await getRealmConfigById(realmId);
    if (realmConfig) {
      const [rows] = await pool.query<RowDataPacket[]>(
        `SELECT guid, name, race, class, level, online
           FROM \`${realmConfig.charsDb}\`.characters
          WHERE guid = ? AND account = ? AND deleteInfos_Account IS NULL`,
        [guid, accountId]
      );
      if (rows[0]) {
        return {
          guid: Number(rows[0].guid),
          name: String(rows[0].name),
          race: Number(rows[0].race),
          class: Number(rows[0].class),
          level: Number(rows[0].level),
          online: Number(rows[0].online),
          realm_id: realmConfig.id,
          realm_name: realmConfig.name,
        } as CharacterRow;
      }
    }
  }

  const realms = await listRealmsWithConfig();
  for (const r of realms) {
    try {
      const [rows] = await pool.query<RowDataPacket[]>(
        `SELECT guid, name, race, class, level, online
           FROM \`${r.charsDb}\`.characters
          WHERE guid = ? AND account = ? AND deleteInfos_Account IS NULL`,
        [guid, accountId]
      );
      if (rows[0]) {
        return {
          guid: Number(rows[0].guid),
          name: String(rows[0].name),
          race: Number(rows[0].race),
          class: Number(rows[0].class),
          level: Number(rows[0].level),
          online: Number(rows[0].online),
          realm_id: r.id,
          realm_name: r.name,
        } as CharacterRow;
      }
    } catch {}
  }

  throw new HttpError(404, "That character is not on your account.");
}

async function getKnownProfessionSkills(guid: number, charsDb: string): Promise<number[]> {
  const [rows] = await getPool().query<RowDataPacket[]>(
    `SELECT skill FROM \`${charsDb}\`.character_skills
      WHERE guid = ? AND skill IN (?)`,
    [guid, [...PRIMARY_SKILLS, ...SECONDARY_SKILLS]]
  );
  return rows.map((r: RowDataPacket) => Number(r.skill));
}

async function resolveSnapshot(
  product: ProductRow,
  character: CharacterRow,
  spec: string | null
): Promise<Snapshot> {
  const payload = asJson<Record<string, unknown>>(product.payload);

  if (product.delivery_type === "level_boost") {
    const level = Number(payload.level);
    if (!Number.isInteger(level) || level < 2 || level > 80) {
      throw new HttpError(500, "Product is misconfigured (level).");
    }
    if (character.level >= level) {
      throw new HttpError(409, `${character.name} is already level ${character.level}.`);
    }
    // A boost sets the level outright, so it would walk straight through an
    // XP lock — the Lua hook only ever sees experience. Refuse instead of
    // silently undoing something the same player paid for.
    const lockedAt = await getXpLock(character.guid, character.realm_id);
    if (lockedAt !== null) {
      throw new HttpError(
        409,
        `${character.name}'s experience is locked at level ${lockedAt}. ` +
          "Buy the unlock first if you want to level past it."
      );
    }
    return { type: "level_boost", level };
  }

  if (product.delivery_type === "xp_lock") {
    const action = payload.action === "release" ? "release" : "lock";
    const lockedAt = await getXpLock(character.guid, character.realm_id);

    if (action === "release") {
      if (lockedAt === null) {
        throw new HttpError(409, `${character.name}'s experience is not locked.`);
      }
      return { type: "xp_lock", action, targetLevel: lockedAt };
    }

    if (lockedAt !== null) {
      throw new HttpError(
        409,
        `${character.name}'s experience is already locked at level ${lockedAt}.`
      );
    }
    // A null level means "hold them where they stand"; a number makes the
    // product a bracket lock that can be bought early and bites on arrival.
    const target =
      payload.level == null ? character.level : Number(payload.level);
    if (!Number.isInteger(target) || target < 1 || target > 80) {
      throw new HttpError(500, "Product is misconfigured (level).");
    }
    if (character.level > target) {
      throw new HttpError(
        409,
        `${character.name} is already level ${character.level}, past this lock's level ${target}.`
      );
    }
    return { type: "xp_lock", action, targetLevel: target };
  }

  if (product.delivery_type === "playerbot_slot") {
    const maxBots = Number(payload.max_bots ?? 1);
    return { type: "playerbot_slot", maxBots };
  }

  if (product.delivery_type === "profession_boost") {
    const skillCap = Number(payload.skill_cap ?? 450);
    if (character.online !== 0) {
      throw new HttpError(
        409,
        "Log the character out first — profession boosts are applied while offline."
      );
    }
    const charsDb = await charsDbForRealm(character.realm_id);
    if (!charsDb) {
      throw new HttpError(500, `Realm ${character.realm_id} is not configured.`);
    }
    const known = await getKnownProfessionSkills(character.guid, charsDb);
    if (known.length === 0) {
      throw new HttpError(409, `${character.name} has no professions to boost.`);
    }
    return { type: "profession_boost", skillCap };
  }

  // item_pack
  const packSlug = String(payload.pack ?? "");
  const [packs] = await getPool().query<RowDataPacket[]>(
    `SELECT id, slug, min_level FROM \`${WEB_DB}\`.shop_packs WHERE slug = ?`,
    [packSlug]
  );
  const pack = packs[0];
  if (!pack) throw new HttpError(500, "Product is misconfigured (pack).");
  if (character.level < Number(pack.min_level)) {
    throw new HttpError(
      409,
      `${character.name} must be at least level ${pack.min_level} for this pack.`
    );
  }

  // Spec is required iff the pack has spec-specific gear for this class.
  const [specRows] = await getPool().query<RowDataPacket[]>(
    `SELECT DISTINCT spec FROM \`${WEB_DB}\`.shop_pack_items
      WHERE pack_id = ? AND class_id = ? AND spec IS NOT NULL`,
    [pack.id, character.class]
  );
  const validSpecs = specRows.map((r) => String(r.spec));
  let chosenSpec: string | null = null;
  if (validSpecs.length > 0) {
    if (!spec || !SPEC_RE.test(spec) || !validSpecs.includes(spec)) {
      throw new HttpError(
        400,
        `Pick a spec for this pack: ${validSpecs.join(", ")}.`
      );
    }
    chosenSpec = spec;
  }

  const [items] = await getPool().query<RowDataPacket[]>(
    `SELECT item_id, count FROM \`${WEB_DB}\`.shop_pack_items
      WHERE pack_id = ?
        AND (class_id IS NULL OR class_id = ?)
        AND (spec IS NULL OR spec = ?)
      ORDER BY category, id`,
    [pack.id, character.class, chosenSpec]
  );
  if (items.length === 0) {
    throw new HttpError(
      409,
      "This pack has no contents for your class yet — ask an admin."
    );
  }

  const mails: { itemId: number; count: number }[][] = [];
  for (let i = 0; i < items.length; i += MAIL_MAX_ATTACHMENTS) {
    mails.push(
      items.slice(i, i + MAIL_MAX_ATTACHMENTS).map((it) => ({
        itemId: Number(it.item_id),
        count: Number(it.count),
      }))
    );
  }
  return { type: "item_pack", pack: packSlug, spec: chosenSpec, mails };
}

// ── Delivery ───────────────────────────────────────────────────────────────

export async function deliver(txnId: number): Promise<void> {
  const pool = getPool();

  // Claim the row; if a concurrent worker got here first this is a no-op,
  // so a transaction can never be delivered twice.
  const [claim] = await pool.query<ResultSetHeader>(
    `UPDATE \`${WEB_DB}\`.shop_transactions
        SET status = 'delivering', attempts = attempts + 1
      WHERE id = ? AND status = 'pending'`,
    [txnId]
  );
  if (claim.affectedRows === 0) return;

  const txn = await getTransactionById(txnId);
  const snapshot = asJson<Snapshot>(txn.payload_snapshot);

  try {
    // Everything below is scoped to the realm the purchase was made on. Guids
    // and names are per-realm, and so is the worldserver that has to run the
    // command — resolving the database here means one lookup for all of them.
    const realmId = txn.realm_id || 1;
    const charsDb = await charsDbForRealm(realmId);
    if (!charsDb) {
      throw new DeliveryError("fault", `Realm ${realmId} is no longer configured.`);
    }

    // Address by the name freshly re-read by guid (renames since purchase),
    // and re-validate before it goes anywhere near a console command.
    const name = await getCurrentCharacterName(txn.character_guid, charsDb);

    if (snapshot.type === "level_boost") {
      // Works whether the character is online or offline.
      await soapOrThrow(`.character level ${name} ${snapshot.level}`, realmId);
    } else if (snapshot.type === "item_pack") {
      let sent = 0;
      for (let i = 0; i < snapshot.mails.length; i++) {
        const items = snapshot.mails[i]
          .map((it) => (it.count > 1 ? `${it.itemId}:${it.count}` : `${it.itemId}`))
          .join(" ");
        try {
          await soapOrThrow(
            `.send items ${name} "SummonStack Shop (${i + 1}/${snapshot.mails.length})" ` +
              `"Thanks for your purchase!" ${items}`,
            realmId
          );
          sent++;
        } catch (err) {
          if (sent > 0) {
            // Partially delivered: not safe to auto-refund the full price.
            throw new DeliveryError(
              "partial",
              `Delivered ${sent}/${snapshot.mails.length} mails, then: ${(err as Error).message}`
            );
          }
          throw err;
        }
      }
    } else if (snapshot.type === "profession_boost") {
      await deliverProfessionBoost(txn.character_guid, snapshot.skillCap, charsDb);
    } else if (snapshot.type === "xp_lock") {
      await deliverXpLock(txn, snapshot);
    } else if (snapshot.type === "playerbot_slot") {
      // playerbot_slot is recorded atomically in shop_transactions for the account.
    }

    await setStatus(txnId, "delivering", "delivered", null);
  } catch (err) {
    const e = err as Error;
    const kind = err instanceof DeliveryError ? err.kind : "fault";
    if (kind === "fault") {
      // Clean rejection: nothing was granted, safe to refund.
      await refund(txn, e.message);
    } else {
      // 'unreachable' (effect unknown — may have executed) and 'partial'
      // must NOT auto-refund. Park for admin review; the sweep query is
      // status IN ('delivering','failed') ordered by updated_at.
      await setStatus(
        txnId,
        "delivering",
        kind === "partial" ? "failed" : "delivering",
        e.message
      );
    }
  }
}

async function getCurrentCharacterName(guid: number, charsDb: string): Promise<string> {
  const [rows] = await getPool().query<RowDataPacket[]>(
    `SELECT name FROM \`${charsDb}\`.characters
      WHERE guid = ? AND deleteInfos_Account IS NULL`,
    [guid]
  );
  const name = String(rows[0]?.name ?? "");
  if (!NAME_RE.test(name)) {
    throw new DeliveryError("fault", "Character no longer exists or was renamed oddly.");
  }
  return name;
}

/**
 * Delivery is a row in the web DB — no SOAP, so there is no unreachable or
 * partial case here: it either commits or it throws cleanly and refunds.
 * The worldserver picks the change up on its next poll (5s).
 */
async function deliverXpLock(
  txn: TxnRow,
  snapshot: Extract<Snapshot, { type: "xp_lock" }>
): Promise<void> {
  const pool = getPool();

  // Every statement below is scoped by realm as well as guid: guids restart at
  // 1 in each character database, so without it a purchase could release or
  // overwrite the lock of an unrelated character on another realm.
  const realmId = txn.realm_id || 1;

  if (snapshot.action === "release") {
    const [res] = await pool.query<ResultSetHeader>(
      `UPDATE \`${WEB_DB}\`.shop_xp_locks
          SET released_at = NOW()
        WHERE character_guid = ? AND realm_id = ? AND released_at IS NULL`,
      [txn.character_guid, realmId]
    );
    // Guarded, so two releases in flight can only pay for one.
    if (res.affectedRows === 0) {
      throw new DeliveryError("fault", "That character's experience is not locked.");
    }
    return;
  }

  // The row is kept after a release, so re-locking updates it in place.
  try {
    await pool.query(
      `INSERT INTO \`${WEB_DB}\`.shop_xp_locks
         (character_guid, account_id, realm_id, target_level)
       VALUES (?, ?, ?, ?)`,
      [txn.character_guid, txn.account_id, realmId, snapshot.targetLevel]
    );
  } catch (err) {
    if ((err as { code?: string }).code !== "ER_DUP_ENTRY") throw err;
    const [res] = await pool.query<ResultSetHeader>(
      `UPDATE \`${WEB_DB}\`.shop_xp_locks
          SET account_id = ?, target_level = ?, locked_at = NOW(), released_at = NULL
        WHERE character_guid = ? AND realm_id = ? AND released_at IS NOT NULL`,
      [txn.account_id, snapshot.targetLevel, txn.character_guid, realmId]
    );
    // The released_at guard means a concurrent second purchase cannot charge
    // twice for the same lock.
    if (res.affectedRows === 0) {
      throw new DeliveryError(
        "fault",
        "That character's experience is already locked."
      );
    }
  }
}

async function deliverProfessionBoost(
  guid: number,
  cap: number,
  charsDb: string
): Promise<void> {
  const pool = getPool();
  await assertOffline(guid, charsDb);

  const known = await getKnownProfessionSkills(guid, charsDb);
  if (known.length === 0) {
    throw new DeliveryError("fault", "Character has no professions to boost.");
  }
  await pool.query(
    `UPDATE \`${charsDb}\`.character_skills
        SET value = ?, max = ?
      WHERE guid = ? AND skill IN (?)`,
    [cap, cap, guid, known]
  );
  // If they logged in mid-write, their in-memory state will clobber the
  // update on next save — treat as failed so the refund path runs.
  await assertOffline(guid, charsDb);
}

async function assertOffline(guid: number, charsDb: string): Promise<void> {
  const [rows] = await getPool().query<RowDataPacket[]>(
    `SELECT online FROM \`${charsDb}\`.characters WHERE guid = ?`,
    [guid]
  );
  if (Number(rows[0]?.online ?? 1) !== 0) {
    throw new DeliveryError(
      "fault",
      "Character logged in during the boost — points refunded, log out and try again."
    );
  }
}

async function setStatus(
  txnId: number,
  from: TxnRow["status"],
  to: TxnRow["status"],
  error: string | null
): Promise<void> {
  await getPool().query(
    `UPDATE \`${WEB_DB}\`.shop_transactions
        SET status = ?, error = ?
      WHERE id = ? AND status = ?`,
    [to, error ? error.slice(0, 2000) : null, txnId, from]
  );
}

async function refund(txn: TxnRow, error: string): Promise<void> {
  const conn = await getPool().getConnection();
  try {
    await conn.beginTransaction();
    const [flip] = await conn.query<ResultSetHeader>(
      `UPDATE \`${WEB_DB}\`.shop_transactions
          SET status = 'refunded', error = ?
        WHERE id = ? AND status = 'delivering'`,
      [error.slice(0, 2000), txn.id]
    );
    // The status guard means the refund applies exactly once.
    if (flip.affectedRows === 1) {
      await conn.query(
        `INSERT INTO \`${WEB_DB}\`.shop_balances (account_id, balance)
         VALUES (?, ?) ON DUPLICATE KEY UPDATE balance = balance + VALUES(balance)`,
        [txn.account_id, txn.price_paid]
      );
      await conn.query(
        `INSERT INTO \`${WEB_DB}\`.shop_ledger (account_id, delta, reason, reference, note)
         VALUES (?, ?, 'refund', ?, ?)`,
        [txn.account_id, txn.price_paid, String(txn.id), error.slice(0, 255)]
      );
    }
    await conn.commit();
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}
