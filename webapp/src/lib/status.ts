import net from "node:net";
import type { RowDataPacket } from "mysql2";
import { AUTH_DB, CHARS_DB, getPool } from "./db";

export interface ServerStatus {
  realmName: string | null;
  realmAddress: string | null;
  realmPort: number | null;
  authOnline: boolean;
  worldOnline: boolean;
  playersOnline: number | null;
  uptimeSeconds: number | null;
  zerotierNetworkId: string | null;
}

function probe(host: string, port: number, timeoutMs = 1500): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port });
    const done = (up: boolean) => {
      socket.destroy();
      resolve(up);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
  });
}

let cached: { at: number; status: ServerStatus } | null = null;

export async function getServerStatus(): Promise<ServerStatus> {
  if (cached && Date.now() - cached.at < 10_000) return cached.status;

  const status: ServerStatus = {
    realmName: null,
    realmAddress: null,
    realmPort: null,
    authOnline: false,
    worldOnline: false,
    playersOnline: null,
    uptimeSeconds: null,
    zerotierNetworkId: process.env.ZEROTIER_NETWORK_ID?.trim() || null,
  };

  const [authOnline, worldOnline] = await Promise.all([
    probe(process.env.AUTH_HOST || "ac-authserver", Number(process.env.AUTH_PORT || 3724)),
    probe(process.env.WORLD_HOST || "ac-worldserver", Number(process.env.WORLD_PORT || 8085)),
  ]);
  status.authOnline = authOnline;
  status.worldOnline = worldOnline;

  try {
    const pool = getPool();
    const [realms] = await pool.query<RowDataPacket[]>(
      `SELECT name, address, port FROM \`${AUTH_DB}\`.realmlist ORDER BY id LIMIT 1`
    );
    if (realms[0]) {
      status.realmName = String(realms[0].name);
      status.realmAddress = String(realms[0].address);
      status.realmPort = Number(realms[0].port);
    }

    if (worldOnline) {
      const [online] = await pool.query<RowDataPacket[]>(
        `SELECT COUNT(*) AS n FROM \`${CHARS_DB}\`.characters WHERE online = 1`
      );
      status.playersOnline = Number(online[0]?.n ?? 0);

      const [uptime] = await pool.query<RowDataPacket[]>(
        `SELECT starttime FROM \`${AUTH_DB}\`.uptime ORDER BY starttime DESC LIMIT 1`
      );
      if (uptime[0]) {
        status.uptimeSeconds = Math.max(
          0,
          Math.floor(Date.now() / 1000) - Number(uptime[0].starttime)
        );
      }
    }
  } catch {
    // Databases may not be imported yet on first boot — leave nulls.
  }

  cached = { at: Date.now(), status };
  return status;
}
