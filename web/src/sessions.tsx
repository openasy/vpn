import { BarList, Button, PageHeader, Panel, type Column } from "@openasy/ui";
import { useAuth } from "@openasy/auth/react";
import { Unplug } from "lucide-react";
import type { Session } from "./api.ts";
import { useT } from "./i18n.ts";
import { ago, bytes, List, Problem, useAction, useData, type Call } from "./shared.tsx";

type Sessions = { data?: { sessions: Session[] }; reload: () => void };

/** Live sessions, with ending one. `personId` limits them to one person's devices; `sessions` are read already. */
export function SessionTable({ call, personId, sessions }: { call: Call; personId?: string; sessions?: Sessions }) {
  const { can } = useAuth();
  const t = useT();
  const own = useData<{ sessions: Session[] }>(call, sessions ? null : "/api/v1/sessions", 10_000);
  const { data, reload } = sessions ?? own;
  const end = useAction();
  const rows = data?.sessions.filter((s) => !personId || s.personId === personId);
  const columns: Column<Session>[] = [
    ...(personId
      ? []
      : [
          {
            id: "person",
            header: t("sessions.person"),
            cell: (s: Session) => (s.personId ? <a href={`/people/${s.personId}`}>{s.personName}</a> : t("sessions.unknownDevice")),
            sortValue: (s: Session) => s.personName ?? "",
          } satisfies Column<Session>,
        ]),
    { id: "device", header: t("common.device"), cell: (s) => s.deviceName ?? s.deviceId, sortValue: (s) => s.deviceName ?? "" },
    { id: "vpnIp", header: t("common.vpnAddress"), width: "120px", mono: true, cell: (s) => s.vpnIp },
    { id: "from", header: t("sessions.from"), width: "170px", mono: true, cell: (s) => s.realAddress },
    { id: "server", header: t("common.server"), width: "120px", cell: (s) => s.serverId },
    {
      id: "since",
      header: t("sessions.connected"),
      width: "110px",
      cell: (s) => <span title={new Date(s.connectedAt).toLocaleString()}>{ago(t, s.connectedAt)}</span>,
      sortValue: (s) => s.connectedAt,
    },
    {
      id: "traffic",
      header: t("sessions.traffic"),
      width: "140px",
      align: "right",
      mono: true,
      cell: (s) => `${bytes(s.bytesIn)} / ${bytes(s.bytesOut)}`,
      sortValue: (s) => s.bytesIn + s.bytesOut,
    },
    ...(can("editor")
      ? [
          {
            id: "end",
            header: "",
            width: "90px",
            cell: (s: Session) => (
              <Button
                size="xs"
                variant="ghost"
                icon={<Unplug />}
                onClick={() =>
                  void end
                    .run(() => call(`/api/v1/sessions/${encodeURIComponent(s.serverId)}/${encodeURIComponent(s.deviceId)}`, { method: "DELETE" }))
                    .then(reload)
                }
              >
                {t("sessions.end")}
              </Button>
            ),
          } satisfies Column<Session>,
        ]
      : []),
  ];
  return (
    <>
      <Problem error={end.error} title={t("sessions.notEnded")} />
      <List label={t("sessions.live")} rows={rows} columns={columns} empty={t("sessions.nobody")} getRowId={(s) => `${s.serverId}/${s.deviceId}`} />
    </>
  );
}

/** The largest totals first, eight at most. */
function largest(totals: Map<string, { label: string; value: number; href?: string }>) {
  return [...totals]
    .map(([id, x]) => ({ id, ...x }))
    .sort((a, b) => b.value - a.value)
    .slice(0, 8);
}

export function SessionsPage({ call }: { call: Call }) {
  const t = useT();
  const sessions = useData<{ sessions: Session[] }>(call, "/api/v1/sessions", 10_000);
  const live = sessions.data?.sessions ?? [];
  const traffic = new Map<string, { label: string; value: number; href?: string }>();
  const servers = new Map<string, { label: string; value: number }>();
  for (const s of live) {
    const id = s.personId ?? `device:${s.deviceId}`;
    const p = traffic.get(id) ?? {
      label: s.personName ?? s.deviceName ?? t("sessions.unknownDevice"),
      value: 0,
      ...(s.personId && { href: `/people/${s.personId}` }),
    };
    traffic.set(id, { ...p, value: p.value + s.bytesIn + s.bytesOut });
    servers.set(s.serverId, { label: s.serverId, value: (servers.get(s.serverId)?.value ?? 0) + 1 });
  }
  return (
    <>
      <PageHeader title={t("sessions.title")} description={t("sessions.description")} />
      {live.length > 0 && (
        <div className="grid gap-3 lg:grid-cols-2">
          <Panel title={t("sessions.trafficByPerson")} description={t("sessions.inAndOutSinceTheyConnected")}>
            <BarList label={t("sessions.trafficByPerson")} items={largest(traffic)} format={bytes} />
          </Panel>
          <Panel title={t("sessions.sessionsByServer")} description={t("sessions.connectedNowToEachServer")}>
            <BarList label={t("sessions.sessionsByServer")} items={largest(servers)} />
          </Panel>
        </div>
      )}
      <Panel flush>
        <SessionTable call={call} sessions={sessions} />
      </Panel>
    </>
  );
}
