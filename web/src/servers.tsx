import { Badge, Button, Callout, EmptyState, KpiCard, KpiGrid, PageHeader, Panel, StatusBadge, TextField, type Column } from "@openasy/ui";
import { useAuth } from "@openasy/auth/react";
import { Pencil, Plus, RotateCw, Trash2 } from "lucide-react";
import { useState, type FormEvent } from "react";
import type { NewServer, Server } from "./api.ts";
import { ago, Code, List, Problem, useAction, useData, type Call } from "./shared.tsx";

function state(s: Server): { tone: "success" | "warning" | "danger" | "info"; label: string } {
  if (s.status === "waiting-to-enrol") return { tone: "info", label: "Waiting to enrol" };
  if (s.status === "offline") return { tone: "danger", label: "Offline" };
  if (s.status === "version-mismatch") return { tone: "danger", label: "Other version" };
  if (!s.openvpnRunning) return { tone: "danger", label: "OpenVPN stopped" };
  if (!s.configVersion) return { tone: "warning", label: "No config applied" };
  return { tone: "success", label: "Running" };
}

/** How to start vpn-server with its one-time token, next to this VPN or on another host. */
function EnrollCommand({ added, version, onDone }: { added: NewServer; version?: string; onDone: () => void }) {
  const here = window.location.origin;
  const { id } = added.server;
  return (
    <Callout
      tone="warning"
      title={`Start ${id} with this one-time token`}
      action={
        <Button size="sm" onClick={onDone}>
          Done
        </Button>
      }
    >
      <span className="flex flex-col gap-2">
        <span>It works once, until {new Date(added.enrollExpiresAt).toLocaleString()}, and is not shown again. On the host clients connect to{added.server.address ? ` (${added.server.address})` : ""}:</span>
        <Code label={`Start ${id}`}>
          {`docker run -d --name vpn-server --restart unless-stopped \\
  --cap-add NET_ADMIN --device /dev/net/tun --sysctl net.ipv4.ip_forward=1 \\
  -p 1194:1194/udp -v vpn-server-data:/var/lib/openasy-vpn \\
  -e VPN_URL=${here} -e VPN_ENROLL_TOKEN=${added.enrollToken} \\
  ghcr.io/openasy/vpn-server:${version ?? "<the version of this VPN>"}`}
        </Code>
        <span>
          Keep the volume: the server's secret is in it. For TCP 443, add <code>-p 443:443/tcp -e OPENVPN_PROTO=tcp -e OPENVPN_PORT=443</code> instead of the UDP port. Next to this VPN with its compose file, set the token in the server's
          variable, for example <code>EDGE_1_TOKEN=…&nbsp;docker compose up -d</code>.
        </span>
        <span>Client configs list a server once it has reported. Devices added before that do not know it; they keep using the servers they have.</span>
      </span>
    </Callout>
  );
}

export function ServersPage({ call, version }: { call: Call; version?: string }) {
  const { can } = useAuth();
  const { data, reload } = useData<{ servers: Server[] }>(call, "/api/v1/servers", 10_000);
  const servers = data?.servers;
  const up = (servers ?? []).filter((s) => state(s).tone === "success").length;
  const [id, setId] = useState("");
  const [address, setAddress] = useState("");
  const [added, setAdded] = useState<NewServer>();
  const action = useAction();

  const add = async (e: FormEvent) => {
    e.preventDefault();
    await action.run(async () => {
      setAdded(await call<NewServer>("/api/v1/servers", { method: "POST", body: JSON.stringify({ id, address: address || null }) }));
      setId("");
      setAddress("");
      reload();
    });
  };
  const editAddress = (s: Server) => {
    const next = window.prompt(`Address clients connect to for ${s.id}. Leave empty to use VPN_PUBLIC_HOST. Client configs made before keep the old address.`, s.address ?? "");
    if (next !== null) void action.run(() => call(`/api/v1/servers/${s.id}`, { method: "PATCH", body: JSON.stringify({ address: next.trim() || null }) }).then(reload));
  };
  const enrollAgain = (s: Server) =>
    window.confirm(
      s.legacy
        ? `Enrol ${s.id} with its own secret? VPN_SERVER_TOKEN stops working for it now: start it again with the token you get next.`
        : `Enrol ${s.id} again? Its secret stops working now, and it gets a new certificate once you start it with the new token.`,
    ) && void action.run(async () => (setAdded(await call<NewServer>(`/api/v1/servers/${s.id}/enroll-token`, { method: "POST" })), reload()));
  const remove = (s: Server) =>
    window.confirm(`Remove ${s.id}? It stops getting its config and its sessions end. Client configs that list it skip to the next server.`) &&
    void action.run(() => call(`/api/v1/servers/${s.id}`, { method: "DELETE" }).then(reload));

  const columns: Column<Server>[] = [
    {
      id: "id",
      header: "Server",
      cell: (s) => (
        <span className="flex items-center gap-2">
          {s.id}
          {s.legacy && (
            <Badge tone="warning" title="Uses the shared VPN_SERVER_TOKEN. Enrol it to give it its own secret.">
              Legacy
            </Badge>
          )}
        </span>
      ),
      sortValue: (s) => s.id,
    },
    { id: "state", header: "State", width: "170px", cell: (s) => <StatusBadge tone={state(s).tone}>{state(s).label}</StatusBadge> },
    { id: "address", header: "Address", mono: true, cell: (s) => s.address ?? <span title="VPN_PUBLIC_HOST">default</span>, sortValue: (s) => s.address ?? "" },
    { id: "listen", header: "Listens on", width: "110px", mono: true, cell: (s) => s.listen ?? (s.lastSeen ? "udp/1194" : "–") },
    { id: "version", header: "Version", width: "90px", mono: true, cell: (s) => s.version ?? "–" },
    { id: "config", header: "Config", width: "170px", mono: true, cell: (s) => s.configVersion ?? "not applied" },
    { id: "seen", header: "Last heartbeat", width: "130px", cell: (s) => <span title={s.lastSeen ? new Date(s.lastSeen).toLocaleString() : undefined}>{ago(s.lastSeen)}</span>, sortValue: (s) => s.lastSeen ?? "" },
    ...(can("admin")
      ? [
          {
            id: "actions",
            header: "",
            width: "300px",
            cell: (s: Server) => (
              <span className="flex gap-1">
                <Button size="xs" variant="ghost" icon={<Pencil />} onClick={() => editAddress(s)}>
                  Address
                </Button>
                <Button size="xs" variant="ghost" icon={<RotateCw />} onClick={() => enrollAgain(s)}>
                  {s.legacy ? "Enrol" : "Enrol again"}
                </Button>
                <Button size="xs" variant="ghost" icon={<Trash2 />} onClick={() => remove(s)}>
                  Remove
                </Button>
              </span>
            ),
          } satisfies Column<Server>,
        ]
      : []),
  ];
  return (
    <>
      <PageHeader
        title="Servers"
        description={`vpn-server runs OpenVPN on the hosts clients connect to, here or at other locations. Each pulls its config from here and reports every 15 seconds; client configs list every server, so clients move to the next one when one is down. It must have the same version as this VPN${version ? ` (${version})` : ""}.`}
      />
      <KpiGrid>
        <KpiCard label="Servers" value={servers?.length ?? "–"} />
        <KpiCard label="Running" value={servers ? up : "–"} tone={servers && up < servers.length ? "warning" : "success"} />
      </KpiGrid>
      {can("admin") && (
        <Panel title="Add a server" description="Its address is the host name or IP clients connect to; leave it empty to use VPN_PUBLIC_HOST.">
          <form onSubmit={add} className="flex flex-wrap items-end gap-2">
            <TextField label="Name" value={id} onChange={(e) => setId(e.target.value.toLowerCase())} placeholder="fra-1" />
            <TextField label="Address" value={address} onChange={(e) => setAddress(e.target.value)} placeholder="fra.vpn.example.com" />
            <Button type="submit" variant="primary" icon={<Plus />} loading={action.busy} disabled={!id}>
              Add server
            </Button>
          </form>
        </Panel>
      )}
      <Problem error={action.error} />
      {added && <EnrollCommand added={added} version={version} onDone={() => setAdded(undefined)} />}
      {servers?.length === 0 ? (
        <EmptyState title="No servers yet">Add one above, then start vpn-server with its token; it shows up within 15 seconds.</EmptyState>
      ) : (
        <Panel flush>
          <List label="Servers" rows={servers} columns={columns} empty="No servers yet" getRowId={(s) => s.id} />
        </Panel>
      )}
    </>
  );
}
