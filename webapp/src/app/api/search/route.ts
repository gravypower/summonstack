import { errorResponse, requireSession } from "@/lib/auth";
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

export async function GET(req: Request): Promise<Response> {
  try {
    await requireSession();
    const url = new URL(req.url);
    const query = (url.searchParams.get("q") || "").trim();
    const targetType = url.searchParams.get("type") || "all"; // 'character', 'account', or 'all'

    if (!query || query.length < 1) {
      return Response.json({ results: [] });
    }

    const pool = getPool();
    const results: SearchResultItem[] = [];
    const searchTerm = `%${query}%`;

    // 1. Search Accounts in AUTH_DB
    if (targetType === "all" || targetType === "account") {
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
              accountName: c.account_name ? String(c.account_name) : undefined,
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
