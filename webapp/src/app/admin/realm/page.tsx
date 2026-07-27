"use client";

import { useCallback, useEffect, useState } from "react";

interface RealmStatus {
  id: number;
  name: string;
  address: string;
  localAddress: string;
  localSubnetMask: string;
  port: number;
  resolved: {
    address: string | null;
    localAddress: string | null;
    localSubnetMask: string | null;
  };
  broken: boolean;
  localOnly: boolean;
}

interface PreviewResult {
  id: number;
  name: string;
  outcome: {
    choice: "local" | "external" | "client-loopback";
    address: string;
    port: number;
  } | null;
}

interface RealmData {
  realms: RealmStatus[];
  unavailable: boolean;
  clientIp: string | null;
  suggestions: string[];
  preview: { clientIp: string; results: PreviewResult[] } | null;
}

type Draft = Pick<
  RealmStatus,
  "address" | "localAddress" | "localSubnetMask" | "port"
>;

const CHOICE_LABEL: Record<string, string> = {
  local: "local address",
  external: "address",
  "client-loopback": "its own loopback",
};

export default function AdminRealmPage() {
  const [data, setData] = useState<RealmData | null>(null);
  const [drafts, setDrafts] = useState<Record<number, Draft>>({});
  const [probe, setProbe] = useState("");
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState<number | null>(null);

  const load = useCallback(async (clientIp?: string) => {
    const qs = clientIp ? `?clientIp=${encodeURIComponent(clientIp)}` : "";
    const res = await fetch(`/api/admin/realm${qs}`);
    if (!res.ok) return;
    const next: RealmData = await res.json();
    setData(next);
    setDrafts((current) => {
      const merged = { ...current };
      for (const realm of next.realms) {
        // Only seed fields the admin has not started editing.
        if (!merged[realm.id]) {
          merged[realm.id] = {
            address: realm.address,
            localAddress: realm.localAddress,
            localSubnetMask: realm.localSubnetMask,
            port: realm.port,
          };
        }
      }
      return merged;
    });
    if (!clientIp && next.preview) setProbe(next.preview.clientIp);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  function edit(id: number, patch: Partial<Draft>) {
    setDrafts((current) => ({ ...current, [id]: { ...current[id], ...patch } }));
  }

  async function save(realm: RealmStatus) {
    const draft = drafts[realm.id];
    if (!draft) return;
    setBusy(realm.id);
    setMsg(null);
    const res = await fetch("/api/admin/realm", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: realm.id, ...draft, port: Number(draft.port) }),
    });
    const body = await res.json().catch(() => ({}));
    setBusy(null);
    if (!res.ok) {
      setMsg({ ok: false, text: body.error ?? "Could not save the realm." });
      return;
    }
    setMsg({
      ok: true,
      text: `Saved. The login server picks this up within about 20 seconds — no restart needed.`,
    });
    load(probe || undefined);
  }

  const realms = data?.realms ?? [];

  return (
    <>
      {data?.unavailable && (
        <div className="card">
          <p className="muted">
            Could not read the realm list — the databases may still be
            importing. Reload in a minute.
          </p>
        </div>
      )}

      {msg && <div className={`msg ${msg.ok ? "ok" : "error"}`}>{msg.text}</div>}

      {realms.map((realm) => {
        const draft = drafts[realm.id];
        if (!draft) return null;
        const dirty =
          draft.address !== realm.address ||
          draft.localAddress !== realm.localAddress ||
          draft.localSubnetMask !== realm.localSubnetMask ||
          Number(draft.port) !== realm.port;

        return (
          <form
            className="card"
            key={realm.id}
            onSubmit={(e) => {
              e.preventDefault();
              save(realm);
            }}
          >
            <h2>
              {realm.name}{" "}
              {realm.broken ? (
                <span className="pill red">not resolving</span>
              ) : realm.localOnly ? (
                <span className="pill gold">this machine only</span>
              ) : (
                <span className="pill green">reachable</span>
              )}
            </h2>

            {realm.broken && (
              <div className="msg error">
                One of the addresses below does not resolve, so the login server
                skips this realm entirely and players see an empty realm list.
              </div>
            )}
            {!realm.broken && realm.localOnly && (
              <div className="msg error">
                The realm hands out{" "}
                <span className="mono">{realm.resolved.address}</span>, so only a
                client on this machine can connect. Set it to the LAN IP or
                public hostname players will reach this server on.
              </div>
            )}

            <div className="grid">
              <label className="field">
                <span>Address — what everyone outside the local subnet gets</span>
                <input
                  className="input mono"
                  value={draft.address}
                  onChange={(e) => edit(realm.id, { address: e.target.value })}
                  placeholder="192.168.1.10 or play.example.com"
                  required
                />
              </label>
              <label className="field">
                <span>World port</span>
                <input
                  className="input mono"
                  type="number"
                  min={1}
                  max={65535}
                  value={draft.port}
                  onChange={(e) =>
                    edit(realm.id, { port: Number(e.target.value) })
                  }
                  required
                />
              </label>
              <label className="field">
                <span>Local address — handed to clients inside the subnet below</span>
                <input
                  className="input mono"
                  value={draft.localAddress}
                  onChange={(e) =>
                    edit(realm.id, { localAddress: e.target.value })
                  }
                  placeholder="192.168.1.10"
                  required
                />
              </label>
              <label className="field">
                <span>Local subnet mask</span>
                <input
                  className="input mono"
                  value={draft.localSubnetMask}
                  onChange={(e) =>
                    edit(realm.id, { localSubnetMask: e.target.value })
                  }
                  placeholder="255.255.255.0"
                  required
                />
              </label>
            </div>

            {data && data.suggestions.length > 0 && (
              <p className="muted">
                Reached this page on{" "}
                {data.suggestions.map((host) => (
                  <button
                    type="button"
                    key={host}
                    className="btn secondary small"
                    style={{ marginRight: "0.4rem" }}
                    onClick={() => edit(realm.id, { address: host })}
                  >
                    use {host}
                  </button>
                ))}
              </p>
            )}

            <div className="row">
              <button className="btn" disabled={!dirty || busy === realm.id}>
                {busy === realm.id ? "Saving…" : "Save"}
              </button>
              {dirty && (
                <button
                  type="button"
                  className="btn secondary"
                  onClick={() =>
                    setDrafts((current) => ({
                      ...current,
                      [realm.id]: {
                        address: realm.address,
                        localAddress: realm.localAddress,
                        localSubnetMask: realm.localSubnetMask,
                        port: realm.port,
                      },
                    }))
                  }
                >
                  Reset
                </button>
              )}
            </div>

            <p className="muted">
              Saved as written and re-resolved by the login server every ~20
              seconds, so a DNS name here keeps working when its IP changes.
              Currently resolving to{" "}
              <span className="mono">{realm.resolved.address ?? "nothing"}</span>
              {realm.resolved.localAddress && (
                <>
                  {" "}
                  (local{" "}
                  <span className="mono">{realm.resolved.localAddress}</span>)
                </>
              )}
              .
            </p>
          </form>
        );
      })}

      <div className="card">
        <h2>Which address would a player get?</h2>
        <p className="muted">
          The realm list packet carries exactly one IPv4 per client. The login
          server picks it per connection: clients inside the local subnet get
          the local address, everyone else gets the address. Enter a player&apos;s
          IP to see which one they would be told to connect to.
        </p>
        <form
          className="row"
          onSubmit={(e) => {
            e.preventDefault();
            load(probe);
          }}
        >
          <input
            className="input mono"
            style={{ maxWidth: 220 }}
            placeholder="203.0.113.9"
            value={probe}
            onChange={(e) => setProbe(e.target.value)}
          />
          <button className="btn secondary">Check</button>
          {data?.clientIp && (
            <button
              type="button"
              className="btn secondary"
              onClick={() => {
                setProbe(data.clientIp!);
                load(data.clientIp!);
              }}
            >
              Use my IP ({data.clientIp})
            </button>
          )}
        </form>

        {data?.preview && (
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>Realm</th>
                  <th>Column used</th>
                  <th>Told to connect to</th>
                </tr>
              </thead>
              <tbody>
                {data.preview.results.map((row) => (
                  <tr key={row.id}>
                    <td>{row.name}</td>
                    <td>
                      {row.outcome ? (
                        <span className="pill gray">
                          {CHOICE_LABEL[row.outcome.choice]}
                        </span>
                      ) : (
                        <span className="pill red">unresolvable</span>
                      )}
                    </td>
                    <td className="mono">
                      {row.outcome
                        ? `${row.outcome.address}:${row.outcome.port}`
                        : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="card">
        <h2>Running on several domains</h2>
        <p className="muted">
          A realm advertises one address per client, chosen between the two
          columns above — it cannot hand out a list. If players reach this
          server by several names, point them all at the same machine in DNS and
          put one of them (or the bare IP) in <em>Address</em>: the client is
          sent a resolved IPv4 either way, so the name it was typed under makes
          no difference once login succeeds.
        </p>
        <ul className="muted">
          <li>
            The local address/subnet pair is the one real split: LAN players can
            be sent a private IP while everyone else gets the public one.
          </li>
          <li>
            Truly separate addresses mean separate realm rows, which appear to
            players as separate realms with their own characters.
          </li>
          <li>
            Set <span className="mono">PUBLIC_HOST</span> in{" "}
            <span className="mono">.env</span> and run{" "}
            <span className="mono">docker compose up -d</span> so invite links
            and the client download point somewhere players can reach too.
          </li>
          <li>
            Forward/allow TCP <span className="mono">3724</span> (login),{" "}
            <span className="mono">8085</span> (world),{" "}
            <span className="mono">8080</span> (website), and{" "}
            <span className="mono">8081</span> (downloads).
          </li>
        </ul>
      </div>

      <div className="card">
        <h2>Exposing via ZeroTier or Cloudflare Tunnels</h2>
        <p className="muted">
          If you do not want to forward ports on your router, you can expose the stack using ZeroTier or a Cloudflare Tunnel:
        </p>
        <ul className="muted">
          <li>
            <strong>ZeroTier (Full Virtual LAN):</strong> Join a network with{" "}
            <span className="mono">task zerotier:join NETWORK=&lt;id&gt;</span>. Set <em>Address</em> above to your host&apos;s ZeroTier IP so players on the same ZeroTier network can reach the game server and website directly.
          </li>
          <li>
            <strong>Cloudflare Tunnel (Web & Downloads):</strong> Proxy HTTP/HTTPS traffic through Cloudflare with{" "}
            <span className="mono">task cloudflare:token TOKEN=&lt;token&gt;</span>. Route your Cloudflare hostname in Cloudflare Zero Trust to <span className="mono">http://ac-webapp:3000</span> (portal) and <span className="mono">http://ac-downloads:80</span> (downloads).
          </li>
        </ul>
      </div>


      <div className="card">
        <h2>What players set</h2>
        <p className="muted">
          In their 3.3.5a client, players edit{" "}
          <span className="mono">Data/enUS/realmlist.wtf</span> (or their locale
          folder) so it contains exactly one line:
        </p>
        <pre className="snippet mono">
          {`set realmlist ${
            realms[0] && !realms[0].localOnly
              ? realms[0].address
              : "YOUR.LAN.OR.PUBLIC.IP"
          }`}
        </pre>
        <p className="muted">
          That points the client at the <em>login</em> server on port 3724. The
          address above is only what the login server then redirects them to for
          the world server — the two are set separately and both have to be
          reachable.
        </p>
      </div>
    </>
  );
}
