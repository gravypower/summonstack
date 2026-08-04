import { errorResponse, HttpError, requireSession } from "@/lib/auth";
import { getPool, WEB_DB } from "@/lib/db";
import { listRealmsWithConfig } from "@/lib/realm";
import { soapCommand } from "@/lib/soap";
import type { RowDataPacket } from "mysql2";

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

    const targetRealmId = typeof realmId === "number" ? realmId : 1;

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

    // Command mapping: mod-playerbots console command
    // playerbots rndbot add <name> or playerbots rndbot delete <name>
    const command = action === "login"
      ? `playerbots rndbot add ${characterName.trim()}`
      : `playerbots rndbot delete ${characterName.trim()}`;

    const soapResult = await soapCommand(command, targetRealmId);

    return Response.json({
      success: soapResult.success,
      output: soapResult.output,
      action,
      characterName,
    });
  } catch (err) {
    return errorResponse(err);
  }
}
