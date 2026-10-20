import { EmptyState, KpiCard, KpiGrid, PageHeader, Panel, StatusBadge, type Column } from "@openasy/ui";
import type { Server } from "./api.ts";
import { ago, List, useData, type Call } from "./shared.tsx";

/** A server that has not sent a heartbeat for this long is shown as offline; it sends one every 15 seconds. */
const OFFLINE_MS = 60_000;

function state(s: Server, version?: string): { tone: "success" | "warning" | "danger"; label: string } {
  if (Date.now() - Date.parse(s.lastSeen) > OFFLINE_MS) return { tone: "danger", label: "Offline" };
  if (version && s.version !== version) return { tone: "danger", label: "Other version" };
  if (!s.openvpnRunning) return { tone: "danger", label: "OpenVPN stopped" };
  if (!s.configVersion) return { tone: "warning", label: "No config applied" };
  return { tone: "success", label: "Running" };
}

export function ServersPage({ call, version }: { call: Call; version?: string }) {
  const { data } = useData<{ servers: Server[] }>(call, "/api/v1/servers", 10_000);
  const servers = data?.servers;
  const up = (servers ?? []).filter((s) => state(s, version).tone === "success").length;
  const columns: Column<Server>[] = [
    { id: "id", header: "Server", cell: (s) => s.id, sortValue: (s) => s.id },
    { id: "state", header: "State", width: "170px", cell: (s) => <StatusBadge tone={state(s, version).tone}>{state(s, version).label}</StatusBadge> },
    { id: "listen", header: "Listens on", width: "120px", mono: true, cell: (s) => s.listen ?? "udp/1194" },
    { id: "version", header: "Version", width: "100px", mono: true, cell: (s) => s.version },
    { id: "config", header: "Config", width: "170px", mono: true, cell: (s) => s.configVersion ?? "not applied" },
    { id: "seen", header: "Last heartbeat", width: "130px", cell: (s) => <span title={new Date(s.lastSeen).toLocaleString()}>{ago(s.lastSeen)}</span>, sortValue: (s) => s.lastSeen },
  ];
  return (
    <>
      <PageHeader
        title="Servers"
        description={`vpn-server runs OpenVPN on the hosts clients connect to, pulls its config from here and reports every 15 seconds. It must have the same version as this VPN${version ? ` (${version})` : ""}.`}
      />
      <KpiGrid>
        <KpiCard label="Servers" value={servers?.length ?? "–"} />
        <KpiCard label="Running" value={servers ? up : "–"} tone={servers && up < servers.length ? "warning" : "success"} />
      </KpiGrid>
      {servers?.length === 0 ? (
        <EmptyState title="No servers yet">Start vpn-server with VPN_URL and VPN_SERVER_TOKEN pointing here; it shows up within 15 seconds.</EmptyState>
      ) : (
        <Panel flush>
          <List label="Servers" rows={servers} columns={columns} empty="No servers yet" getRowId={(s) => s.id} />
        </Panel>
      )}
    </>
  );
}
