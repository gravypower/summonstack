import net from "node:net";
import type { RowDataPacket } from "mysql2";
import { AUTH_DB, CHARS_DB, getPool } from "./db";
import { listRealmsWithConfig } from "./realm";

export interface RealmStatusDetail {
  id: number;
  name: string;
  address: string;
  port: number;
  worldOnline: boolean;
  playersOnline: number | null;
  uptimeSeconds: number | null;
}

export interface ServerStatus {
  realmName: string | null;
  realmAddress: string | null;
  realmPort: number | null;
  authOnline: boolean;
  worldOnline: boolean;
  playersOnline: number | null;
  uptimeSeconds: number | null;
  zerotierNetworkId: string | null;
  realms?: RealmStatusDetail[];
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

  const authOnline = await probe(
    process.env.AUTH_HOST || "ac-authserver",
    Number(process.env.AUTH_PORT || 3724)
  );

  const status: ServerStatus = {
    realmName: null,
    realmAddress: null,
    realmPort: null,
    authOnline,
    worldOnline: false,
    playersOnline: null,
    uptimeSeconds: null,
    zerotierNetworkId: process.env.ZEROTIER_NETWORK_ID?.trim() || null,
    realms: [],
  };

  try {
    const realms = await listRealmsWithConfig();
    const pool = getPool();
    const realmDetails: RealmStatusDetail[] = [];

    for (const r of realms) {
      const worldOnline = await probe(r.worldHost, r.worldPort);
      let playersOnline: number | null = null;
      let uptimeSeconds: number | null = null;

      if (worldOnline) {
        try {
          const [online] = await pool.query<RowDataPacket[]>(
            `SELECT COUNT(*) AS n FROM \`${r.charsDb}\`.characters WHERE online = 1`
          );
          playersOnline = Number(online[0]?.n ?? 0);
        } catch {}

        try {
          const [uptime] = await pool.query<RowDataPacket[]>(
            `SELECT starttime FROM \`${AUTH_DB}\`.uptime WHERE realmid = ? ORDER BY starttime DESC LIMIT 1`,
            [r.id]
          );
          if (uptime[0]) {
            uptimeSeconds = Math.max(
              0,
              Math.floor(Date.now() / 1000) - Number(uptime[0].starttime)
            );
          } else {
            const [fallbackUptime] = await pool.query<RowDataPacket[]>(
              `SELECT starttime FROM \`${AUTH_DB}\`.uptime ORDER BY starttime DESC LIMIT 1`
            );
            if (fallbackUptime[0]) {
              uptimeSeconds = Math.max(
                0,
                Math.floor(Date.now() / 1000) - Number(fallbackUptime[0].starttime)
              );
            }
          }
        } catch {}
      }

      realmDetails.push({
        id: r.id,
        name: r.name,
        address: r.address,
        port: r.port,
        worldOnline,
        playersOnline,
        uptimeSeconds,
      });
    }

    status.realms = realmDetails;
    if (realmDetails.length > 0) {
      const first = realmDetails[0];
      status.realmName = first.name;
      status.realmAddress = first.address;
      status.realmPort = first.port;
      status.worldOnline = first.worldOnline;
      status.playersOnline = first.playersOnline;
      status.uptimeSeconds = first.uptimeSeconds;
    }
  } catch {
    // Databases may not be imported yet on first boot — leave defaults.
  }

  cached = { at: Date.now(), status };
  return status;
}
