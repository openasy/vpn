import { Button, PageHeader, Panel, type Column } from "@openasy/ui";
import { useAuth } from "@openasy/auth/react";
import { Unplug } from "lucide-react";
import type { Session } from "./api.ts";
import { useT } from "./i18n.ts";
import { ago, bytes, List, Problem, useAction, useData, type Call } from "./shared.tsx";

/** Live sessions, with ending one. `personId` limits them to one person's devices. */
export function SessionTable({ call, personId }: { call: Call; personId?: string }) {
  const { can } = useAuth();
  const t = useT();
  const { data, reload } = useData<{ sessions: Session[] }>(call, "/api/v1/sessions", 10_000);
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

export function SessionsPage({ call }: { call: Call }) {
  const t = useT();
  return (
    <>
      <PageHeader title={t("sessions.title")} description={t("sessions.description")} />
      <Panel flush>
        <SessionTable call={call} />
      </Panel>
    </>
  );
}
