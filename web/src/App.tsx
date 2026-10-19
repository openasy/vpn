import { AppShell, BrandProvider, EmptyState, KpiCard, KpiGrid, PageHeader, Panel } from "@openasy/ui";
import { useEffect, useState } from "react";

interface Server {
  id: string;
  version: string;
  listen: string | null;
  openvpnRunning: boolean;
  lastSeen: string;
}

// The UI is an ordinary client of the public API (ADR 0014, 0018).
async function get<T>(path: string): Promise<T> {
  const res = await fetch(path);
  if (!res.ok) throw new Error(`${path}: ${res.status}`);
  return res.json() as Promise<T>;
}

export function App() {
  const [version, setVersion] = useState<string>();
  const [servers, setServers] = useState<Server[]>([]);

  useEffect(() => {
    get<{ version: string }>("/api/v1/version").then((v) => setVersion(v.version));
    const load = () => get<{ servers: Server[] }>("/api/v1/servers").then((r) => setServers(r.servers));
    load();
    const timer = setInterval(load, 10_000);
    return () => clearInterval(timer);
  }, []);

  const running = servers.filter((s) => s.openvpnRunning).length;

  return (
    <BrandProvider>
      <AppShell product="vpn" nav={[{ id: "servers", label: "Servers" }]} activeNav="servers">
        <PageHeader title="Servers" description={version ? `vpn-manager ${version}` : undefined} />
        <KpiGrid>
          <KpiCard label="Servers" value={servers.length} />
          <KpiCard label="OpenVPN running" value={running} tone={running < servers.length ? "warning" : "success"} />
        </KpiGrid>
        <Panel title="Connected servers">
          {servers.length === 0 ? (
            <EmptyState title="No servers yet">Start vpn-server with VPN_MANAGER_URL and VPN_SERVER_TOKEN pointing here.</EmptyState>
          ) : (
            <ul>
              {servers.map((s) => (
                <li key={s.id}>
                  {s.id} · {s.listen ?? "port from config"} · {s.version} · {s.openvpnRunning ? "running" : "stopped"} · last seen {new Date(s.lastSeen).toLocaleString()}
                </li>
              ))}
            </ul>
          )}
        </Panel>
      </AppShell>
    </BrandProvider>
  );
}
