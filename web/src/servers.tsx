import { Badge, Button, Callout, Dialog, EmptyState, KpiCard, KpiGrid, PageHeader, Panel, StatusBadge, TextField, type Column } from "@openasy/ui";
import { useAuth } from "@openasy/auth/react";
import { Check, Pencil, Plus, RotateCw, Trash2 } from "lucide-react";
import { useState, type FormEvent } from "react";
import type { NewServer, Server } from "./api.ts";
import { useT, type T } from "./i18n.ts";
import { ago, Code, List, Problem, useAction, useData, type Call } from "./shared.tsx";

function state(t: T, s: Server): { tone: "success" | "warning" | "danger" | "info"; label: string } {
  if (s.status === "waiting-to-enrol") return { tone: "info", label: t("servers.waiting") };
  if (s.status === "offline") return { tone: "danger", label: t("servers.offline") };
  if (s.status === "version-mismatch") return { tone: "danger", label: t("servers.otherVersion") };
  if (!s.openvpnRunning) return { tone: "danger", label: t("servers.openvpnStopped") };
  if (!s.configVersion) return { tone: "warning", label: t("servers.noConfig") };
  return { tone: "success", label: t("servers.running") };
}

/** How to start vpn-server with its one-time token, next to this VPN or on another host. */
function EnrollCommand({ added, version, onDone }: { added: NewServer; version?: string; onDone: () => void }) {
  const t = useT();
  const here = window.location.origin;
  const { id } = added.server;
  return (
    <Dialog
      open
      onOpenChange={(open) => !open && onDone()}
      size="lg"
      icon={<Check aria-hidden className="size-4" />}
      iconTone="success"
      title={t("servers.startTitle", { id })}
      description={t("servers.worksOnce", { date: new Date(added.enrollExpiresAt).toLocaleString() })}
      footer={
        <Button variant="primary" onClick={onDone}>
          {t("common.done")}
        </Button>
      }
    >
      <span className="flex flex-col gap-2">
        <span>{added.server.address ? t("servers.onHostAt", { address: added.server.address }) : t("servers.onHost")}</span>
        <Code label={t("servers.startLabel", { id })}>
          {`docker run -d --name vpn-server --restart unless-stopped \\
  --cap-add NET_ADMIN --device /dev/net/tun --sysctl net.ipv4.ip_forward=1 \\
  -p 1194:1194/udp -v vpn-server-data:/var/lib/openasy-vpn \\
  -e VPN_URL=${here} -e VPN_ENROLL_TOKEN=${added.enrollToken} \\
  ghcr.io/openasy/vpn-server:${version ?? t("servers.thisVersion")}`}
        </Code>
        <span>
          {t("servers.keepVolume")} <code>-p 443:443/tcp -e OPENVPN_PROTO=tcp -e OPENVPN_PORT=443</code> {t("servers.insteadOfUdp")} <code>EDGE_1_TOKEN=…&nbsp;docker compose up -d</code>.
        </span>
        <span>{t("servers.clientConfigs")}</span>
      </span>
      <Callout tone="warning" title={t("servers.closingHides")}>
        {t("servers.closingHidesBody")}
      </Callout>
    </Dialog>
  );
}

export function ServersPage({ call, version }: { call: Call; version?: string }) {
  const { can } = useAuth();
  const t = useT();
  const { data, reload } = useData<{ servers: Server[] }>(call, "/api/v1/servers", 10_000);
  const servers = data?.servers;
  const up = (servers ?? []).filter((s) => state(t, s).tone === "success").length;
  const [id, setId] = useState("");
  const [address, setAddress] = useState("");
  const [added, setAdded] = useState<NewServer>();
  const [adding, setAdding] = useState(false);
  const action = useAction();
  const close = () => (setAdding(false), setId(""), setAddress(""), action.clear());

  const add = async (e: FormEvent) => {
    e.preventDefault();
    await action.run(async () => {
      const r = await call<NewServer>("/api/v1/servers", { method: "POST", body: JSON.stringify({ id, address: address || null }) });
      close();
      setAdded(r);
      reload();
    });
  };
  const editAddress = (s: Server) => {
    const next = window.prompt(t("servers.promptAddress", { id: s.id }), s.address ?? "");
    if (next !== null) void action.run(() => call(`/api/v1/servers/${s.id}`, { method: "PATCH", body: JSON.stringify({ address: next.trim() || null }) }).then(reload));
  };
  const enrollAgain = (s: Server) =>
    window.confirm(
      s.legacy
        ? t("servers.confirmEnrolLegacy", { id: s.id })
        : t("servers.confirmEnrolAgain", { id: s.id }),
    ) && void action.run(async () => (setAdded(await call<NewServer>(`/api/v1/servers/${s.id}/enroll-token`, { method: "POST" })), reload()));
  const remove = (s: Server) =>
    window.confirm(t("servers.confirmRemove", { id: s.id })) &&
    void action.run(() => call(`/api/v1/servers/${s.id}`, { method: "DELETE" }).then(reload));

  const columns: Column<Server>[] = [
    {
      id: "id",
      header: t("common.server"),
      cell: (s) => (
        <span className="flex items-center gap-2">
          {s.id}
          {s.legacy && (
            <Badge tone="warning" title={t("servers.legacyTitle")}>
              {t("servers.legacy")}
            </Badge>
          )}
        </span>
      ),
      sortValue: (s) => s.id,
    },
    { id: "state", header: t("servers.state"), width: "170px", cell: (s) => <StatusBadge tone={state(t, s).tone}>{state(t, s).label}</StatusBadge> },
    { id: "address", header: t("common.address"), mono: true, cell: (s) => s.address ?? <span title="VPN_PUBLIC_HOST">{t("servers.default")}</span>, sortValue: (s) => s.address ?? "" },
    { id: "listen", header: t("servers.listensOn"), width: "110px", mono: true, cell: (s) => s.listen ?? (s.lastSeen ? "udp/1194" : "–") },
    { id: "version", header: t("servers.version"), width: "90px", mono: true, cell: (s) => s.version ?? "–" },
    { id: "config", header: t("servers.config"), width: "170px", mono: true, cell: (s) => s.configVersion ?? t("servers.notApplied") },
    { id: "seen", header: t("servers.lastHeartbeat"), width: "130px", cell: (s) => <span title={s.lastSeen ? new Date(s.lastSeen).toLocaleString() : undefined}>{ago(t, s.lastSeen)}</span>, sortValue: (s) => s.lastSeen ?? "" },
    ...(can("admin")
      ? [
          {
            id: "actions",
            header: "",
            width: "300px",
            cell: (s: Server) => (
              <span className="flex gap-1">
                <Button size="xs" variant="ghost" icon={<Pencil />} onClick={() => editAddress(s)}>
                  {t("common.address")}
                </Button>
                <Button size="xs" variant="ghost" icon={<RotateCw />} onClick={() => enrollAgain(s)}>
                  {s.legacy ? t("servers.enrol") : t("servers.enrolAgain")}
                </Button>
                <Button size="xs" variant="ghost" icon={<Trash2 />} onClick={() => remove(s)}>
                  {t("common.remove")}
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
        title={t("servers.title")}
        description={version ? `${t("servers.description")} ${t("servers.sameVersion", { version })}` : t("servers.description")}
        actions={
          can("admin") && (
            <Button variant="primary" icon={<Plus />} onClick={() => setAdding(true)}>
              {t("servers.add")}
            </Button>
          )
        }
      />
      <KpiGrid>
        <KpiCard label={t("servers.title")} value={servers?.length ?? "–"} />
        <KpiCard label={t("servers.running")} value={servers ? up : "–"} tone={servers && up < servers.length ? "warning" : "success"} />
      </KpiGrid>
      <Dialog
        open={adding}
        onOpenChange={(open) => !open && close()}
        title={t("servers.addTitle")}
        description={t("servers.addBody")}
        onSubmit={add}
        footer={
          <>
            <Button type="button" onClick={close}>
              {t("common.cancel")}
            </Button>
            <Button type="submit" variant="primary" loading={action.busy} disabled={!id}>
              {t("servers.add")}
            </Button>
          </>
        }
      >
        <Problem error={action.error} title={t("common.notAdded")} />
        <TextField label={t("common.name")} value={id} onChange={(e) => setId(e.target.value.toLowerCase())} placeholder="fra-1" />
        <TextField label={t("common.address")} value={address} onChange={(e) => setAddress(e.target.value)} placeholder="fra.vpn.example.com" />
      </Dialog>
      {!adding && <Problem error={action.error} />}
      {added && <EnrollCommand added={added} version={version} onDone={() => setAdded(undefined)} />}
      {servers?.length === 0 ? (
        <EmptyState title={t("servers.noneYet")}>{t("servers.noneYetBody")}</EmptyState>
      ) : (
        <Panel flush>
          <List label={t("servers.title")} rows={servers} columns={columns} empty={t("servers.noneYet")} getRowId={(s) => s.id} />
        </Panel>
      )}
    </>
  );
}
