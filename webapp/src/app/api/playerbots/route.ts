import { errorResponse, HttpError, requireSession } from "@/lib/auth";
import { getPool, WEB_DB } from "@/lib/db";
import { getRealmConfigById, listRealmsWithConfig } from "@/lib/realm";
import { soapCommand } from "@/lib/soap";
import type { RowDataPacket } from "mysql2";

/** AC character names are plain letters; this also guards SOAP interpolation. */
const NAME_RE = /^[A-Za-z]{2,12}$/;

export interface BotInfo {
  guid: number;
  name: string;
  race: number;
  class: number;
  level: number;
  online: boolean;
  realmId: number;
  realmName: string;
}

export async function GET(): Promise<Response> {
  try {
    const session = await requireSession();
    const pool = getPool();

    // 1. Check if user has purchased playerbot_slot tokens or holds GM level >= 3
    const [purchases] = await pool.query<RowDataPacket[]>(
      `SELECT t.id
         FROM \`${WEB_DB}\`.shop_transactions t
         JOIN \`${WEB_DB}\`.shop_products p ON p.id = t.product_id
        WHERE t.account_id = ? AND t.status = 'delivered' AND p.delivery_type = 'playerbot_slot'`,
      [session.accountId]
    );

    const hasPurchased = purchases.length > 0;

    // 2. Fetch characters for this account across realms
    const realms = await listRealmsWithConfig();
    const characters: BotInfo[] = [];

    for (const r of realms) {
      try {
        const [rows] = await pool.query<RowDataPacket[]>(
          `SELECT c.guid, c.name, c.race, c.class, c.level, c.online
             FROM \`${r.charsDb}\`.characters c
            WHERE c.account = ? AND c.deleteInfos_Account IS NULL
            ORDER BY c.level DESC, c.name`,
          [session.accountId]
        );
        for (const row of rows) {
          characters.push({
            guid: Number(row.guid),
            name: String(row.name),
            race: Number(row.race),
            class: Number(row.class),
            level: Number(row.level),
            online: Boolean(row.online),
            realmId: r.id,
            realmName: r.name,
          });
        }
      } catch {}
    }

    return Response.json({
      hasPurchased,
      characters,
    });
  } catch (err) {
    return errorResponse(err);
  }
}

/**
 * The character's name as stored, or null when it is not on this account.
 *
 * Both the name and the realm arrive from the client, and the name is
 * interpolated into a worldserver console command — so without this check any
 * token holder could add or delete *another player's* character as a random
 * bot on any realm.
 */
async function findOwnedCharacter(
  accountId: number,
  realmId: number,
  name: string
): Promise<string | null> {
  const realm = await getRealmConfigById(realmId);
  if (!realm) return null;
  const [rows] = await getPool().query<RowDataPacket[]>(
    `SELECT name FROM \`${realm.charsDb}\`.characters
      WHERE name = ? AND account = ? AND deleteInfos_Account IS NULL`,
    [name, accountId]
  );
  return rows[0] ? String(rows[0].name) : null;
}

export async function POST(req: Request): Promise<Response> {
  try {
    const session = await requireSession();
    const body = await req.json().catch(() => ({}));
    const { action, characterName, realmId } = body;

    if (!characterName || typeof characterName !== "string") {
      throw new HttpError(400, "Character name is required.");
    }
    if (action !== "login" && action !== "logout") {
      throw new HttpError(400, "Action must be 'login' or 'logout'.");
    }
    const requestedName = characterName.trim();
    if (!NAME_RE.test(requestedName)) {
      throw new HttpError(400, "That is not a valid character name.");
    }

    const targetRealmId =
      Number.isInteger(realmId) && realmId > 0 ? Number(realmId) : 1;

    // Ensure the user has purchased a playerbot_slot
    const pool = getPool();
    const [purchases] = await pool.query<RowDataPacket[]>(
      `SELECT t.id
         FROM \`${WEB_DB}\`.shop_transactions t
         JOIN \`${WEB_DB}\`.shop_products p ON p.id = t.product_id
        WHERE t.account_id = ? AND t.status = 'delivered' AND p.delivery_type = 'playerbot_slot'`,
      [session.accountId]
    );

    if (purchases.length === 0) {
      throw new HttpError(
        403,
        "You must purchase a Playerbot Access Token from the Shop before controlling bots."
      );
    }

    // Bots are driven by console commands, so the name must be one this
    // account owns on the realm it names — checked here, after the token check,
    // so an unowned name is refused rather than executed.
    const name = await findOwnedCharacter(
      session.accountId,
      targetRealmId,
      requestedName
    );
    if (!name || !NAME_RE.test(name)) {
      throw new HttpError(
        403,
        "That character is not on your account on this realm."
      );
    }

    // Command mapping: mod-playerbots console command
    // playerbots rndbot add <name> or playerbots rndbot delete <name>
    const command = action === "login"
      ? `playerbots rndbot add ${name}`
      : `playerbots rndbot delete ${name}`;

    const soapResult = await soapCommand(command, targetRealmId);

    return Response.json({
      success: soapResult.success,
      output: soapResult.output,
      action,
      characterName: name,
    });
  } catch (err) {
    return errorResponse(err);
  }
}
