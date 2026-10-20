import { Button, PageHeader, Panel, type Column } from "@openasy/ui";
import { useAuth } from "@openasy/auth/react";
import { Unplug } from "lucide-react";
import type { Session } from "./api.ts";
import { ago, bytes, List, Problem, useAction, useData, type Call } from "./shared.tsx";

/** Live sessions, with ending one. `personId` limits them to one person's devices. */
export function SessionTable({ call, personId }: { call: Call; personId?: string }) {
  const { can } = useAuth();
  const { data, reload } = useData<{ sessions: Session[] }>(call, "/api/v1/sessions", 10_000);
  const end = useAction();
  const rows = data?.sessions.filter((s) => !personId || s.personId === personId);
  const columns: Column<Session>[] = [
    ...(personId
      ? []
      : [{ id: "person", header: "Person", cell: (s: Session) => (s.personId ? <a href={`#/people/${s.personId}`}>{s.personName}</a> : "Unknown device"), sortValue: (s: Session) => s.personName ?? "" } satisfies Column<Session>]),
    { id: "device", header: "Device", cell: (s) => s.deviceName ?? s.deviceId, sortValue: (s) => s.deviceName ?? "" },
    { id: "vpnIp", header: "VPN address", width: "120px", mono: true, cell: (s) => s.vpnIp },
    { id: "from", header: "From", width: "170px", mono: true, cell: (s) => s.realAddress },
    { id: "server", header: "Server", width: "120px", cell: (s) => s.serverId },
    { id: "since", header: "Connected", width: "110px", cell: (s) => <span title={new Date(s.connectedAt).toLocaleString()}>{ago(s.connectedAt)}</span>, sortValue: (s) => s.connectedAt },
    { id: "traffic", header: "In / out", width: "140px", align: "right", mono: true, cell: (s) => `${bytes(s.bytesIn)} / ${bytes(s.bytesOut)}`, sortValue: (s) => s.bytesIn + s.bytesOut },
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
                onClick={() => void end.run(() => call(`/api/v1/sessions/${encodeURIComponent(s.serverId)}/${encodeURIComponent(s.deviceId)}`, { method: "DELETE" })).then(reload)}
              >
                End
              </Button>
            ),
          } satisfies Column<Session>,
        ]
      : []),
  ];
  return (
    <>
      <Problem error={end.error} title="Not ended" />
      <List label="Live sessions" rows={rows} columns={columns} empty="Nobody is connected" getRowId={(s) => `${s.serverId}/${s.deviceId}`} />
    </>
  );
}

export function SessionsPage({ call }: { call: Call }) {
  return (
    <>
      <PageHeader
        title="Sessions"
        description="Devices connected now, as each server reports them every 15 seconds. Ending a session disconnects it at the next heartbeat; the device may connect again while it is allowed. To keep it out, revoke the device or suspend the person."
      />
      <Panel flush>
        <SessionTable call={call} />
      </Panel>
    </>
  );
}
