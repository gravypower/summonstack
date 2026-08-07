import { errorResponse, getGmLevel, HttpError, requireSession } from "@/lib/auth";
import { AUTH_DB, getPool } from "@/lib/db";
import { listRealmsWithConfig } from "@/lib/realm";
import type { RowDataPacket } from "mysql2";

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

/**
 * Who a player may look up.
 *
 * This backs an autocomplete, so it has to stay usable — but it used to hand
 * any logged-in player the entire account list, every character on every
 * realm, and the account behind each character, on a single-letter match.
 * Only staff searching for someone to administer needs that; a player picking
 * one of their own bots does not.
 *
 * Accounts are admin-only, the owning account name is admin-only, and the
 * query has a floor so the endpoint cannot be walked a letter at a time.
 */
const MIN_QUERY_LENGTH = 2;

export async function GET(req: Request): Promise<Response> {
  try {
    const session = await requireSession();
    const isAdmin = (await getGmLevel(session.accountId)) >= 3;
    const url = new URL(req.url);
    const query = (url.searchParams.get("q") || "").trim();
    const targetType = url.searchParams.get("type") || "all"; // 'character', 'account', or 'all'

    if (targetType === "account" && !isAdmin) {
      throw new HttpError(403, "Admin access required to search accounts.");
    }

    if (query.length < MIN_QUERY_LENGTH) {
      return Response.json({ results: [] });
    }

    const pool = getPool();
    const results: SearchResultItem[] = [];
    const searchTerm = `%${query}%`;

    // 1. Search Accounts in AUTH_DB — staff only.
    if (isAdmin && (targetType === "all" || targetType === "account")) {
      const [accRows] = await pool.query<RowDataPacket[]>(
        `SELECT id, username FROM \`${AUTH_DB}\`.account
          WHERE username LIKE ?
          ORDER BY username ASC
          LIMIT 10`,
        [searchTerm]
      );
      for (const r of accRows) {
        results.push({
          type: "account",
          name: String(r.username),
          id: Number(r.id),
        });
      }
    }

    // 2. Search Characters across all configured realmlist databases
    if (targetType === "all" || targetType === "character") {
      const realms = await listRealmsWithConfig();
      for (const r of realms) {
        try {
          const [charRows] = await pool.query<RowDataPacket[]>(
            `SELECT c.guid, c.name, c.level, c.class, c.race, a.username as account_name
               FROM \`${r.charsDb}\`.characters c
               LEFT JOIN \`${AUTH_DB}\`.account a ON a.id = c.account
              WHERE c.name LIKE ? AND c.deleteInfos_Account IS NULL
              ORDER BY c.level DESC, c.name ASC
              LIMIT 10`,
            [searchTerm]
          );
          for (const c of charRows) {
            results.push({
              type: "character",
              name: String(c.name),
              guid: Number(c.guid),
              level: Number(c.level),
              class: Number(c.class),
              race: Number(c.race),
              realmId: r.id,
              realmName: r.name,
              // Which account owns a character is staff information: players
              // need to find a character, not to map the server's alts.
              accountName:
                isAdmin && c.account_name ? String(c.account_name) : undefined,
            });
          }
        } catch {}
      }
    }

    return Response.json({ results });
  } catch (err) {
    return errorResponse(err);
  }
}
